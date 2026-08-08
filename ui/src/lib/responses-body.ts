import type { JsonValue } from "./json-tree"
import type { ParsedToolCall } from "./response-tool-calls"

import { looksLikeAnthropicMessage, parseAnthropicBody } from "./anthropic-body"
import {
  collectChatToolCalls,
  collectResponsesToolCalls,
} from "./response-tool-calls"

type JsonRecord = { [key: string]: JsonValue }

export interface ResponsesStreamEvent {
  data: JsonValue
  rawData: string
  sequenceNumber?: number
  type: string
}

export interface ParsedResponsesBody {
  assistantText: string
  copilotUsage: JsonRecord | null
  errorMessage: string | null
  events: Array<ResponsesStreamEvent>
  isPartial: boolean
  reasoningText: string
  response: JsonRecord | null
  status: string | null
  toolCalls: Array<ParsedToolCall>
  usage: JsonRecord | null
}

interface ParsedFrame {
  data: JsonValue
  event?: string
  rawData: string
}

const TERMINAL_EVENT_TYPES = new Set([
  "error",
  "response.cancelled",
  "response.completed",
  "response.failed",
  "response.incomplete",
])

const TERMINAL_RESPONSE_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "incomplete",
])

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

function parseJson(value: string): JsonValue | null {
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return null
  }
}

function isSeparator(line: string): boolean {
  return line.replaceAll(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim() === ""
}

function parseSseFrames(raw: string): Array<ParsedFrame> {
  const frames: Array<ParsedFrame> = []
  let dataLines: Array<string> = []
  let event: string | undefined

  function flush(): void {
    if (dataLines.length === 0) {
      event = undefined
      return
    }

    const rawData = dataLines.join("\n")
    if (rawData.trim() === "[DONE]") {
      frames.push({ data: "[DONE]", event: event ?? "done", rawData })
      dataLines = []
      event = undefined
      return
    }
    const data = parseJson(rawData)
    if (data !== null) frames.push({ data, event, rawData })
    dataLines = []
    event = undefined
  }

  for (const line of raw
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")) {
    if (isSeparator(line)) {
      flush()
      continue
    }
    if (line === "json" || line.startsWith(":")) continue

    const separatorIndex = line.indexOf(":")
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    if (field === "event") event = value
    else if (field === "data") dataLines.push(value)
  }
  flush()

  return frames
}

function looksLikeResponse(value: JsonRecord): boolean {
  return value.object === "response"
}

function looksLikeResponsesEvent(value: JsonRecord): boolean {
  const type = stringValue(value.type)
  return (
    type === "error"
    || type?.startsWith("response.") === true
    || (isRecord(value.response) && looksLikeResponse(value.response))
  )
}

function looksLikeChatCompletion(value: JsonRecord): boolean {
  if (!Array.isArray(value.choices)) return false
  if (
    value.object === "chat.completion"
    || value.object === "chat.completion.chunk"
  ) {
    return true
  }
  if (typeof value.id !== "string" || typeof value.model !== "string") {
    return false
  }
  if (value.choices.length === 0) {
    return isRecord(value.usage) || isRecord(value.copilot_usage)
  }
  return value.choices.some(
    (choice) =>
      isRecord(choice) && (isRecord(choice.delta) || isRecord(choice.message)),
  )
}

function directJsonFrame(raw: string): ParsedFrame | null {
  const data = parseJson(raw.trim())
  if (!isRecord(data)) return null
  if (looksLikeResponsesEvent(data)) {
    return { data, event: stringValue(data.type), rawData: raw.trim() }
  }
  if (looksLikeResponse(data)) {
    return { data, event: "response", rawData: raw.trim() }
  }
  if (looksLikeChatCompletion(data)) {
    return {
      data,
      event: stringValue(data.object) ?? "chat.completion",
      rawData: raw.trim(),
    }
  }
  if (looksLikeAnthropicMessage(data)) {
    return { data, event: "message", rawData: raw.trim() }
  }
  return null
}

function eventType(frame: ParsedFrame): string {
  if (frame.event) return frame.event
  if (frame.data === "[DONE]") return "done"
  if (isRecord(frame.data) && typeof frame.data.type === "string") {
    return frame.data.type
  }
  if (isRecord(frame.data) && typeof frame.data.object === "string") {
    return frame.data.object
  }
  if (isRecord(frame.data) && Array.isArray(frame.data.choices)) {
    return "chat.completion.chunk"
  }
  if (isRecord(frame.data) && isRecord(frame.data.error)) return "error"
  return "response"
}

function eventSequence(frame: ParsedFrame): number | undefined {
  return isRecord(frame.data) ?
      numberValue(frame.data.sequence_number)
    : undefined
}

function responseFromFrame(frame: ParsedFrame): JsonRecord | null {
  if (!isRecord(frame.data)) return null
  if (isRecord(frame.data.response)) return frame.data.response
  return looksLikeResponse(frame.data) ? frame.data : null
}

function extractTextFromMessage(item: JsonRecord): string {
  if (!Array.isArray(item.content)) return ""
  return item.content
    .filter((part) => isRecord(part))
    .filter(
      (part) =>
        part.type === "output_text"
        || part.type === "refusal"
        || typeof part.text === "string"
        || typeof part.refusal === "string",
    )
    .map((part) => stringValue(part.text) ?? stringValue(part.refusal) ?? "")
    .join("")
}

function extractAssistantFromResponse(response: JsonRecord | null): string {
  if (!response) return ""
  const topLevelText = stringValue(response.output_text)
  if (topLevelText) return topLevelText
  if (!Array.isArray(response.output)) return ""

  return response.output
    .filter((item) => isRecord(item))
    .filter((item) => item.type === "message")
    .map((item) => extractTextFromMessage(item))
    .filter(Boolean)
    .join("\n\n")
}

function summaryText(item: JsonRecord): string {
  if (!Array.isArray(item.summary)) return ""
  return item.summary
    .filter((part) => isRecord(part))
    .map((part) => stringValue(part.text) ?? "")
    .filter(Boolean)
    .join("\n\n")
}

function extractReasoningFromResponse(response: JsonRecord | null): string {
  if (!response || !Array.isArray(response.output)) return ""
  return response.output
    .filter((item) => isRecord(item))
    .filter((item) => item.type === "reasoning")
    .map((item) => summaryText(item))
    .filter(Boolean)
    .join("\n\n")
}

function eventPartKey(data: JsonRecord, index: number): string {
  const outputIndex = numberValue(data.output_index)
  const contentIndex = numberValue(data.content_index)
  const summaryIndex = numberValue(data.summary_index)
  if (
    outputIndex !== undefined
    || contentIndex !== undefined
    || summaryIndex !== undefined
  ) {
    return `${outputIndex ?? 0}:${contentIndex ?? 0}:${summaryIndex ?? 0}`
  }
  return stringValue(data.item_id) ?? `event-${index}`
}

function assembleEventText(
  frames: Array<ParsedFrame>,
  types: { delta: string; done: string; doneField?: "refusal" | "text" },
): string {
  const order: Array<string> = []
  const done = new Map<string, string>()
  const deltas = new Map<string, string>()

  for (const [index, frame] of frames.entries()) {
    if (!isRecord(frame.data)) continue
    const type = eventType(frame)
    if (type !== types.done && type !== types.delta) continue
    const key = eventPartKey(frame.data, index)
    if (!order.includes(key)) order.push(key)

    if (type === types.done) {
      const value = stringValue(frame.data[types.doneField ?? "text"])
      if (value !== undefined) done.set(key, value)
    } else {
      const value = stringValue(frame.data.delta)
      if (value !== undefined)
        deltas.set(key, `${deltas.get(key) ?? ""}${value}`)
    }
  }

  return order
    .map((key) => done.get(key) ?? deltas.get(key) ?? "")
    .filter(Boolean)
    .join("\n\n")
}

function assembleAssistantEvents(frames: Array<ParsedFrame>): string {
  const outputText = assembleEventText(frames, {
    delta: "response.output_text.delta",
    done: "response.output_text.done",
  })
  const refusal = assembleEventText(frames, {
    delta: "response.refusal.delta",
    done: "response.refusal.done",
    doneField: "refusal",
  })
  return [outputText, refusal].filter(Boolean).join("\n\n")
}

function extractDoneItems(
  frames: Array<ParsedFrame>,
  expectedType: "message" | "reasoning",
): string {
  const items = frames
    .filter((frame) => eventType(frame) === "response.output_item.done")
    .map((frame) => (isRecord(frame.data) ? frame.data.item : undefined))
    .filter((item) => isRecord(item))
    .filter((item) => item.type === expectedType)

  return items
    .map((item) =>
      expectedType === "message" ?
        extractTextFromMessage(item)
      : summaryText(item),
    )
    .filter(Boolean)
    .join(expectedType === "message" ? "\n\n" : "\n\n")
}

function frameRank(frame: ParsedFrame, index: number): number {
  return eventSequence(frame) ?? index
}

function chatChoiceRecords(data: JsonRecord): Array<JsonRecord> {
  if (!Array.isArray(data.choices)) return []
  return data.choices.filter((choice) => isRecord(choice))
}

function chatText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .filter((part) => isRecord(part))
    .map(
      (part) =>
        stringValue(part.text)
        ?? stringValue(part.content)
        ?? stringValue(part.refusal)
        ?? "",
    )
    .join("")
}

function chatReasoning(message: JsonRecord): string {
  return (
    stringValue(message.reasoning_text)
    ?? stringValue(message.reasoning_content)
    ?? ""
  )
}

function normalizeChatUsage(value: JsonValue | undefined): JsonRecord | null {
  if (!isRecord(value)) return null
  const inputTokens =
    numberValue(value.prompt_tokens) ?? numberValue(value.input_tokens)
  const outputTokens =
    numberValue(value.completion_tokens) ?? numberValue(value.output_tokens)
  const totalTokens = numberValue(value.total_tokens)
  const promptDetails =
    isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null
  const completionDetails =
    isRecord(value.completion_tokens_details) ?
      value.completion_tokens_details
    : null

  const usage: JsonRecord = {}
  if (inputTokens !== undefined) usage.input_tokens = inputTokens
  if (outputTokens !== undefined) usage.output_tokens = outputTokens
  if (totalTokens !== undefined) usage.total_tokens = totalTokens
  if (promptDetails) {
    const cachedTokens = numberValue(promptDetails.cached_tokens)
    if (cachedTokens !== undefined) {
      usage.input_tokens_details = { cached_tokens: cachedTokens }
    }
  }
  if (completionDetails) {
    usage.output_tokens_details = completionDetails
  }
  return Object.keys(usage).length > 0 ? usage : null
}

interface ChatResponseSummary {
  errorMessage: string | null
  finishReason: string | null
  status: string
  toolCallCount: number
}

function chatResponseMetadata(
  metadata: JsonRecord,
  summary: ChatResponseSummary,
): JsonRecord {
  const response: JsonRecord = {
    object: stringValue(metadata.object) ?? "chat.completion",
    status: summary.status,
  }
  const id = stringValue(metadata.id)
  const model = stringValue(metadata.model)
  const created = numberValue(metadata.created)
  const serviceTier = stringValue(metadata.service_tier)
  const systemFingerprint = stringValue(metadata.system_fingerprint)
  if (id) response.id = id
  if (model) response.model = model
  if (created !== undefined) response.created_at = created
  if (serviceTier) response.service_tier = serviceTier
  if (systemFingerprint) response.system_fingerprint = systemFingerprint
  if (summary.finishReason) response.finish_reason = summary.finishReason
  if (summary.errorMessage) response.error_message = summary.errorMessage
  if (summary.toolCallCount > 0) {
    response.tool_call_count = summary.toolCallCount
  }
  return response
}

function mergeChatMetadata(target: JsonRecord, data: JsonRecord): void {
  const id = stringValue(data.id)
  const object = stringValue(data.object)
  const model = stringValue(data.model)
  const created = numberValue(data.created)
  const serviceTier = stringValue(data.service_tier)
  const systemFingerprint = stringValue(data.system_fingerprint)
  if (id) target.id = id
  if (object) target.object = object
  if (model) target.model = model
  if (created !== undefined) target.created = created
  if (serviceTier) target.service_tier = serviceTier
  if (systemFingerprint) target.system_fingerprint = systemFingerprint
}

function chatErrorMessage(data: JsonRecord): string | null {
  if (!isRecord(data.error)) return null
  return (
    stringValue(data.error.message)
    ?? stringValue(data.error.code)
    ?? "The stream ended with an error."
  )
}

// Chat Completions uses choices[].delta instead of response.* event objects.
// Its metadata and terminal markers can arrive in separate chunks.
// eslint-disable-next-line complexity, max-lines-per-function
function parseChatCompletionFrames(
  parsedFrames: Array<ParsedFrame>,
): ParsedResponsesBody | null {
  const hasChatFrame = parsedFrames.some(
    (frame) => isRecord(frame.data) && looksLikeChatCompletion(frame.data),
  )
  if (!hasChatFrame) return null

  const frames = parsedFrames.filter(
    (frame) => frame.data === "[DONE]" || isRecord(frame.data),
  )
  const recordFrames = frames.flatMap((frame) =>
    isRecord(frame.data) ? [frame.data] : [],
  )
  const toolCalls = collectChatToolCalls(recordFrames)
  const assistantByChoice = new Map<number, string>()
  const reasoningByChoice = new Map<number, string>()
  const metadata: JsonRecord = {}
  let foundChatData = false
  let usage: JsonRecord | null = null
  let copilotUsage: JsonRecord | null = null
  let finishReason: string | null = null
  let errorMessage: string | null = null
  let hasTerminalMarker = false

  for (const frame of frames) {
    if (frame.data === "[DONE]") {
      hasTerminalMarker = true
      continue
    }
    if (!isRecord(frame.data)) continue
    const isChatData = looksLikeChatCompletion(frame.data)
    if (isChatData) foundChatData = true
    mergeChatMetadata(metadata, frame.data)
    usage = normalizeChatUsage(frame.data.usage) ?? usage
    if (isRecord(frame.data.copilot_usage)) {
      copilotUsage = frame.data.copilot_usage
    }
    const frameError = chatErrorMessage(frame.data)
    if (frameError) {
      errorMessage = frameError
      hasTerminalMarker = true
    }
    if (frame.data.object === "chat.completion") hasTerminalMarker = true

    for (const choice of chatChoiceRecords(frame.data)) {
      const choiceIndex = numberValue(choice.index) ?? 0
      const delta = isRecord(choice.delta) ? choice.delta : null
      const message = isRecord(choice.message) ? choice.message : null
      const content = chatText(
        delta?.content
          ?? delta?.refusal
          ?? message?.content
          ?? message?.refusal,
      )
      let reasoning = ""
      if (delta) reasoning = chatReasoning(delta)
      else if (message) reasoning = chatReasoning(message)
      if (content) {
        const current =
          message ? "" : (assistantByChoice.get(choiceIndex) ?? "")
        assistantByChoice.set(choiceIndex, `${current}${content}`)
      }
      if (reasoning) {
        const current =
          message ? "" : (reasoningByChoice.get(choiceIndex) ?? "")
        reasoningByChoice.set(choiceIndex, `${current}${reasoning}`)
      }
      const choiceFinishReason = stringValue(choice.finish_reason)
      if (choiceFinishReason) {
        finishReason = choiceFinishReason
        hasTerminalMarker = true
      }
    }
  }

  if (!foundChatData) return null
  let status = "in_progress"
  if (errorMessage) status = "error"
  else if (hasTerminalMarker) status = "completed"
  const joinChoices = (values: Map<number, string>) =>
    [...values.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .filter(Boolean)
      .join("\n\n")

  return {
    assistantText: joinChoices(assistantByChoice),
    copilotUsage,
    errorMessage,
    events: frames.map((frame) => ({
      data: frame.data,
      rawData: frame.rawData,
      type: eventType(frame),
    })),
    isPartial: !hasTerminalMarker,
    reasoningText: joinChoices(reasoningByChoice),
    response: chatResponseMetadata(metadata, {
      errorMessage,
      finishReason,
      status,
      toolCallCount: toolCalls.length,
    }),
    status,
    toolCalls,
    usage,
  }
}

function errorText(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value
  if (!isRecord(value)) return null
  return (
    stringValue(value.message)
    ?? stringValue(value.code)
    ?? stringValue(value.type)
    ?? null
  )
}

function responseErrorMessage(
  response: JsonRecord | null,
  frames: Array<ParsedFrame>,
): string | null {
  const responseError = response ? errorText(response.error) : null
  if (responseError) return responseError

  for (const frame of [...frames].reverse()) {
    if (!isRecord(frame.data)) continue
    const frameError =
      errorText(frame.data.error)
      ?? (eventType(frame) === "error" ? errorText(frame.data) : null)
    if (frameError) return frameError
  }
  return null
}

// The capture format has several optional fallbacks; keep its branches local.
// eslint-disable-next-line complexity
export function parseResponsesBody(raw: string): ParsedResponsesBody | null {
  const direct = directJsonFrame(raw)
  const parsedFrames = direct ? [direct] : parseSseFrames(raw)
  const anthropicMessage = parseAnthropicBody(parsedFrames)
  if (anthropicMessage) return anthropicMessage
  const chatCompletion = parseChatCompletionFrames(parsedFrames)
  if (chatCompletion) return chatCompletion
  const frames = parsedFrames.filter((frame) => {
    if (!isRecord(frame.data)) return false
    return looksLikeResponsesEvent(frame.data) || looksLikeResponse(frame.data)
  })
  if (frames.length === 0) return null

  let latestResponse: JsonRecord | null = null
  let latestResponseRank = Number.NEGATIVE_INFINITY
  let terminalResponse: JsonRecord | null = null
  let terminalRank = Number.NEGATIVE_INFINITY
  let hasTerminalEvent = false
  let copilotUsage: JsonRecord | null = null

  for (const [index, frame] of frames.entries()) {
    if (isRecord(frame.data) && isRecord(frame.data.copilot_usage)) {
      copilotUsage = frame.data.copilot_usage
    }

    const response = responseFromFrame(frame)
    const rank = frameRank(frame, index)
    if (response && rank >= latestResponseRank) {
      latestResponse = response
      latestResponseRank = rank
    }

    const type = eventType(frame)
    const responseStatus = response ? stringValue(response.status) : undefined
    const terminal =
      TERMINAL_EVENT_TYPES.has(type)
      || (responseStatus !== undefined
        && TERMINAL_RESPONSE_STATUSES.has(responseStatus))
    if (terminal) {
      hasTerminalEvent = true
      if (response && rank >= terminalRank) {
        terminalResponse = response
        terminalRank = rank
      }
    }
  }

  const response = terminalResponse ?? latestResponse
  const responseStatus = response ? stringValue(response.status) : undefined
  const status =
    responseStatus
    ?? [...frames]
      .reverse()
      .map((frame) => eventType(frame))
      .find((type) => type === "error" || type.startsWith("response."))
      ?.replace(/^response\./, "")
    ?? null

  let assistantText = extractAssistantFromResponse(response)
  if (!assistantText) {
    assistantText = assembleAssistantEvents(frames)
  }
  if (!assistantText) assistantText = extractDoneItems(frames, "message")

  let reasoningText = extractReasoningFromResponse(response)
  if (!reasoningText) {
    reasoningText = assembleEventText(frames, {
      delta: "response.reasoning_summary_text.delta",
      done: "response.reasoning_summary_text.done",
    })
  }
  if (!reasoningText) reasoningText = extractDoneItems(frames, "reasoning")

  const events = frames.map((frame) => ({
    data: frame.data,
    rawData: frame.rawData,
    ...(eventSequence(frame) === undefined ?
      {}
    : {
        sequenceNumber: eventSequence(frame),
      }),
    type: eventType(frame),
  }))
  const toolCalls = collectResponsesToolCalls(
    response,
    frames.map((frame) => ({ data: frame.data, type: eventType(frame) })),
  )
  const errorMessage = responseErrorMessage(response, frames)

  return {
    assistantText,
    copilotUsage,
    errorMessage,
    events,
    isPartial: !hasTerminalEvent,
    reasoningText,
    response,
    status,
    toolCalls,
    usage: response && isRecord(response.usage) ? response.usage : null,
  }
}
