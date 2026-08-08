import type { JsonValue } from "./json-tree"
import type { ParsedToolCall } from "./response-tool-calls"

type JsonRecord = { [key: string]: JsonValue }

export interface AnthropicBodyFrame {
  data: JsonValue
  event?: string
  rawData: string
}

interface ParsedAnthropicBody {
  assistantText: string
  copilotUsage: JsonRecord | null
  errorMessage: string | null
  events: Array<{
    data: JsonValue
    rawData: string
    type: string
  }>
  isPartial: boolean
  reasoningText: string
  response: JsonRecord
  status: string
  toolCalls: Array<ParsedToolCall>
  usage: JsonRecord | null
}

interface AnthropicToolCall {
  arguments: string
  callId: string | null
  index: number
  name: string | null
}

interface AnthropicAccumulator {
  copilotUsage: JsonRecord | null
  hasMessageStop: boolean
  response: JsonRecord
  stopReason: string | undefined
  stopSequence: string | null | undefined
  terminalError: string | null
  textBlocks: Map<number, string>
  thinkingBlocks: Map<number, string>
  toolCalls: Map<number, AnthropicToolCall>
  usage: JsonRecord | null
}

const ANTHROPIC_STREAM_ANCHOR_TYPES = new Set([
  "content_block_delta",
  "content_block_start",
  "message_delta",
  "message_start",
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

function errorMessage(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value
  if (!isRecord(value)) return null
  return (
    stringValue(value.message)
    ?? stringValue(value.code)
    ?? stringValue(value.type)
    ?? null
  )
}

function frameType(frame: AnthropicBodyFrame): string {
  if (frame.event) return frame.event
  if (frame.data === "[DONE]") return "done"
  if (isRecord(frame.data)) return stringValue(frame.data.type) ?? "message"
  return "message"
}

function normalizeUsage(value: JsonRecord): JsonRecord {
  const usage: JsonRecord = { ...value }
  const cachedTokens = numberValue(usage.cache_read_input_tokens)
  const cacheWriteTokens = numberValue(usage.cache_creation_input_tokens)
  if (cachedTokens === undefined && cacheWriteTokens === undefined) return usage

  const inputDetails: JsonRecord = {}
  if (cachedTokens !== undefined) inputDetails.cached_tokens = cachedTokens
  if (cacheWriteTokens !== undefined) {
    inputDetails.cache_write_tokens = cacheWriteTokens
  }
  usage.input_tokens_details = inputDetails
  return usage
}

function mergeUsage(
  current: JsonRecord | null,
  value: JsonValue | undefined,
): JsonRecord | null {
  if (!isRecord(value)) return current
  return normalizeUsage(current ? { ...current, ...value } : { ...value })
}

function appendBlockText(
  blocks: Map<number, string>,
  index: number,
  text: string | undefined,
): void {
  if (text === undefined) return
  blocks.set(index, `${blocks.get(index) ?? ""}${text}`)
}

function assembledText(blocks: Map<number, string>): string {
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .filter(Boolean)
    .join("\n\n")
}

function parseArguments(value: string): JsonValue | null {
  if (value.length === 0) return null
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return null
  }
}

function finishToolCalls(
  calls: Map<number, AnthropicToolCall>,
): Array<ParsedToolCall> {
  return [...calls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      arguments: call.arguments,
      argumentsJson: parseArguments(call.arguments),
      callId: call.callId,
      id: null,
      name: call.name,
      outputIndex: call.index,
    }))
}

function initialAccumulator(): AnthropicAccumulator {
  return {
    copilotUsage: null,
    hasMessageStop: false,
    response: {},
    stopReason: undefined,
    stopSequence: undefined,
    terminalError: null,
    textBlocks: new Map(),
    thinkingBlocks: new Map(),
    toolCalls: new Map(),
    usage: null,
  }
}

function addContentBlock(
  state: AnthropicAccumulator,
  block: JsonRecord,
  index: number,
): void {
  switch (block.type) {
    case "text": {
      appendBlockText(state.textBlocks, index, stringValue(block.text))
      break
    }
    case "thinking": {
      appendBlockText(state.thinkingBlocks, index, stringValue(block.thinking))
      break
    }
    case "tool_use": {
      state.toolCalls.set(index, {
        arguments: isRecord(block.input) ? JSON.stringify(block.input) : "",
        callId: stringValue(block.id) ?? null,
        index,
        name: stringValue(block.name) ?? null,
      })
      break
    }
    default: {
      break
    }
  }
}

function addContentDelta(
  state: AnthropicAccumulator,
  delta: JsonRecord,
  index: number,
): void {
  switch (delta.type) {
    case "text_delta": {
      appendBlockText(state.textBlocks, index, stringValue(delta.text))
      break
    }
    case "thinking_delta": {
      appendBlockText(state.thinkingBlocks, index, stringValue(delta.thinking))
      break
    }
    case "input_json_delta": {
      const toolCall = state.toolCalls.get(index)
      const fragment = stringValue(delta.partial_json)
      if (!toolCall || fragment === undefined) break
      if (toolCall.arguments === "{}") toolCall.arguments = ""
      toolCall.arguments += fragment
      break
    }
    default: {
      break
    }
  }
}

function applyMetadataFrame(
  state: AnthropicAccumulator,
  data: JsonRecord,
  type: string,
): void {
  if (isRecord(data.copilot_usage)) state.copilotUsage = data.copilot_usage

  switch (type) {
    case "message_start": {
      if (!isRecord(data.message)) break
      state.response = { ...data.message }
      state.usage = mergeUsage(state.usage, data.message.usage)
      break
    }
    case "message_delta": {
      state.usage = mergeUsage(state.usage, data.usage)
      if (isRecord(data.delta)) {
        state.stopReason =
          stringValue(data.delta.stop_reason) ?? state.stopReason
        if (
          typeof data.delta.stop_sequence === "string"
          || data.delta.stop_sequence === null
        ) {
          state.stopSequence = data.delta.stop_sequence
        }
      }
      break
    }
    case "message_stop": {
      state.hasMessageStop = true
      break
    }
    case "error": {
      state.terminalError = errorMessage(data.error) ?? errorMessage(data)
      break
    }
    default: {
      break
    }
  }
}

function applyContentFrame(
  state: AnthropicAccumulator,
  data: JsonRecord,
  type: string,
): void {
  const index = numberValue(data.index) ?? 0
  switch (type) {
    case "content_block_start": {
      if (isRecord(data.content_block)) {
        addContentBlock(state, data.content_block, index)
      }
      break
    }
    case "content_block_delta": {
      if (isRecord(data.delta)) addContentDelta(state, data.delta, index)
      break
    }
    default: {
      break
    }
  }
}

function completedStatus(state: AnthropicAccumulator): string {
  if (state.terminalError) return "error"
  return state.hasMessageStop ? "completed" : "in_progress"
}

function finishParsedBody(
  frames: Array<AnthropicBodyFrame>,
  state: AnthropicAccumulator,
): ParsedAnthropicBody {
  const status = completedStatus(state)
  const toolCalls = finishToolCalls(state.toolCalls)
  const response: JsonRecord = {
    ...state.response,
    object: "message",
    status,
  }
  if (state.stopReason !== undefined) {
    response.finish_reason = state.stopReason
    response.stop_reason = state.stopReason
  }
  if (state.stopSequence !== undefined) {
    response.stop_sequence = state.stopSequence
  }
  if (toolCalls.length > 0) response.tool_call_count = toolCalls.length

  return {
    assistantText: assembledText(state.textBlocks),
    copilotUsage: state.copilotUsage,
    errorMessage: state.terminalError,
    events: frames.map((frame) => ({
      data: frame.data,
      rawData: frame.rawData,
      type: frameType(frame),
    })),
    isPartial: !state.hasMessageStop && state.terminalError === null,
    reasoningText: assembledText(state.thinkingBlocks),
    response,
    status,
    toolCalls,
    usage: state.usage,
  }
}

function parseDirectMessage(
  frame: AnthropicBodyFrame,
  message: JsonRecord,
): ParsedAnthropicBody {
  const state = initialAccumulator()
  state.response = { ...message }
  state.hasMessageStop = true
  state.stopReason = stringValue(message.stop_reason)
  if (
    typeof message.stop_sequence === "string"
    || message.stop_sequence === null
  ) {
    state.stopSequence = message.stop_sequence
  }
  if (isRecord(message.copilot_usage)) {
    state.copilotUsage = message.copilot_usage
  }
  state.usage = mergeUsage(null, message.usage)
  if (Array.isArray(message.content)) {
    for (const [index, block] of message.content.entries()) {
      if (isRecord(block)) addContentBlock(state, block, index)
    }
  }
  return finishParsedBody([frame], state)
}

export function looksLikeAnthropicMessage(value: JsonRecord): boolean {
  return (
    value.type === "message"
    && value.role === "assistant"
    && typeof value.id === "string"
    && Array.isArray(value.content)
  )
}

function isAnthropicBlockFrame(frame: AnthropicBodyFrame): boolean {
  if (!isRecord(frame.data)) return false
  const type = frameType(frame)
  if (type !== "content_block_start" && type !== "content_block_delta") {
    return false
  }
  const block =
    type === "content_block_start" ? frame.data.content_block : frame.data.delta
  return (
    stringValue(frame.data.type) === type
    && numberValue(frame.data.index) !== undefined
    && isRecord(block)
    && typeof block.type === "string"
  )
}

function looksLikeAnthropicStreamFrame(frame: AnthropicBodyFrame): boolean {
  if (!isRecord(frame.data) || Array.isArray(frame.data.choices)) return false
  const type = frameType(frame)
  if (!ANTHROPIC_STREAM_ANCHOR_TYPES.has(type)) return false
  if (stringValue(frame.data.type) !== type) return false

  switch (type) {
    case "message_start": {
      return (
        isRecord(frame.data.message)
        && frame.data.message.type === "message"
        && frame.data.message.role === "assistant"
        && Array.isArray(frame.data.message.content)
      )
    }
    case "content_block_start":
    case "content_block_delta": {
      return isAnthropicBlockFrame(frame)
    }
    case "message_delta": {
      return isRecord(frame.data.delta) && isRecord(frame.data.usage)
    }
    default: {
      return false
    }
  }
}

function hasChatCompletionFrame(frames: Array<AnthropicBodyFrame>): boolean {
  return frames.some(
    (frame) => isRecord(frame.data) && Array.isArray(frame.data.choices),
  )
}

export function parseAnthropicBody(
  frames: Array<AnthropicBodyFrame>,
): ParsedAnthropicBody | null {
  if (hasChatCompletionFrame(frames)) return null

  for (const frame of frames) {
    if (isRecord(frame.data) && looksLikeAnthropicMessage(frame.data)) {
      return parseDirectMessage(frame, frame.data)
    }
  }

  if (!frames.some((frame) => looksLikeAnthropicStreamFrame(frame))) {
    return null
  }

  const state = initialAccumulator()
  for (const frame of frames) {
    if (!isRecord(frame.data)) continue
    const type = frameType(frame)
    applyMetadataFrame(state, frame.data, type)
    applyContentFrame(state, frame.data, type)
  }
  return finishParsedBody(frames, state)
}
