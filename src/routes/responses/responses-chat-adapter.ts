/* eslint-disable complexity, max-depth, max-lines-per-function, max-params -- open Responses items require a bounded compatibility matrix */
import type {
  EvaluatedEndpointCandidate,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesWireBody } from "~/services/copilot/responses-contract"

import { fetchUrlAsDataUri, isHttpUrl } from "~/lib/attachments"
import { getConfig } from "~/lib/config"
import { createEvaluatedTranslationCheck } from "~/lib/endpoint-routing"
import {
  fitChatCompletionsCompactionPayload,
  isResponsesCompactionRequest,
} from "~/services/copilot/compaction-payload"
import { createWebSearchFunctionTool } from "~/services/copilot/mcp-web-search"

import type { ResponsesAttachmentCache } from "./attachment-cache"

export type ResponsesChatCandidate = EvaluatedEndpointCandidate<
  "/chat/completions",
  ChatCompletionsPayload
>

export interface AdaptResponsesToChatOptions {
  readonly finalModel?: string
  readonly finalReasoningEffort?: string | number
  readonly signal?: AbortSignal
  readonly source: ResponsesWireBody
  readonly attachmentCache?: ResponsesAttachmentCache
}

interface AdapterState {
  readonly consumedCallIds: Set<string>
  readonly findings: Array<TranslationFinding>
  readonly pendingCallIds: Set<string>
  readonly reservedCallIds: Set<string>
  readonly usedCallIds: Set<string>
}

const FUTURE_ITEM_CONTEXT = "[Future Responses item]"
const FUTURE_ROLE_CONTEXT = "[Future role content]"
const UNKNOWN_CONTENT_CONTEXT = "[Unrepresentable content item]"
const REASONING_CONTEXT = "[Assistant reasoning context]"
const UNPAIRED_RESULT_CONTEXT = "[Unpaired tool result]"

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

function createState(source: ResponsesWireBody): AdapterState {
  const reservedCallIds = new Set<string>()
  if (Array.isArray(source.input)) {
    for (const raw of source.input) {
      if (!isRecord(raw)) continue
      const callId = raw.call_id
      if (typeof callId === "string" && callId.trim()) {
        reservedCallIds.add(callId)
      }
    }
  }
  return {
    consumedCallIds: new Set(),
    findings: [],
    pendingCallIds: new Set(),
    reservedCallIds,
    usedCallIds: new Set(),
  }
}

function createCallId(
  state: AdapterState,
  itemIndex: number,
  supplied: unknown,
): string {
  if (
    typeof supplied === "string"
    && supplied.trim()
    && !state.usedCallIds.has(supplied)
  ) {
    state.usedCallIds.add(supplied)
    state.pendingCallIds.add(supplied)
    return supplied
  }
  const base = `responses_call_${itemIndex}_0`
  let candidate = base
  let suffix = 0
  while (
    state.reservedCallIds.has(candidate)
    || state.usedCallIds.has(candidate)
  ) {
    suffix += 1
    candidate = `${base}_${suffix}`
  }
  state.usedCallIds.add(candidate)
  state.pendingCallIds.add(candidate)
  addFinding(state.findings, { class: "tool_history", severity: "adapted" })
  return candidate
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value ?? {})
}

function stringifyUseful(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

async function convertContent(
  content: unknown,
  findings: Array<TranslationFinding>,
  signal: AbortSignal | undefined,
  attachmentCache: ResponsesAttachmentCache["values"],
): Promise<string | Array<ContentPart>> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<ContentPart> = []
  for (const raw of content) {
    if (!isRecord(raw)) {
      addFinding(findings, { class: "content_part", severity: "adapted" })
      parts.push({ type: "text", text: UNKNOWN_CONTENT_CONTEXT })
      continue
    }
    if (
      (raw.type === "input_text" || raw.type === "output_text")
      && typeof raw.text === "string"
    ) {
      parts.push({ type: "text", text: raw.text })
      continue
    }
    if (raw.type === "input_image") {
      const url = typeof raw.image_url === "string" ? raw.image_url : undefined
      if (url) {
        let finalUrl = url
        if (isHttpUrl(url)) {
          const fetched =
            attachmentCache.has(url) ?
              (attachmentCache.get(url) ?? null)
            : await fetchUrlAsDataUri(url, { signal })
          attachmentCache.set(url, fetched)
          if (fetched) {
            finalUrl = `data:${fetched.mediaType};base64,${fetched.data}`
          } else {
            addFinding(findings, { class: "attachment", severity: "omitted" })
            parts.push({ type: "text", text: "[Image attachment unavailable]" })
            continue
          }
        }
        parts.push({
          type: "image_url",
          image_url: {
            url: finalUrl,
            detail:
              raw.detail === "low" || raw.detail === "high" ?
                raw.detail
              : "auto",
          },
        })
      } else {
        addFinding(findings, { class: "attachment", severity: "omitted" })
        parts.push({ type: "text", text: "[Image attachment unavailable]" })
      }
      continue
    }
    if (raw.type === "input_file") {
      let fileData =
        typeof raw.file_data === "string" ? raw.file_data : undefined
      if (
        !fileData
        && typeof raw.file_url === "string"
        && isHttpUrl(raw.file_url)
      ) {
        const fetched =
          attachmentCache.has(raw.file_url) ?
            (attachmentCache.get(raw.file_url) ?? null)
          : await fetchUrlAsDataUri(raw.file_url, { expectPdf: true, signal })
        attachmentCache.set(raw.file_url, fetched)
        if (fetched)
          fileData = `data:${fetched.mediaType};base64,${fetched.data}`
      }
      if (fileData) {
        parts.push({
          type: "file",
          file: {
            ...(typeof raw.filename === "string" ?
              { filename: raw.filename }
            : {}),
            file_data: fileData,
          },
        })
      } else {
        addFinding(findings, { class: "attachment", severity: "omitted" })
        parts.push({ type: "text", text: "[File attachment unavailable]" })
      }
      continue
    }
    addFinding(findings, { class: "content_part", severity: "adapted" })
    parts.push({ type: "text", text: UNKNOWN_CONTENT_CONTEXT })
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part as { text: string }).text).join("")
  }
  return parts
}

function pushContextMessage(
  messages: Array<Message>,
  role: "assistant" | "user",
  label: string,
  value?: unknown,
): void {
  const detail = stringifyUseful(value)
  messages.push({
    role,
    content: detail ? `${label}\n${detail}` : label,
  })
}

async function convertInput(
  source: ResponsesWireBody,
  state: AdapterState,
  signal: AbortSignal | undefined,
  sharedAttachmentCache: ResponsesAttachmentCache | undefined,
): Promise<Array<Message>> {
  const messages: Array<Message> = []
  const attachmentCache: ResponsesAttachmentCache["values"] =
    sharedAttachmentCache?.values ?? new Map<string, null>()
  if (typeof source.input === "string") {
    messages.push({ role: "user", content: source.input })
    return messages
  }
  if (!Array.isArray(source.input)) return messages

  for (const [itemIndex, raw] of source.input.entries()) {
    if (!isRecord(raw)) {
      if (stringifyUseful(raw)) {
        addFinding(state.findings, {
          class: "unknown_item",
          severity: "adapted",
        })
        pushContextMessage(messages, "user", FUTURE_ITEM_CONTEXT)
      }
      continue
    }
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type === "function_call") {
      const id = createCallId(state, itemIndex, raw.call_id)
      const name =
        typeof raw.name === "string" && raw.name.trim() ?
          raw.name
        : "unknown_function"
      if (name === "unknown_function") {
        addFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
      }
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: { name, arguments: stringifyArguments(raw.arguments) },
          },
        ],
      })
      continue
    }
    if (type === "function_call_output") {
      const supplied = raw.call_id
      if (
        typeof supplied === "string"
        && state.pendingCallIds.has(supplied)
        && !state.consumedCallIds.has(supplied)
      ) {
        state.consumedCallIds.add(supplied)
        messages.push({
          role: "tool",
          tool_call_id: supplied,
          content: stringifyUseful(raw.output),
        })
      } else {
        addFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
        pushContextMessage(
          messages,
          "user",
          UNPAIRED_RESULT_CONTEXT,
          raw.output,
        )
      }
      continue
    }
    if (type === "reasoning") {
      const summary = Array.isArray(raw.summary) ? raw.summary : []
      for (const entry of summary) {
        if (isRecord(entry) && typeof entry.text === "string" && entry.text) {
          messages.push({ role: "assistant", content: entry.text })
        }
      }
      if (
        typeof raw.encrypted_content === "string"
        || typeof raw.id === "string"
        || summary.length === 0
      ) {
        addFinding(state.findings, {
          class: "reasoning_state",
          severity: "adapted",
        })
        messages.push({ role: "assistant", content: REASONING_CONTEXT })
      }
      continue
    }
    if (
      type === "custom_tool_call"
      || type === "custom_tool_call_output"
      || type === "computer_call_output"
      || type === "computer_call"
      || type === "hosted_tool_call"
      || type === "programmatic_tool_call"
    ) {
      addFinding(state.findings, { class: "tool_history", severity: "adapted" })
      const callId = typeof raw.call_id === "string" ? raw.call_id : "unknown"
      if (type.endsWith("output")) {
        const output = stringifyUseful(raw.output)
        const prefix =
          type === "custom_tool_call_output" ? "Custom tool result" : (
            "Tool result"
          )
        messages.push({
          role: "user",
          content: `[${prefix} ${callId}: ${output}]`,
        })
      } else {
        const name = typeof raw.name === "string" ? raw.name : "unknown"
        messages.push({
          role: "assistant",
          content: `[Custom tool call ${callId}: ${name}(${stringifyUseful(raw.input)})]`,
        })
      }
      continue
    }
    if (type === undefined || type === "message") {
      const knownRole =
        raw.role === "assistant"
        || raw.role === "developer"
        || raw.role === "system"
        || raw.role === "user"
      const role: "assistant" | "developer" | "system" | "user" =
        knownRole ?
          (raw.role as "assistant" | "developer" | "system" | "user")
        : "user"
      if (!knownRole) {
        addFinding(state.findings, {
          class: "message_role",
          severity: "adapted",
        })
        messages.push({ role: "user", content: FUTURE_ROLE_CONTEXT })
      }
      const content = await convertContent(
        raw.content,
        state.findings,
        signal,
        attachmentCache,
      )
      if ((typeof content === "string" && content) || Array.isArray(content)) {
        messages.push({ role, content })
      }
      continue
    }
    addFinding(state.findings, { class: "unknown_item", severity: "adapted" })
    pushContextMessage(messages, "user", FUTURE_ITEM_CONTEXT)
  }
  return messages
}

function repairSchema(value: unknown): {
  repaired: boolean
  schema: Record<string, unknown>
} {
  const schema = isRecord(value) ? clone(value) : {}
  let repaired = !isRecord(value)
  if (schema.type !== "object") {
    schema.type = "object"
    repaired = true
  }
  if (!isRecord(schema.properties)) {
    schema.properties = {}
    repaired = true
  }
  return { repaired, schema }
}

function convertTools(
  source: ResponsesWireBody,
  findings: Array<TranslationFinding>,
): Array<Tool> | undefined {
  if (!Array.isArray(source.tools)) return undefined
  const tools: Array<Tool> = []
  for (const raw of source.tools) {
    if (!isRecord(raw)) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type === "web_search" || type?.startsWith("web_search_")) {
      tools.push(createWebSearchFunctionTool(raw))
      continue
    }
    const isApplyPatch =
      type === "custom"
      && raw.name === "apply_patch"
      && (getConfig().useFunctionApplyPatch ?? true)
    if (type !== "function" && !isApplyPatch) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    const name =
      typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined
    if (!name) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    const repaired = repairSchema(
      isApplyPatch ?
        {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        }
      : raw.parameters,
    )
    tools.push({
      type: "function",
      function: {
        name,
        ...(typeof raw.description === "string" ?
          { description: raw.description }
        : {}),
        parameters: repaired.schema,
      },
    })
    if (repaired.repaired || isApplyPatch) {
      addFinding(findings, { class: "tool_shape", severity: "adapted" })
    }
  }
  return tools.length > 0 ? tools : undefined
}

function convertToolChoice(
  source: ResponsesWireBody,
  tools: Array<Tool> | undefined,
  findings: Array<TranslationFinding>,
): ChatCompletionsPayload["tool_choice"] {
  if (!tools?.length) return undefined
  const choice = source.tool_choice
  if (choice === "none" || choice === "auto" || choice === "required") {
    return choice
  }
  if (
    isRecord(choice)
    && choice.type === "function"
    && typeof choice.name === "string"
    && tools.some((tool) => tool.function.name === choice.name)
  ) {
    return { type: "function", function: { name: choice.name } }
  }
  if (choice !== undefined) {
    addFinding(findings, { class: "tool_choice", severity: "adapted" })
  }
  return "auto"
}

function addUnsupportedTopLevelFindings(
  source: ResponsesWireBody,
  findings: Array<TranslationFinding>,
): void {
  const stateKeys = [
    "background",
    "conversation_id",
    "metadata",
    "previous_response_id",
    "prompt",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
  ]
  if (
    stateKeys.some((key) => source[key] !== undefined && source[key] !== null)
  ) {
    addFinding(findings, { class: "stateful_controls", severity: "omitted" })
  }
  if (
    source.context_management !== undefined
    || source.multi_agent !== undefined
    || source.truncation !== undefined
  ) {
    addFinding(findings, { class: "context_management", severity: "omitted" })
  }
  if (source.include !== undefined || source.text !== undefined) {
    addFinding(findings, { class: "sampling", severity: "omitted" })
  }
}

export async function adaptResponsesToChatCandidate(
  options: AdaptResponsesToChatOptions,
): Promise<ResponsesChatCandidate> {
  const source = clone(options.source)
  source.model = options.finalModel ?? source.model
  if (options.finalReasoningEffort !== undefined) {
    source.reasoning = {
      ...(isRecord(source.reasoning) ? source.reasoning : {}),
      effort: options.finalReasoningEffort,
    }
  }
  const state = createState(source)
  const messages = await convertInput(
    source,
    state,
    options.signal,
    options.attachmentCache,
  )
  if (typeof source.instructions === "string" && source.instructions) {
    messages.unshift({ role: "system", content: source.instructions })
  }
  const tools = convertTools(source, state.findings)
  const toolChoice = convertToolChoice(source, tools, state.findings)
  addUnsupportedTopLevelFindings(source, state.findings)

  const payload: ChatCompletionsPayload = {
    model: source.model,
    messages,
    stream: Boolean(source.stream),
    ...(source.stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof source.max_output_tokens === "number" ?
      { max_tokens: source.max_output_tokens }
    : {}),
    ...(typeof source.temperature === "number" ?
      { temperature: source.temperature }
    : {}),
    ...(typeof source.top_p === "number" && source.temperature === undefined ?
      { top_p: source.top_p }
    : {}),
    ...(typeof source.reasoning?.effort === "string" ?
      { reasoning_effort: source.reasoning.effort }
    : {}),
    ...(typeof source.user === "string" ? { user: source.user } : {}),
  }
  if (source.temperature !== undefined && source.top_p !== undefined) {
    addFinding(state.findings, { class: "sampling", severity: "omitted" })
  }
  if (
    source.reasoning?.effort !== undefined
    && typeof source.reasoning.effort !== "string"
  ) {
    addFinding(state.findings, {
      class: "reasoning_state",
      severity: "omitted",
    })
  }
  if (tools?.some((tool) => tool.function.name === "web_search")) {
    payload.parallel_tool_calls = false
  } else if (typeof source.parallel_tool_calls === "boolean") {
    payload.parallel_tool_calls = source.parallel_tool_calls
  }

  const finalizedPayload =
    isResponsesCompactionRequest(source) ?
      fitChatCompletionsCompactionPayload(payload).payload
    : payload
  const meaningful = finalizedPayload.messages.length > 0
  const findings: Array<TranslationFinding> =
    meaningful ?
      state.findings
    : [{ class: "message_shape", severity: "fatal" }, ...state.findings]
  return {
    endpoint: "/chat/completions",
    reason: "endpoint_unavailable",
    payload: finalizedPayload,
    check: createEvaluatedTranslationCheck(findings),
  }
}
