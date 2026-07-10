import type { JsonValue } from "./json-tree"

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
  events: Array<ResponsesStreamEvent>
  isPartial: boolean
  reasoningText: string
  response: JsonRecord | null
  status: string | null
  toolCallCount: number
  usage: JsonRecord | null
}

interface ParsedFrame {
  data: JsonValue
  event?: string
  rawData: string
}

const TERMINAL_EVENT_TYPES = new Set([
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
  return (
    value.object === "response"
    || Array.isArray(value.output)
    || typeof value.output_text === "string"
  )
}

function looksLikeResponsesEvent(value: JsonRecord): boolean {
  const type = stringValue(value.type)
  return (
    type?.startsWith("response.") === true
    || (isRecord(value.response) && looksLikeResponse(value.response))
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
  return null
}

function eventType(frame: ParsedFrame): string {
  if (frame.event) return frame.event
  if (isRecord(frame.data) && typeof frame.data.type === "string") {
    return frame.data.type
  }
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

// Response snapshots and partial stream events use different call shapes.
// eslint-disable-next-line complexity
function countToolCalls(
  response: JsonRecord | null,
  frames: Array<ParsedFrame>,
): number {
  const ids = new Set<string>()
  if (response && Array.isArray(response.output)) {
    for (const [index, item] of response.output.entries()) {
      if (
        !isRecord(item)
        || typeof item.type !== "string"
        || (item.type !== "function_call" && !item.type.endsWith("_call"))
      ) {
        continue
      }
      ids.add(
        stringValue(item.call_id)
          ?? stringValue(item.id)
          ?? `response-${index}`,
      )
    }
  }

  for (const [index, frame] of frames.entries()) {
    if (!isRecord(frame.data)) continue
    const item = isRecord(frame.data.item) ? frame.data.item : null
    if (
      !item
      || typeof item.type !== "string"
      || (item.type !== "function_call" && !item.type.endsWith("_call"))
    ) {
      continue
    }
    ids.add(
      stringValue(item.call_id)
        ?? stringValue(item.id)
        ?? `${numberValue(frame.data.output_index) ?? index}`,
    )
  }
  return ids.size
}

function frameRank(frame: ParsedFrame, index: number): number {
  return eventSequence(frame) ?? index
}

// The capture format has several optional fallbacks; keep its branches local.
// eslint-disable-next-line complexity
export function parseResponsesBody(raw: string): ParsedResponsesBody | null {
  const direct = directJsonFrame(raw)
  const parsedFrames = direct ? [direct] : parseSseFrames(raw)
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
      .find((type) => type.startsWith("response."))
      ?.slice("response.".length)
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

  return {
    assistantText,
    copilotUsage,
    events,
    isPartial: !hasTerminalEvent,
    reasoningText,
    response,
    status,
    toolCallCount: countToolCalls(response, frames),
    usage: response && isRecord(response.usage) ? response.usage : null,
  }
}
