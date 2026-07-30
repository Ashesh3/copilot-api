import type { JsonValue } from "./json-tree"

type JsonRecord = { [key: string]: JsonValue }

export interface ParsedToolCall {
  arguments: string
  argumentsJson: JsonValue | null
  callId: string | null
  id: string | null
  name: string | null
  outputIndex: number
}

export interface ResponseToolCallFrame {
  data: JsonValue
  type: string
}

interface MutableToolCall {
  arguments: string
  argumentsDone: boolean
  callId: string | null
  id: string | null
  name: string | null
  order: number
  outputIndex: number
}

interface ToolCallIdentity {
  callId: string | null
  id: string | null
  outputIndex: number
}

const TOOL_CALL_ITEM_TYPES = new Set([
  "computer_call",
  "custom_tool_call",
  "file_search_call",
  "function_call",
  "mcp_call",
  "web_search_call",
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

function isToolCallItem(item: JsonRecord): boolean {
  const type = stringValue(item.type)
  return type !== undefined && TOOL_CALL_ITEM_TYPES.has(type)
}

function parseArguments(value: string): JsonValue | null {
  if (value.length === 0) return null
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return null
  }
}

function ensureCall(
  calls: Array<MutableToolCall>,
  identity: ToolCallIdentity,
): MutableToolCall {
  let call =
    identity.id === null ?
      undefined
    : calls.find((item) => item.id === identity.id)
  call ??=
    identity.callId === null ?
      undefined
    : calls.find((item) => item.callId === identity.callId)
  call ??= calls.find((item) => item.outputIndex === identity.outputIndex)

  if (!call) {
    call = {
      arguments: "",
      argumentsDone: false,
      callId: identity.callId,
      id: identity.id,
      name: null,
      order: calls.length,
      outputIndex: identity.outputIndex,
    }
    calls.push(call)
    return call
  }

  call.id ??= identity.id
  call.callId ??= identity.callId
  return call
}

function mergeArguments(
  call: MutableToolCall,
  value: string | undefined,
  authoritative: boolean,
): void {
  if (value === undefined) return
  if (authoritative) {
    call.arguments = value
    call.argumentsDone = true
  } else if (!call.argumentsDone) {
    call.arguments += value
  }
}

function mergeItem(
  call: MutableToolCall,
  item: JsonRecord,
  authoritativeArguments: boolean,
): void {
  const functionData = isRecord(item.function) ? item.function : null
  call.id ??= stringValue(item.id) ?? null
  call.callId ??= stringValue(item.call_id) ?? null
  call.name ??=
    stringValue(functionData?.name) ?? stringValue(item.name) ?? null
  mergeArguments(
    call,
    stringValue(functionData?.arguments) ?? stringValue(item.arguments),
    authoritativeArguments,
  )
}

function finishCall(call: MutableToolCall): ParsedToolCall {
  return {
    arguments: call.arguments,
    argumentsJson: parseArguments(call.arguments),
    callId: call.callId,
    id: call.id,
    name: call.name,
    outputIndex: call.outputIndex,
  }
}

function responseItemIdentity(
  data: JsonRecord,
  item: JsonRecord | null,
  outputIndex: number,
): ToolCallIdentity {
  return {
    callId: stringValue(item?.call_id) ?? stringValue(data.call_id) ?? null,
    id: stringValue(item?.id) ?? stringValue(data.item_id) ?? null,
    outputIndex,
  }
}

// Responses streams expose tool calls through several complementary event shapes.
// eslint-disable-next-line complexity
export function collectResponsesToolCalls(
  response: JsonRecord | null,
  frames: Array<ResponseToolCallFrame>,
): Array<ParsedToolCall> {
  const calls: Array<MutableToolCall> = []

  for (const [frameIndex, frame] of frames.entries()) {
    if (!isRecord(frame.data)) continue
    const data = frame.data
    const candidateItem = isRecord(data.item) ? data.item : null
    const item =
      candidateItem && isToolCallItem(candidateItem) ? candidateItem : null
    const argumentsEvent =
      frame.type === "response.function_call_arguments.delta"
      || frame.type === "response.function_call_arguments.done"
    if (!item && !argumentsEvent) continue

    const outputIndex =
      numberValue(data.output_index)
      ?? numberValue(item?.output_index)
      ?? frameIndex
    const call = ensureCall(
      calls,
      responseItemIdentity(data, item, outputIndex),
    )
    if (item) {
      mergeItem(call, item, frame.type === "response.output_item.done")
    }
    if (frame.type === "response.function_call_arguments.delta") {
      mergeArguments(call, stringValue(data.delta), false)
    } else if (frame.type === "response.function_call_arguments.done") {
      mergeArguments(call, stringValue(data.arguments), true)
    }
  }

  if (response && Array.isArray(response.output)) {
    for (const [outputIndex, candidateItem] of response.output.entries()) {
      if (!isRecord(candidateItem) || !isToolCallItem(candidateItem)) continue
      const itemOutputIndex =
        numberValue(candidateItem.output_index) ?? outputIndex
      const call = ensureCall(
        calls,
        responseItemIdentity(response, candidateItem, itemOutputIndex),
      )
      mergeItem(call, candidateItem, true)
    }
  }

  return [...calls]
    .sort(
      (left, right) =>
        left.outputIndex - right.outputIndex || left.order - right.order,
    )
    .map((call) => finishCall(call))
}

// Chat Completions may split one indexed tool call across multiple choice deltas.
// eslint-disable-next-line complexity
export function collectChatToolCalls(
  frames: Array<JsonValue>,
): Array<ParsedToolCall> {
  const calls: Array<MutableToolCall> = []
  const callsByKey = new Map<string, MutableToolCall>()

  for (const frame of frames) {
    if (!isRecord(frame) || !Array.isArray(frame.choices)) continue
    for (const choiceValue of frame.choices) {
      if (!isRecord(choiceValue)) continue
      const choiceIndex = numberValue(choiceValue.index) ?? 0
      const message = isRecord(choiceValue.message) ? choiceValue.message : null
      const delta = isRecord(choiceValue.delta) ? choiceValue.delta : null
      const source = message ?? delta
      if (!source || !Array.isArray(source.tool_calls)) continue

      for (const [listIndex, toolValue] of source.tool_calls.entries()) {
        if (!isRecord(toolValue)) continue
        const toolIndex = numberValue(toolValue.index) ?? listIndex
        const key = `${choiceIndex}:${toolIndex}`
        let call = callsByKey.get(key)
        if (!call) {
          call = {
            arguments: "",
            argumentsDone: false,
            callId: null,
            id: null,
            name: null,
            order: calls.length,
            outputIndex: toolIndex,
          }
          calls.push(call)
          callsByKey.set(key, call)
        }

        const functionData =
          isRecord(toolValue.function) ? toolValue.function : null
        call.id ??= stringValue(toolValue.id) ?? null
        call.callId ??= stringValue(toolValue.call_id) ?? null
        call.name ??=
          stringValue(functionData?.name) ?? stringValue(toolValue.name) ?? null
        mergeArguments(
          call,
          stringValue(functionData?.arguments)
            ?? stringValue(toolValue.arguments),
          message !== null,
        )
      }
    }
  }

  return calls.map((call) => finishCall(call))
}
