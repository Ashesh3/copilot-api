/* eslint-disable max-lines, complexity, max-lines-per-function, max-params, no-nested-ternary -- three dialect adapters share bounded protocol matrices */
import type {
  EvaluatedEndpointCandidate,
  ModelEndpointSupport,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type { ReasoningEffort } from "~/lib/model-suffix"
import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTool,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import { fetchUrlAsDataUri, isHttpUrl, parseDataUri } from "~/lib/attachments"
import { createEvaluatedTranslationCheck } from "~/lib/endpoint-routing"
import {
  getUnsupportedRequestParameters,
  modelSupportsAssistantPrefill,
} from "~/lib/model-settings"
import { addPromptCaching } from "~/services/copilot/copilot-client"
import {
  createHostedWebSearchTool,
  createWebSearchAnthropicTool,
  createWebSearchFunctionTool,
  isWebSearchToolType,
} from "~/services/copilot/mcp-web-search"

import type {
  PreparedChatCompletionsSource,
  PreparedChatMessage,
} from "./chat-contract"

export type NativeChatCandidate = EvaluatedEndpointCandidate<
  "/chat/completions",
  ChatCompletionsPayload
>
export interface ResponsesChatCandidate
  extends EvaluatedEndpointCandidate<"/responses", ResponsesPayload> {
  readonly webSearchMaxUses?: number
}
export type MessagesChatCandidate = EvaluatedEndpointCandidate<
  "/v1/messages",
  AnthropicMessagesPayload
>

export type ChatEndpointCandidate =
  | NativeChatCandidate
  | ResponsesChatCandidate
  | MessagesChatCandidate

export interface PreparedChatCandidates {
  readonly chat: NativeChatCandidate
  readonly messages: MessagesChatCandidate
  readonly responses: ResponsesChatCandidate
}

export interface SupportFilteredChatCandidates {
  readonly chat?: NativeChatCandidate
  readonly messages?: MessagesChatCandidate
  readonly responses?: ResponsesChatCandidate
}

interface CandidateContext {
  readonly attachmentCache: Map<
    string,
    Promise<Awaited<ReturnType<typeof fetchUrlAsDataUri>>>
  >
  readonly findings: Array<TranslationFinding>
  readonly pendingResultCallIds: Set<string>
  readonly reservedCallIds: Set<string>
  readonly usedCallIds: Set<string>
}

interface CandidateAttachmentCache {
  readonly values: Map<
    string,
    Promise<Awaited<ReturnType<typeof fetchUrlAsDataUri>>>
  >
}

interface NativeChatCandidateOptions {
  readonly attachmentCache?: CandidateAttachmentCache
  readonly applyCopilotSemantics?: boolean
  readonly signal?: AbortSignal
  readonly source: PreparedChatCompletionsSource
  readonly sourceFindings?: ReadonlyArray<TranslationFinding>
}

export interface PrepareChatCandidatesOptions {
  readonly nativeMessagesOptions: Record<string, unknown>
  readonly reasoningEffort?: ReasoningEffort
  readonly selectedModel: Model | undefined
  readonly signal?: AbortSignal
  readonly source: PreparedChatCompletionsSource
  readonly sourceFindings?: ReadonlyArray<TranslationFinding>
  readonly support?: ModelEndpointSupport
}

const FUTURE_ROLE_CONTEXT = "[Future role content]"
const UNKNOWN_CONTENT_CONTEXT = "[Unrepresentable content item]"
const ORPHAN_TOOL_RESULT_CONTEXT = "[Unpaired tool result]"
const UNSIGNED_REASONING_CONTEXT = "[Assistant reasoning context]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function addFinding(
  findings: Array<TranslationFinding>,
  finding: TranslationFinding,
): void {
  if (
    findings.some(
      (current) =>
        current.class === finding.class
        && current.severity === finding.severity,
    )
  ) {
    return
  }
  findings.push(finding)
}

function createContext(
  source: PreparedChatCompletionsSource,
  findings: ReadonlyArray<TranslationFinding> = [],
  attachmentCache: CandidateAttachmentCache = { values: new Map() },
): CandidateContext {
  const reservedCallIds = new Set<string>()
  for (const message of source.messages) {
    for (const toolCall of getToolCalls(message)) {
      if (typeof toolCall.id === "string" && toolCall.id.trim()) {
        reservedCallIds.add(toolCall.id)
      }
    }
    if (
      typeof message.tool_call_id === "string"
      && message.tool_call_id.trim()
    ) {
      reservedCallIds.add(message.tool_call_id)
    }
  }
  return {
    attachmentCache: attachmentCache.values,
    findings: findings.map((finding) => ({ ...finding })),
    pendingResultCallIds: new Set(),
    reservedCallIds,
    usedCallIds: new Set(),
  }
}

async function fetchCandidateAttachment(
  context: CandidateContext,
  url: string,
  signal: AbortSignal | undefined,
) {
  const cached = context.attachmentCache.get(url)
  if (cached) return await cached
  const pending = fetchUrlAsDataUri(url, { signal })
  context.attachmentCache.set(url, pending)
  return await pending
}

function createCallId(
  context: CandidateContext,
  messageIndex: number,
  callIndex: number,
  supplied: unknown,
): string {
  if (
    typeof supplied === "string"
    && supplied.trim()
    && !context.usedCallIds.has(supplied)
  ) {
    context.usedCallIds.add(supplied)
    context.pendingResultCallIds.add(supplied)
    return supplied
  }
  const base = `chat_call_${messageIndex}_${callIndex}`
  let generated = base
  let suffix = 0
  while (
    context.reservedCallIds.has(generated)
    || context.usedCallIds.has(generated)
  ) {
    suffix += 1
    generated = `${base}_${suffix}`
  }
  context.usedCallIds.add(generated)
  context.pendingResultCallIds.add(generated)
  addFinding(context.findings, {
    class: "tool_history",
    severity: "adapted",
  })
  return generated
}

function getFunctionRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value)
    || value.type !== "function"
    || !isRecord(value.function)
  ) {
    return undefined
  }
  if (typeof value.function.name !== "string" || !value.function.name.trim()) {
    return undefined
  }
  return value.function
}

function getToolCalls(
  message: PreparedChatMessage,
): Array<Record<string, unknown>> {
  return Array.isArray(message.tool_calls) ? message.tool_calls : []
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part]
      if (
        isRecord(part)
        && part.type === "text"
        && typeof part.text === "string"
      ) {
        return [part.text]
      }
      return []
    })
    .join("\n")
}

function hasMeaningfulMessages(messages: ReadonlyArray<unknown>): boolean {
  return messages.length > 0
}

function createCandidate<
  Endpoint extends ChatEndpointCandidate["endpoint"],
  Payload,
>(options: {
  endpoint: Endpoint
  findings: Array<TranslationFinding>
  meaningful: boolean
  payload: Payload
  reason: "endpoint_unavailable" | "payload_requirement"
}): EvaluatedEndpointCandidate<Endpoint, Payload> {
  const findings: Array<TranslationFinding> =
    options.meaningful ?
      options.findings
    : [{ class: "message_shape", severity: "fatal" }, ...options.findings]
  return {
    endpoint: options.endpoint,
    payload: options.payload,
    reason: options.reason,
    check: createEvaluatedTranslationCheck(findings),
  }
}

function rewriteAssistantPrefill(payload: ChatCompletionsPayload): void {
  if (modelSupportsAssistantPrefill(payload.model)) return
  const last = payload.messages.at(-1)
  if (!last || last.role !== "assistant") return
  payload.messages[payload.messages.length - 1] = {
    role: "user",
    content: last.content,
    ...(last.name ? { name: last.name } : {}),
  }
}

function normalizeNativeSchema(payload: ChatCompletionsPayload): void {
  if (payload.stream && !payload.stream_options) {
    payload.stream_options = { include_usage: true }
  }
  if (!isRecord(payload.response_format)) return
  const formatType = payload.response_format.type
  if (formatType !== "json_schema" && formatType !== "json_object") return
  const wrapper = payload.response_format.json_schema
  const schema = isRecord(wrapper) ? wrapper.schema : undefined
  if (formatType === "json_schema") {
    payload.response_format = { type: "json_object" }
  }
  let instruction =
    "IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation — just raw JSON."
  if (schema !== undefined) {
    instruction += `\nYou MUST conform to this JSON schema:\n${JSON.stringify(schema)}`
  }
  const system = payload.messages.find(
    (message) =>
      message.role === "system" && typeof message.content === "string",
  )
  if (system && typeof system.content === "string") {
    system.content = `${system.content}\n\n${instruction}`
  } else {
    payload.messages.unshift({ role: "system", content: instruction })
  }
}

function asContentPart(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && typeof value.type === "string" ? value : undefined
}

async function normalizeNativeAttachments(
  payload: ChatCompletionsPayload,
  signal: AbortSignal | undefined,
  attachmentCache: CandidateAttachmentCache,
): Promise<void> {
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue
    const parts: Array<Record<string, unknown>> = []
    for (const raw of message.content as Array<unknown>) {
      const part = asContentPart(raw)
      if (!part) continue
      if (
        part.type === "image_url"
        && isRecord(part.image_url)
        && typeof part.image_url.url === "string"
        && isHttpUrl(part.image_url.url)
      ) {
        const cached = attachmentCache.values.get(part.image_url.url)
        const pending =
          cached ?? fetchUrlAsDataUri(part.image_url.url, { signal })
        if (!cached) attachmentCache.values.set(part.image_url.url, pending)
        const inlined = await pending
        parts.push(
          inlined ?
            {
              ...part,
              image_url: {
                ...part.image_url,
                url: `data:${inlined.mediaType};base64,${inlined.data}`,
              },
            }
          : { type: "text", text: "[Image attachment unavailable]" },
        )
        continue
      }
      if (part.type === "file") {
        parts.push({ type: "text", text: "[File attachment unavailable]" })
        continue
      }
      parts.push(part)
    }
    message.content = parts as unknown as Message["content"]
  }
}

export async function prepareNativeChatCandidate(
  options: NativeChatCandidateOptions,
): Promise<NativeChatCandidate> {
  const payload = clone(options.source) as unknown as ChatCompletionsPayload
  const findings =
    options.sourceFindings?.map((finding) => ({ ...finding })) ?? []
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) =>
      isWebSearchToolType(tool) ? createWebSearchFunctionTool(tool) : tool,
    )
    if (
      payload.tools.some(
        (tool) =>
          isWebSearchToolType(tool)
          || (isRecord(tool.function) && tool.function.name === "web_search"),
      )
    ) {
      payload.parallel_tool_calls = false
    }
  }
  const attachmentCache = options.attachmentCache ?? { values: new Map() }
  if (options.applyCopilotSemantics !== false) {
    rewriteAssistantPrefill(payload)
    normalizeNativeSchema(payload)
    await normalizeNativeAttachments(payload, options.signal, attachmentCache)
    addPromptCaching(payload.messages, payload.tools ?? undefined)
  }
  return createCandidate({
    endpoint: "/chat/completions",
    payload,
    reason: "endpoint_unavailable",
    findings,
    meaningful: hasMeaningfulMessages(payload.messages),
  })
}

function convertResponseContent(
  content: unknown,
  role: "assistant" | "user",
  findings: Array<TranslationFinding>,
): string | Array<ResponseInputContent> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const output: Array<ResponseInputContent> = []
  for (const raw of content) {
    if (!isRecord(raw)) continue
    if (raw.type === "text" && typeof raw.text === "string") {
      output.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: raw.text,
      })
      continue
    }
    if (
      role === "user"
      && raw.type === "image_url"
      && isRecord(raw.image_url)
      && typeof raw.image_url.url === "string"
    ) {
      output.push({
        type: "input_image",
        image_url: raw.image_url.url,
        detail:
          raw.image_url.detail === "low" || raw.image_url.detail === "high" ?
            raw.image_url.detail
          : "auto",
      })
      continue
    }
    if (role === "user" && raw.type === "file" && isRecord(raw.file)) {
      output.push({
        type: "input_file",
        ...(typeof raw.file.filename === "string" ?
          { filename: raw.file.filename }
        : {}),
        ...(typeof raw.file.file_data === "string" ?
          { file_data: raw.file.file_data }
        : {}),
        ...(typeof raw.file.file_id === "string" ?
          { file_id: raw.file.file_id }
        : {}),
      })
      continue
    }
    addFinding(findings, { class: "content_part", severity: "adapted" })
    output.push({
      type: role === "assistant" ? "output_text" : "input_text",
      text: UNKNOWN_CONTENT_CONTEXT,
    })
  }
  return output.length > 0 ? output : ""
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value ?? {})
}

function convertResponsesTools(
  source: PreparedChatCompletionsSource,
  findings: Array<TranslationFinding>,
): ResponsesPayload["tools"] {
  const tools: Array<Record<string, unknown>> = []
  for (const tool of source.tools ?? []) {
    if (isWebSearchToolType(tool)) {
      const hosted = createHostedWebSearchTool(tool)
      if (hosted) {
        tools.push(hosted)
        continue
      }
      tools.push({
        ...createWebSearchFunctionTool(tool).function,
        type: "function",
        strict: false,
      })
      addFinding(findings, { class: "tool_shape", severity: "adapted" })
      continue
    }
    const definition = getFunctionRecord(tool)
    if (!definition) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    tools.push({
      type: "function",
      name: definition.name,
      description:
        typeof definition.description === "string" ?
          definition.description
        : null,
      parameters:
        isRecord(definition.parameters) ?
          clone(definition.parameters)
        : {
            type: "object",
            properties: {},
          },
      strict: false,
    })
  }
  return tools.length > 0 ? tools : null
}

function convertResponsesChoice(
  source: PreparedChatCompletionsSource,
  tools: ResponsesPayload["tools"],
  findings: Array<TranslationFinding>,
): ResponsesPayload["tool_choice"] | undefined {
  if (!tools?.length) return undefined
  const choice = source.tool_choice
  if (choice === "none" || choice === "auto" || choice === "required") {
    return choice
  }
  if (
    isRecord(choice)
    && choice.type === "function"
    && isRecord(choice.function)
    && typeof choice.function.name === "string"
  ) {
    return { type: "function", name: choice.function.name }
  }
  if (choice !== undefined && choice !== null) {
    addFinding(findings, { class: "tool_choice", severity: "adapted" })
  }
  return "auto"
}

function convertResponsesInput(
  source: PreparedChatCompletionsSource,
  context: CandidateContext,
): Array<ResponseInputItem> {
  const input: Array<ResponseInputItem> = []
  for (const [messageIndex, message] of source.messages.entries()) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentText(message.content)
      if (text) {
        input.push({ type: "message", role: message.role, content: text })
      }
      continue
    }
    if (message.role === "assistant") {
      if (
        typeof message.encrypted_content === "string"
        || typeof message.reasoning_text === "string"
      ) {
        input.push({
          type: "reasoning",
          summary:
            typeof message.reasoning_text === "string" ?
              [{ type: "summary_text", text: message.reasoning_text }]
            : [],
          ...(typeof message.encrypted_content === "string" ?
            { encrypted_content: message.encrypted_content }
          : {}),
          ...(typeof message.reasoning_opaque === "string" ?
            { id: message.reasoning_opaque }
          : {}),
        })
      }
      const content = convertResponseContent(
        message.content,
        "assistant",
        context.findings,
      )
      if (
        typeof content === "string" ? content.length > 0 : content.length > 0
      ) {
        input.push({ type: "message", role: "assistant", content })
      }
      for (const [callIndex, toolCall] of getToolCalls(message).entries()) {
        const definition = isRecord(toolCall.function) ? toolCall.function : {}
        const callId = createCallId(
          context,
          messageIndex,
          callIndex,
          toolCall.id,
        )
        input.push({
          type: "function_call",
          call_id: callId,
          name:
            typeof definition.name === "string" && definition.name.trim() ?
              definition.name
            : "unknown_function",
          arguments: stringifyArguments(definition.arguments),
          status: "completed",
        })
      }
      continue
    }
    if (message.role === "tool") {
      const supplied = message.tool_call_id
      if (
        typeof supplied === "string"
        && supplied.trim()
        && context.pendingResultCallIds.delete(supplied)
      ) {
        input.push({
          type: "function_call_output",
          call_id: supplied,
          output: contentText(message.content),
        })
      } else {
        addFinding(context.findings, {
          class: "tool_history",
          severity: "adapted",
        })
        input.push({
          type: "message",
          role: "user",
          content: `${ORPHAN_TOOL_RESULT_CONTEXT}\n${contentText(message.content)}`,
        })
      }
      continue
    }
    const future = message.role !== "user"
    if (future) {
      addFinding(context.findings, {
        class: "message_role",
        severity: "adapted",
      })
    }
    const content = convertResponseContent(
      message.content,
      "user",
      context.findings,
    )
    const prefixed =
      future ?
        typeof content === "string" ?
          `${FUTURE_ROLE_CONTEXT}\n${content}`
        : [{ type: "input_text", text: FUTURE_ROLE_CONTEXT }, ...content]
      : content
    input.push({ type: "message", role: "user", content: prefixed })
  }
  return input
}

function getInstructions(source: PreparedChatCompletionsSource): string | null {
  const text = source.messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join("\n\n")
  return text || null
}

function adaptChatToResponses(
  source: PreparedChatCompletionsSource,
  reasoningEffort: ReasoningEffort | undefined,
  sourceFindings: ReadonlyArray<TranslationFinding>,
): ResponsesChatCandidate {
  // eslint-disable-next-line @eslint-react/naming-convention/context-name -- protocol candidate state, not React context
  const candidateState = createContext(source, sourceFindings)
  const input = convertResponsesInput(clone(source), candidateState)
  const tools = convertResponsesTools(source, candidateState.findings)
  const instructions = getInstructions(source)
  const toolChoice = convertResponsesChoice(
    source,
    tools,
    candidateState.findings,
  )
  const payload: ResponsesPayload = {
    model: source.model,
    input,
    ...(instructions ? { instructions } : {}),
    store: false,
    stream: typeof source.stream === "boolean" ? source.stream : undefined,
    max_output_tokens:
      typeof source.max_completion_tokens === "number" ?
        source.max_completion_tokens
      : typeof source.max_tokens === "number" ? source.max_tokens
      : undefined,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(tools?.length ?
      {
        parallel_tool_calls:
          tools.some((tool) => isWebSearchToolType(tool)) ? false
          : typeof source.parallel_tool_calls === "boolean" ?
            source.parallel_tool_calls
          : undefined,
      }
    : {}),
    reasoning: {
      ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      summary: "auto",
    },
    include: ["reasoning.encrypted_content"],
  }
  if (
    source.max_completion_tokens !== undefined
    && source.max_tokens !== undefined
  ) {
    addFinding(candidateState.findings, {
      class: "token_alias",
      severity: "adapted",
    })
  }
  const unsupportedParameters = getUnsupportedRequestParameters(source.model)
  if (
    typeof source.temperature === "number"
    && !unsupportedParameters.includes("temperature")
  ) {
    payload.temperature = source.temperature
  }
  if (
    typeof source.top_p === "number"
    && !unsupportedParameters.includes("top_p")
  ) {
    payload.top_p = source.top_p
  }
  if (
    (source.temperature !== undefined && payload.temperature === undefined)
    || (source.top_p !== undefined && payload.top_p === undefined)
    || source.seed !== undefined
  ) {
    addFinding(candidateState.findings, {
      class: "sampling",
      severity: "omitted",
    })
  }
  if (isRecord(source.response_format)) {
    const type = source.response_format.type
    if (type === "json_object" || type === "json_schema") {
      payload.text = { format: { type: "json_object" } }
      let instruction =
        "IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation - just raw JSON."
      if (type === "json_schema") {
        const wrapper = source.response_format.json_schema
        const schema = isRecord(wrapper) ? wrapper.schema : wrapper
        if (schema !== undefined) {
          instruction += `\nYou MUST conform to this JSON schema:\n${JSON.stringify(schema)}`
        }
      }
      payload.instructions = [payload.instructions, instruction]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .join("\n\n")
      if (type === "json_schema") {
        addFinding(candidateState.findings, {
          class: "sampling",
          severity: "adapted",
        })
      }
    } else {
      addFinding(candidateState.findings, {
        class: "sampling",
        severity: "omitted",
      })
    }
  }
  if (Array.isArray(payload.tools)) {
    addPromptCaching([], payload.tools)
  }
  const candidate = createCandidate({
    endpoint: "/responses",
    payload,
    reason: "endpoint_unavailable",
    findings: candidateState.findings,
    meaningful: input.length > 0 || Boolean(payload.instructions),
  })
  const webSearchMaxUses = getChatWebSearchMaxUses(source)
  return {
    ...candidate,
    ...(webSearchMaxUses === undefined ? {} : { webSearchMaxUses }),
  }
}

function getChatWebSearchMaxUses(
  source: PreparedChatCompletionsSource,
): number | undefined {
  for (const tool of source.tools ?? []) {
    if (!isRecord(tool.function) || tool.function.name !== "web_search") {
      continue
    }
    const value = tool.function.max_uses
    if (Number.isInteger(value) && Number(value) > 0) return Number(value)
  }
  return undefined
}

function parseAnthropicArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      if (isRecord(parsed)) return parsed
    } catch {
      return { raw_arguments: value }
    }
    return { raw_arguments: value }
  }
  if (isRecord(value)) return { raw_arguments: clone(value) }
  return { raw_arguments: clone(value ?? null) }
}

async function convertAnthropicContent(
  content: unknown,
  context: CandidateContext,
  signal: AbortSignal | undefined,
): Promise<Array<AnthropicUserContentBlock>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: Array<AnthropicUserContentBlock> = []
  for (const raw of content) {
    if (!isRecord(raw)) continue
    if (raw.type === "text" && typeof raw.text === "string") {
      blocks.push({ type: "text", text: raw.text })
      continue
    }
    if (
      raw.type === "image_url"
      && isRecord(raw.image_url)
      && typeof raw.image_url.url === "string"
    ) {
      let parsed = parseDataUri(raw.image_url.url)
      if (!parsed && isHttpUrl(raw.image_url.url)) {
        parsed = await fetchCandidateAttachment(
          context,
          raw.image_url.url,
          signal,
        )
      }
      if (
        parsed
        && ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
          parsed.mediaType,
        )
      ) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: parsed.data,
          },
        })
      } else {
        addFinding(context.findings, {
          class: "attachment",
          severity: "omitted",
        })
      }
      continue
    }
    if (raw.type === "file" && isRecord(raw.file)) {
      const parsed =
        typeof raw.file.file_data === "string" ?
          parseDataUri(raw.file.file_data)
        : null
      if (parsed) {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
          },
          ...(typeof raw.file.filename === "string" ?
            { title: raw.file.filename }
          : {}),
        })
      } else {
        addFinding(context.findings, {
          class: "attachment",
          severity: "omitted",
        })
      }
      continue
    }
    if (raw.type === "document" && isRecord(raw.source)) {
      blocks.push(clone(raw) as AnthropicUserContentBlock)
      continue
    }
    addFinding(context.findings, {
      class: "content_part",
      severity: "adapted",
    })
    blocks.push({ type: "text", text: UNKNOWN_CONTENT_CONTEXT })
  }
  return blocks
}

function convertAnthropicTools(
  source: PreparedChatCompletionsSource,
  findings: Array<TranslationFinding>,
): Array<AnthropicTool> | undefined {
  const tools: Array<AnthropicTool> = []
  for (const tool of source.tools ?? []) {
    if (isWebSearchToolType(tool)) {
      tools.push(createWebSearchAnthropicTool(tool))
      continue
    }
    const definition = getFunctionRecord(tool)
    if (!definition) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    tools.push({
      name: definition.name as string,
      ...(typeof definition.description === "string" ?
        { description: definition.description }
      : {}),
      input_schema:
        isRecord(definition.parameters) ?
          clone(definition.parameters)
        : {
            type: "object",
            properties: {},
          },
    })
  }
  return tools.length > 0 ? tools : undefined
}

function convertAnthropicChoice(
  source: PreparedChatCompletionsSource,
  tools: Array<AnthropicTool> | undefined,
  findings: Array<TranslationFinding>,
): AnthropicMessagesPayload["tool_choice"] | undefined {
  if (!tools?.length) return undefined
  const choice = source.tool_choice
  let converted: AnthropicMessagesPayload["tool_choice"]
  switch (choice) {
    case "auto": {
      converted = { type: "auto" }
      break
    }
    case "required": {
      converted = { type: "any" }
      break
    }
    case "none": {
      converted = { type: "none" }
      break
    }
    default: {
      if (
        isRecord(choice)
        && choice.type === "function"
        && isRecord(choice.function)
        && typeof choice.function.name === "string"
      ) {
        converted = { type: "tool", name: choice.function.name }
      } else {
        converted = { type: "auto" }
        if (choice !== undefined && choice !== null) {
          addFinding(findings, { class: "tool_choice", severity: "adapted" })
        }
      }
    }
  }
  if (source.parallel_tool_calls === false) {
    converted.disable_parallel_tool_use = true
  }
  return converted
}

async function convertAnthropicMessages(
  source: PreparedChatCompletionsSource,
  context: CandidateContext,
  signal: AbortSignal | undefined,
): Promise<{ messages: Array<AnthropicMessage>; system: Array<string> }> {
  const messages: Array<AnthropicMessage> = []
  const system: Array<string> = []
  for (
    let messageIndex = 0;
    messageIndex < source.messages.length;
    messageIndex += 1
  ) {
    const message = source.messages[messageIndex]
    if (message.role === "system" || message.role === "developer") {
      const text = contentText(message.content)
      if (text) system.push(text)
      continue
    }
    if (message.role === "assistant") {
      const blocks: Array<AnthropicAssistantContentBlock> = []
      if (
        typeof message.reasoning_text === "string"
        && typeof message.reasoning_opaque === "string"
        && !message.encrypted_content
      ) {
        blocks.push({
          type: "thinking",
          thinking: message.reasoning_text,
          signature: message.reasoning_opaque,
        })
      } else if (
        typeof message.reasoning_text === "string"
        || typeof message.reasoning_opaque === "string"
        || typeof message.encrypted_content === "string"
      ) {
        blocks.push({ type: "text", text: UNSIGNED_REASONING_CONTEXT })
        addFinding(context.findings, {
          class: "reasoning_state",
          severity: "adapted",
        })
      }
      const text = contentText(message.content)
      if (text) blocks.push({ type: "text", text })
      for (const [callIndex, toolCall] of getToolCalls(message).entries()) {
        const definition = isRecord(toolCall.function) ? toolCall.function : {}
        blocks.push({
          type: "tool_use",
          id: createCallId(context, messageIndex, callIndex, toolCall.id),
          name:
            typeof definition.name === "string" && definition.name.trim() ?
              definition.name
            : "unknown_function",
          input: parseAnthropicArguments(definition.arguments),
        })
      }
      if (blocks.length > 0)
        messages.push({ role: "assistant", content: blocks })
      continue
    }
    if (message.role === "tool") {
      const supplied = message.tool_call_id
      if (
        typeof supplied === "string"
        && supplied.trim()
        && context.pendingResultCallIds.delete(supplied)
      ) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: supplied,
              content: contentText(message.content),
            },
          ],
        })
      } else {
        addFinding(context.findings, {
          class: "tool_history",
          severity: "adapted",
        })
        messages.push({
          role: "user",
          content: `${ORPHAN_TOOL_RESULT_CONTEXT}\n${contentText(message.content)}`,
        })
      }
      continue
    }
    const future = message.role !== "user"
    if (future) {
      addFinding(context.findings, {
        class: "message_role",
        severity: "adapted",
      })
    }
    const blocks = await convertAnthropicContent(
      message.content,
      context,
      signal,
    )
    if (future) blocks.unshift({ type: "text", text: FUTURE_ROLE_CONTEXT })
    if (blocks.length > 0) messages.push({ role: "user", content: blocks })
  }
  return { messages, system }
}

async function adaptChatToMessages(
  source: PreparedChatCompletionsSource,
  selectedModel: Model | undefined,
  signal: AbortSignal | undefined,
  sourceFindings: ReadonlyArray<TranslationFinding>,
  attachmentCache: CandidateAttachmentCache,
): Promise<MessagesChatCandidate> {
  // eslint-disable-next-line @eslint-react/naming-convention/context-name -- protocol candidate state, not React context
  const candidateState = createContext(source, sourceFindings, attachmentCache)
  const converted = await convertAnthropicMessages(
    clone(source),
    candidateState,
    signal,
  )
  const tools = convertAnthropicTools(source, candidateState.findings)
  const toolChoice = convertAnthropicChoice(
    source,
    tools,
    candidateState.findings,
  )
  const payload: AnthropicMessagesPayload = {
    model: source.model,
    messages: converted.messages,
    ...(converted.system.length > 0 ?
      { system: converted.system.join("\n\n") }
    : {}),
    ...(typeof source.max_tokens === "number" ?
      { max_tokens: source.max_tokens }
    : typeof source.max_completion_tokens === "number" ?
      { max_tokens: source.max_completion_tokens }
    : selectedModel?.capabilities.limits?.max_output_tokens ?
      { max_tokens: selectedModel.capabilities.limits.max_output_tokens }
    : {}),
    ...(typeof source.stream === "boolean" && source.stream ?
      { stream: true }
    : {}),
    ...(typeof source.temperature === "number" ?
      { temperature: source.temperature }
    : {}),
    ...(typeof source.top_p === "number" ? { top_p: source.top_p } : {}),
    ...(typeof source.stop === "string" ? { stop_sequences: [source.stop] }
    : (
      Array.isArray(source.stop)
      && source.stop.every((entry) => typeof entry === "string")
    ) ?
      { stop_sequences: source.stop }
    : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof source.user === "string" ?
      { metadata: { user_id: source.user } }
    : {}),
  }
  if (
    source.max_completion_tokens !== undefined
    && source.max_tokens !== undefined
  ) {
    addFinding(candidateState.findings, {
      class: "token_alias",
      severity: "adapted",
    })
  }
  if (source.temperature !== undefined && source.top_p !== undefined) {
    delete payload.top_p
    addFinding(candidateState.findings, {
      class: "sampling",
      severity: "omitted",
    })
  }
  if (typeof source.reasoning_effort === "string") {
    payload.output_config = {
      effort: source.reasoning_effort as NonNullable<
        AnthropicMessagesPayload["output_config"]
      >["effort"],
    }
  }
  if (typeof source.thinking_budget === "number") {
    payload.thinking = {
      type: "enabled",
      budget_tokens: source.thinking_budget,
    }
  }
  if (
    isRecord(source.response_format)
    && source.response_format.type === "json_schema"
  ) {
    const jsonSchema = source.response_format.json_schema
    if (isRecord(jsonSchema)) {
      payload.output_config = {
        ...payload.output_config,
        format: { type: "json_schema", ...clone(jsonSchema) },
      }
    }
  }
  return createCandidate({
    endpoint: "/v1/messages",
    payload,
    reason: "endpoint_unavailable",
    findings: candidateState.findings,
    meaningful: converted.messages.length > 0 || converted.system.length > 0,
  })
}

export function prepareChatCandidates(
  options: PrepareChatCandidatesOptions & {
    readonly support: ModelEndpointSupport
  },
): Promise<SupportFilteredChatCandidates>
export function prepareChatCandidates(
  options: PrepareChatCandidatesOptions,
): Promise<PreparedChatCandidates>
export async function prepareChatCandidates(
  options: PrepareChatCandidatesOptions,
): Promise<PreparedChatCandidates | SupportFilteredChatCandidates> {
  const attachmentCache: CandidateAttachmentCache = { values: new Map() }
  const support = options.support ?? {
    chat: true,
    responses: true,
    messages: true,
    embeddings: false,
    responsesWebSocket: false,
  }
  const chat =
    support.chat ?
      await prepareNativeChatCandidate({
        attachmentCache,
        source: options.source,
        signal: options.signal,
        sourceFindings: options.sourceFindings,
      })
    : undefined
  const responses =
    support.responses ?
      adaptChatToResponses(
        clone(options.source),
        options.reasoningEffort,
        options.sourceFindings ?? [],
      )
    : undefined
  const messages =
    support.messages ?
      await adaptChatToMessages(
        clone(options.source),
        options.selectedModel,
        options.signal,
        options.sourceFindings ?? [],
        attachmentCache,
      )
    : undefined
  return { chat, responses, messages }
}

export function orderPreparedChatCandidates(options: {
  readonly candidates: SupportFilteredChatCandidates
  readonly selectedModel: Model | undefined
  readonly source: PreparedChatCompletionsSource
}): ReadonlyArray<ChatEndpointCandidate> {
  const { candidates, selectedModel, source } = options
  const vendor = selectedModel?.vendor?.trim().toLowerCase()
  const family = selectedModel?.capabilities.family.trim().toLowerCase()
  const anthropic =
    vendor ? vendor === "anthropic"
    : family ? family.startsWith("claude")
    : (selectedModel?.id.toLowerCase().startsWith("claude-") ?? false)
  const messagesPreferred =
    source.messages.some(
      (message) =>
        Array.isArray(message.content)
        && message.content.some(
          (part) =>
            isRecord(part)
            && (part.type === "document" || part.type === "file"),
        ),
    )
    || source.messages.some(
      (message) =>
        message.role === "assistant"
        && typeof message.reasoning_text === "string"
        && typeof message.reasoning_opaque === "string"
        && !message.encrypted_content,
    )
    || typeof source.thinking_budget === "number"
  const responsesPreferred =
    source.messages.some(
      (message) => typeof message.encrypted_content === "string",
    )
    || (source.tools ?? []).some(
      (tool) =>
        typeof tool.type === "string"
        && /^web_search(?:_[a-z\d]+)*$/u.test(tool.type),
    )
  const preferred =
    messagesPreferred && anthropic ?
      [candidates.messages, candidates.responses, candidates.chat]
    : responsesPreferred || messagesPreferred ?
      [candidates.responses, candidates.messages, candidates.chat]
    : anthropic ? [candidates.chat, candidates.messages, candidates.responses]
    : [candidates.chat, candidates.responses, candidates.messages]
  return preferred.filter(
    (candidate): candidate is ChatEndpointCandidate => candidate !== undefined,
  )
}

export async function prepareCustomProviderChatCandidate(options: {
  readonly signal?: AbortSignal
  readonly source: PreparedChatCompletionsSource
}): Promise<NativeChatCandidate> {
  return await prepareNativeChatCandidate({
    applyCopilotSemantics: false,
    signal: options.signal,
    source: options.source,
  })
}
