/* eslint-disable complexity, max-params, no-nested-ternary, require-atomic-updates, unicorn/consistent-function-scoping -- tolerant protocol adaptation is a bounded matrix */
import type {
  EvaluatedEndpointCandidate,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type { ReasoningEffort } from "~/lib/model-suffix"
import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type ParsedDataUri,
  fetchUrlAsDataUri,
  isPdfMediaType,
  parseFetchableHttpUrl,
} from "~/lib/attachments"
import { createEvaluatedTranslationCheck } from "~/lib/endpoint-routing"
import { createWebSearchFunctionTool } from "~/services/copilot/mcp-web-search"

import type { PreparedGoogleRequest } from "./google-request-normalization"

import { googleRecordEntries } from "./google-request-normalization"
import { normalizeGoogleSchema } from "./schema"

export type GoogleChatCandidate = EvaluatedEndpointCandidate<
  "/chat/completions",
  ChatCompletionsPayload & { model: string }
>

export interface AdaptGoogleToChatCandidateOptions {
  readonly resolveAttachment?: GoogleAttachmentResolver
  readonly explicitReasoningEffort?: ReasoningEffort
  readonly finalModel: string
  readonly signal?: AbortSignal
  readonly source: PreparedGoogleRequest
  readonly stream: boolean
}

export type GoogleAttachmentResolver = (options: {
  readonly expectPdf: boolean
  readonly signal?: AbortSignal
  readonly value: string
}) => Promise<ParsedDataUri | null>

interface AdaptationState {
  readonly attachmentCache: Map<string, Promise<ParsedDataUri | null>>
  readonly findings: Array<TranslationFinding>
  readonly pendingByName: Map<string, Array<string>>
  readonly pendingById: Map<string, string>
  readonly reservedIds: Set<string>
  readonly usedIds: Set<string>
  meaningful: boolean
}

const UNKNOWN_PART_CONTEXT = "[Unsupported Google content preserved as context]"
const FUTURE_ROLE_CONTEXT = "[Future Google role content]"
const ATTACHMENT_CONTEXT = "[Google attachment unavailable]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function addFinding(state: AdaptationState, finding: TranslationFinding): void {
  if (
    state.findings.some(
      (current) =>
        current.class === finding.class
        && current.severity === finding.severity,
    )
  ) {
    return
  }
  state.findings.push(finding)
}

function collectReservedIds(
  source: Readonly<Record<string, unknown>>,
): Set<string> {
  const reserved = new Set<string>()
  for (const content of googleRecordEntries(source.contents, () => {})) {
    for (const part of googleRecordEntries(content.parts, () => {})) {
      for (const value of [part.id, part.callId]) {
        if (typeof value === "string" && value.trim()) reserved.add(value)
      }
      if (isRecord(part.functionCall)) {
        const nested = part.functionCall.id
        if (typeof nested === "string" && nested.trim()) reserved.add(nested)
      }
    }
  }
  return reserved
}

function createState(source: PreparedGoogleRequest): AdaptationState {
  return {
    attachmentCache: new Map(),
    findings: source.findings.map((finding) => ({ ...finding })),
    meaningful: false,
    pendingByName: new Map(),
    pendingById: new Map(),
    reservedIds: collectReservedIds(source.source),
    usedIds: new Set(),
  }
}

function records(
  state: AdaptationState,
  value: unknown,
  findingClass: TranslationFinding["class"],
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return googleRecordEntries(value, () =>
    addFinding(state, { class: findingClass, severity: "adapted" }),
  )
}

function asTextPart(text: string): ContentPart {
  return { type: "text", text }
}

function flattenParts(parts: Array<ContentPart>): string | Array<ContentPart> {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part as { text: string }).text).join("")
  }
  return parts
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return "{}"
  }
}

function callName(value: unknown, state: AdaptationState): string {
  if (typeof value === "string" && value.trim()) return value
  addFinding(state, { class: "tool_history", severity: "adapted" })
  return "unknown_function"
}

function suppliedCallId(
  part: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const value of [
    part.id,
    part.callId,
    isRecord(part.functionCall) ? part.functionCall.id : undefined,
  ]) {
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function responseCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function allocateCallId(
  state: AdaptationState,
  part: Readonly<Record<string, unknown>>,
  contentIndex: number,
  partIndex: number,
): string {
  const supplied = suppliedCallId(part)
  if (supplied && !state.usedIds.has(supplied)) {
    state.usedIds.add(supplied)
    return supplied
  }
  const base = `call_${contentIndex}_${partIndex}`
  let id = base
  let suffix = 0
  while (state.reservedIds.has(id) || state.usedIds.has(id)) {
    suffix += 1
    id = `${base}_${suffix}`
  }
  state.usedIds.add(id)
  addFinding(state, { class: "tool_history", severity: "adapted" })
  return id
}

function enqueueCall(state: AdaptationState, name: string, id: string): void {
  const queue = state.pendingByName.get(name) ?? []
  queue.push(id)
  state.pendingByName.set(name, queue)
  state.pendingById.set(id, name)
}

function dequeueCall(
  state: AdaptationState,
  name: string,
  suppliedId: string | undefined,
): string | undefined {
  const id = suppliedId ?? state.pendingByName.get(name)?.[0]
  if (!id) return undefined
  const pendingName = state.pendingById.get(id)
  if (pendingName === undefined) return undefined
  const queue = state.pendingByName.get(pendingName)
  const index = queue?.indexOf(id) ?? -1
  if (index >= 0) queue?.splice(index, 1)
  state.pendingById.delete(id)
  return id
}

async function attachmentPart(
  state: AdaptationState,
  raw: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  resolveAttachment: GoogleAttachmentResolver,
): Promise<ContentPart> {
  if (isRecord(raw.inlineData)) {
    const mimeType = raw.inlineData.mimeType
    const data = raw.inlineData.data
    if (typeof mimeType === "string" && typeof data === "string") {
      if (mimeType.toLowerCase().startsWith("image/")) {
        state.meaningful = true
        return {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${data}` },
        }
      }
      if (isPdfMediaType(mimeType)) {
        state.meaningful = true
        return {
          type: "file",
          file: {
            filename: "document.pdf",
            file_data: `data:${mimeType};base64,${data}`,
          },
        }
      }
    }
    addFinding(state, { class: "attachment", severity: "adapted" })
    state.meaningful = true
    return asTextPart(ATTACHMENT_CONTEXT)
  }

  if (isRecord(raw.fileData)) {
    const mimeType = raw.fileData.mimeType
    const uri = raw.fileData.fileUri
    if (
      typeof uri === "string"
      && typeof mimeType === "string"
      && parseFetchableHttpUrl(uri)
    ) {
      const key = `${isPdfMediaType(mimeType) ? "pdf" : "asset"}:${uri}`
      let pending = state.attachmentCache.get(key)
      if (!pending) {
        pending = resolveAttachment({
          expectPdf: isPdfMediaType(mimeType),
          signal,
          value: uri,
        })
        state.attachmentCache.set(key, pending)
      }
      const parsed = await pending
      if (parsed) {
        state.meaningful = true
        return parsed.mediaType.toLowerCase().startsWith("image/") ?
            {
              type: "image_url",
              image_url: {
                url: `data:${parsed.mediaType};base64,${parsed.data}`,
              },
            }
          : {
              type: "file",
              file: {
                filename: "document.pdf",
                file_data: `data:${parsed.mediaType};base64,${parsed.data}`,
              },
            }
      }
    }
    addFinding(state, { class: "attachment", severity: "adapted" })
    state.meaningful = true
    return asTextPart(ATTACHMENT_CONTEXT)
  }

  addFinding(state, { class: "content_part", severity: "adapted" })
  state.meaningful = true
  return asTextPart(UNKNOWN_PART_CONTEXT)
}

async function translateContentParts(
  state: AdaptationState,
  value: unknown,
  signal: AbortSignal | undefined,
  resolveAttachment: GoogleAttachmentResolver,
): Promise<Array<ContentPart>> {
  const output: Array<ContentPart> = []
  const rawEntries =
    Array.isArray(value) ? value
    : value === undefined || value === null ? []
    : [value]
  if (
    !Array.isArray(value)
    && value !== undefined
    && value !== null
    && !isRecord(value)
  ) {
    addFinding(state, { class: "content_part", severity: "adapted" })
  }
  for (const raw of rawEntries) {
    if (!isRecord(raw)) {
      addFinding(state, { class: "content_part", severity: "adapted" })
      state.meaningful = true
      output.push(asTextPart(UNKNOWN_PART_CONTEXT))
      continue
    }
    if (typeof raw.text === "string") {
      if (!raw.thought && raw.text.length > 0) state.meaningful = true
      if (!raw.thought) output.push(asTextPart(raw.text))
      continue
    }
    if (raw.inlineData !== undefined || raw.fileData !== undefined) {
      output.push(await attachmentPart(state, raw, signal, resolveAttachment))
      continue
    }
    if (raw.functionCall !== undefined || raw.functionResponse !== undefined)
      continue
    addFinding(state, { class: "content_part", severity: "adapted" })
    state.meaningful = true
    output.push(asTextPart(UNKNOWN_PART_CONTEXT))
  }
  return output
}

function roleForContent(
  state: AdaptationState,
  value: unknown,
): { role: "assistant" | "user"; prefix?: ContentPart } {
  if (value === "model") return { role: "assistant" }
  if (value === "user") return { role: "user" }
  addFinding(state, { class: "message_role", severity: "adapted" })
  return typeof value === "string" && value.trim().length > 0 ?
      { role: "user", prefix: asTextPart(FUTURE_ROLE_CONTEXT) }
    : { role: "user" }
}

async function translateContents(
  state: AdaptationState,
  value: unknown,
  signal: AbortSignal | undefined,
  resolveAttachment: GoogleAttachmentResolver,
): Promise<Array<Message>> {
  const messages: Array<Message> = []
  for (const [contentIndex, content] of records(
    state,
    value,
    "message_shape",
  ).entries()) {
    const role = roleForContent(state, content.role)
    let run: Array<ContentPart> = role.prefix ? [role.prefix] : []
    let calls: Array<ToolCall> = []
    const flush = (): void => {
      if (run.length === 0 && calls.length === 0) return
      messages.push(
        calls.length > 0 ?
          {
            role: "assistant",
            content: run.length > 0 ? flattenParts(run) : null,
            tool_calls: calls,
          }
        : { role: role.role, content: flattenParts(run) },
      )
      run = []
      calls = []
    }
    const rawParts =
      Array.isArray(content.parts) ? content.parts
      : content.parts === undefined || content.parts === null ? []
      : [content.parts]
    for (const [partIndex, partValue] of rawParts.entries()) {
      if (!isRecord(partValue)) {
        run.push(asTextPart(UNKNOWN_PART_CONTEXT))
        addFinding(state, { class: "content_part", severity: "adapted" })
        state.meaningful = true
        continue
      }
      if (isRecord(partValue.functionCall)) {
        const name = callName(partValue.functionCall.name, state)
        const id = allocateCallId(state, partValue, contentIndex, partIndex)
        enqueueCall(state, name, id)
        calls.push({
          id,
          type: "function",
          function: {
            name,
            arguments: safeStringify(partValue.functionCall.args),
          },
        })
        state.meaningful = true
        continue
      }
      if (isRecord(partValue.functionResponse)) {
        flush()
        const name = callName(partValue.functionResponse.name, state)
        const suppliedId = responseCallId(partValue.functionResponse.id)
        let id = dequeueCall(state, name, suppliedId)
        if (!id) {
          id = allocateCallId(
            state,
            { id: suppliedId },
            contentIndex,
            partIndex,
          )
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id,
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          })
        }
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: safeStringify(partValue.functionResponse.response),
        })
        state.meaningful = true
        continue
      }
      run.push(
        ...(await translateContentParts(
          state,
          [partValue],
          signal,
          resolveAttachment,
        )),
      )
    }
    flush()
  }
  return messages
}

async function translateSystem(
  state: AdaptationState,
  value: unknown,
  signal: AbortSignal | undefined,
  resolveAttachment: GoogleAttachmentResolver,
): Promise<Message | undefined> {
  if (!isRecord(value)) {
    if (value !== undefined && value !== null)
      addFinding(state, { class: "message_shape", severity: "adapted" })
    return undefined
  }
  const parts = await translateContentParts(
    state,
    value.parts,
    signal,
    resolveAttachment,
  )
  return parts.length > 0 ?
      { role: "system", content: flattenParts(parts) }
    : undefined
}

function translateTools(
  state: AdaptationState,
  value: unknown,
): Array<Tool> | undefined {
  const tools: Array<Tool> = []
  for (const tool of records(state, value, "tool_shape")) {
    for (const declaration of records(
      state,
      tool.functionDeclarations,
      "tool_shape",
    )) {
      if (typeof declaration.name !== "string" || !declaration.name.trim()) {
        addFinding(state, { class: "tool_shape", severity: "omitted" })
        continue
      }
      const schemaSource =
        isRecord(declaration.parameters) ? declaration.parameters
        : isRecord(declaration.parametersJsonSchema) ?
          declaration.parametersJsonSchema
        : undefined
      const changed = { value: false }
      const parameters = normalizeGoogleSchema(schemaSource, changed)
      tools.push({
        type: "function",
        function: {
          name: declaration.name,
          ...(typeof declaration.description === "string" ?
            { description: declaration.description }
          : {}),
          parameters,
          ...(changed.value ? { strict: false } : {}),
        },
      })
    }
    if (isRecord(tool.googleSearch)) {
      const searchTool = createWebSearchFunctionTool(tool.googleSearch)
      const maxUses = tool.googleSearch.max_uses
      if (Number.isInteger(maxUses) && Number(maxUses) > 0) {
        ;(searchTool.function as unknown as Record<string, unknown>).max_uses =
          Number(maxUses)
      }
      tools.push(searchTool)
    }
    if (tool.codeExecution !== undefined) {
      addFinding(state, { class: "tool_shape", severity: "omitted" })
    }
    const known = new Set([
      "functionDeclarations",
      "googleSearch",
      "codeExecution",
    ])
    if (Object.keys(tool).some((key) => !known.has(key))) {
      addFinding(state, { class: "tool_shape", severity: "omitted" })
    }
  }
  return tools.length > 0 ? tools : undefined
}

function translateToolChoice(
  state: AdaptationState,
  value: unknown,
  tools: Array<Tool> | undefined,
): ChatCompletionsPayload["tool_choice"] {
  if (
    !tools?.length
    || !isRecord(value)
    || !isRecord(value.functionCallingConfig)
  )
    return undefined
  const config = value.functionCallingConfig
  const mode = typeof config.mode === "string" ? config.mode.toUpperCase() : ""
  const allowed =
    Array.isArray(config.allowedFunctionNames) ?
      Array.from(
        new Set(
          config.allowedFunctionNames.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.trim().length > 0,
          ),
        ),
      )
    : []
  if (mode === "AUTO") return "auto"
  if (mode === "NONE") return "none"
  if (mode === "ANY") {
    const valid = allowed.filter((name) =>
      tools.some((tool) => tool.function.name === name),
    )
    if (valid.length === 1)
      return { type: "function", function: { name: valid[0] } }
    if (valid.length > 1) {
      tools.splice(
        0,
        tools.length,
        ...tools.filter((tool) => valid.includes(tool.function.name)),
      )
    }
    return "required"
  }
  addFinding(state, { class: "tool_choice", severity: "adapted" })
  return "auto"
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function generationFields(
  state: AdaptationState,
  value: unknown,
): Partial<ChatCompletionsPayload> {
  if (!isRecord(value)) return {}
  const output: Partial<ChatCompletionsPayload> = {}
  const numberFields = [
    ["maxOutputTokens", "max_tokens"],
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["seed", "seed"],
    ["frequencyPenalty", "frequency_penalty"],
    ["presencePenalty", "presence_penalty"],
  ] as const
  for (const [sourceKey, targetKey] of numberFields) {
    const sourceValue = value[sourceKey]
    if (sourceValue === null || sourceValue === undefined) continue
    const mapped = finiteNumber(sourceValue)
    if (mapped === undefined)
      addFinding(state, { class: "sampling", severity: "omitted" })
    else (output as Record<string, unknown>)[targetKey] = mapped
  }
  if (
    Array.isArray(value.stopSequences)
    && value.stopSequences.every((entry) => typeof entry === "string")
  ) {
    output.stop = value.stopSequences
  }
  const responseSchema =
    isRecord(value.responseSchema) ?
      value.responseSchema
    : value.responseJsonSchema
  if (isRecord(responseSchema)) {
    const changed = { value: false }
    output.response_format = {
      type: "json_schema",
      json_schema: {
        name: "google_response",
        schema: normalizeGoogleSchema(responseSchema, changed),
        strict: false,
      },
    }
  } else if (value.responseMimeType === "application/json") {
    output.response_format = { type: "json_object" }
  }
  if (isRecord(value.thinkingConfig)) {
    const budget = finiteNumber(value.thinkingConfig.thinkingBudget)
    if (budget !== undefined) output.thinking_budget = budget
    if (
      Object.keys(value.thinkingConfig).some(
        (key) => key !== "thinkingBudget" && key !== "thinkingLevel",
      )
    ) {
      addFinding(state, { class: "reasoning_state", severity: "adapted" })
    }
  }
  const known = new Set([
    "maxOutputTokens",
    "temperature",
    "topP",
    "stopSequences",
    "seed",
    "frequencyPenalty",
    "presencePenalty",
    "responseMimeType",
    "responseSchema",
    "responseJsonSchema",
    "thinkingConfig",
  ])
  if (Object.keys(value).some((key) => !known.has(key))) {
    addFinding(state, { class: "sampling", severity: "omitted" })
  }
  return output
}

export async function adaptGoogleToChatCandidate(
  options: AdaptGoogleToChatCandidateOptions,
): Promise<GoogleChatCandidate> {
  const state = createState(options.source)
  const resolveAttachment: GoogleAttachmentResolver =
    options.resolveAttachment
    ?? (async ({ expectPdf, signal, value }) =>
      await fetchUrlAsDataUri(value, { expectPdf, signal }))
  const messages: Array<Message> = []
  const system = await translateSystem(
    state,
    options.source.source.systemInstruction,
    options.signal,
    resolveAttachment,
  )
  if (system) messages.push(system)
  messages.push(
    ...(await translateContents(
      state,
      options.source.source.contents,
      options.signal,
      resolveAttachment,
    )),
  )
  const tools = translateTools(state, options.source.source.tools)
  const payload: ChatCompletionsPayload & { model: string } = {
    model: options.finalModel,
    messages,
    stream: options.stream,
    ...(options.stream ? { stream_options: { include_usage: true } } : {}),
    ...generationFields(state, options.source.source.generationConfig),
    ...(tools ? { tools } : {}),
    snippy: { enabled: false },
  }
  const toolChoice = translateToolChoice(
    state,
    options.source.source.toolConfig,
    tools,
  )
  if (toolChoice !== undefined) payload.tool_choice = toolChoice
  if (tools?.some((tool) => tool.function.name === "web_search")) {
    payload.parallel_tool_calls = false
  }
  if (options.explicitReasoningEffort) {
    payload.reasoning_effort = options.explicitReasoningEffort
  } else if (
    isRecord(options.source.source.generationConfig)
    && isRecord(options.source.source.generationConfig.thinkingConfig)
  ) {
    const level =
      options.source.source.generationConfig.thinkingConfig.thinkingLevel
    if (level === "low" || level === "medium" || level === "high")
      payload.reasoning_effort = level
  }
  for (const key of Object.keys(options.source.source)) {
    if (
      ![
        "contents",
        "generationConfig",
        "systemInstruction",
        "toolConfig",
        "tools",
      ].includes(key)
    ) {
      addFinding(state, { class: "unknown_top_level", severity: "omitted" })
    }
  }
  if (!state.meaningful) {
    addFinding(state, { class: "message_shape", severity: "fatal" })
  }
  return {
    endpoint: "/chat/completions",
    payload,
    reason: "payload_requirement",
    check: createEvaluatedTranslationCheck(state.findings),
  }
}

/** Legacy pure wrapper retained for callers migrating to the tolerant adapter. */
export function translateGoogleToOpenAI(
  payload: Record<string, unknown>,
  model: string,
  stream: boolean,
): ChatCompletionsPayload {
  const source: PreparedGoogleRequest = {
    source: structuredClone(payload),
    findings: [],
  }
  // The legacy wrapper is intentionally synchronous and therefore retains
  // external fileData as a fixed omission instead of performing network I/O.
  const state = createState(source)
  const messages: Array<Message> = []
  const rawContents = googleRecordEntries(source.source.contents, () => {})
  for (const content of rawContents) {
    const role = content.role === "model" ? "assistant" : "user"
    const parts = googleRecordEntries(content.parts, () => {})
    const translated: Array<ContentPart> = parts.flatMap((part) => {
      if (typeof part.text === "string") return [asTextPart(part.text)]
      if (isRecord(part.inlineData)) {
        const mimeType = part.inlineData.mimeType
        const data = part.inlineData.data
        if (typeof mimeType === "string" && typeof data === "string") {
          if (mimeType.toLowerCase().startsWith("image/")) {
            return [
              {
                type: "image_url" as const,
                image_url: { url: `data:${mimeType};base64,${data}` },
              },
            ]
          }
          if (isPdfMediaType(mimeType)) {
            return [
              {
                type: "file" as const,
                file: {
                  filename: "document.pdf",
                  file_data: `data:${mimeType};base64,${data}`,
                },
              },
            ]
          }
          return [asTextPart(ATTACHMENT_CONTEXT)]
        }
      }
      return [asTextPart(UNKNOWN_PART_CONTEXT)]
    })
    if (translated.length > 0)
      messages.push({ role, content: flattenParts(translated) })
  }
  const tools = translateTools(state, source.source.tools)
  const result: ChatCompletionsPayload = {
    model,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...generationFields(state, source.source.generationConfig),
    ...(tools ? { tools } : {}),
    snippy: { enabled: false },
  }
  const choice = translateToolChoice(state, source.source.toolConfig, tools)
  if (choice !== undefined) result.tool_choice = choice
  if (tools?.some((tool) => tool.function.name === "web_search")) {
    result.parallel_tool_calls = false
  }
  return result
}
