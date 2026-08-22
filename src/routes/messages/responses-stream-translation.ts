import {
  type ResponseCreatedEvent,
  type ResponseFunctionCallArgumentsDeltaEvent,
  type ResponseFunctionCallArgumentsDoneEvent,
  type ResponseOutputItemAddedEvent,
  type ResponseOutputItemDoneEvent,
  type ResponseReasoningTextDeltaEvent,
  type ResponseReasoningSummaryTextDeltaEvent,
  type ResponseReasoningSummaryTextDoneEvent,
  type ResponsesResult,
  type ResponseStreamEvent,
  type ResponseTextDeltaEvent,
  type ResponseTextDoneEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicErrorEvent,
  type AnthropicStreamEventData,
} from "./anthropic-types"
import {
  THINKING_TEXT,
  translateResponsesResultToAnthropic,
} from "./responses-translation"

export interface ResponsesStreamState {
  messageStartSent: boolean
  terminal: "open" | "succeeded" | "failed"
  nextContentBlockIndex: number
  blockIndexByKey: Map<string, number>
  openBlocks: Set<number>
  blockHasDelta: Set<number>
  functionCallStateByOutputIndex: Map<number, FunctionCallStreamState>
  pendingFailure?: AnthropicErrorEvent
}

export type FunctionCallStreamState = {
  blockIndex: number
  toolCallId: string
  name: string
  pendingArguments: Array<string>
  started?: boolean
}

export const createResponsesStreamState = (): ResponsesStreamState => ({
  messageStartSent: false,
  terminal: "open",
  nextContentBlockIndex: 0,
  blockIndexByKey: new Map(),
  openBlocks: new Set(),
  blockHasDelta: new Set(),
  functionCallStateByOutputIndex: new Map(),
})

export type ResponsesTranslationResult =
  | { kind: "events"; events: Array<AnthropicStreamEventData> }
  | { kind: "success"; response: ResponsesResult }
  | { kind: "failure"; error: AnthropicErrorEvent }

export const translateResponsesStreamEvent = (
  rawEvent: ResponseStreamEvent,
  state: ResponsesStreamState,
): ResponsesTranslationResult => {
  if (state.terminal !== "open") return { kind: "events", events: [] }
  const eventType = rawEvent.type
  switch (eventType) {
    case "response.created": {
      return translatedEvents(handleResponseCreated(rawEvent, state))
    }

    case "response.output_item.added": {
      return translatedEvents(handleOutputItemAdded(rawEvent, state))
    }

    case "response.reasoning_summary_text.delta": {
      return translatedEvents(handleReasoningSummaryTextDelta(rawEvent, state))
    }

    case "response.reasoning_text.delta": {
      return translatedEvents(handleReasoningTextDelta(rawEvent, state))
    }

    case "response.output_text.delta": {
      return translatedEvents(handleOutputTextDelta(rawEvent, state))
    }

    case "response.reasoning_summary_text.done": {
      return translatedEvents(handleReasoningSummaryTextDone(rawEvent, state))
    }

    case "response.output_text.done": {
      return translatedEvents(handleOutputTextDone(rawEvent, state))
    }
    case "response.output_item.done": {
      return translatedEvents(handleOutputItemDone(rawEvent, state))
    }

    case "response.function_call_arguments.delta": {
      return translatedStateEvents(
        state,
        handleFunctionCallArgumentsDelta(rawEvent, state),
      )
    }

    case "response.function_call_arguments.done": {
      return translatedStateEvents(
        state,
        handleFunctionCallArgumentsDone(rawEvent, state),
      )
    }

    case "response.completed":
    case "response.incomplete": {
      return { kind: "success", response: rawEvent.response }
    }

    case "response.failed": {
      return {
        kind: "failure",
        error: buildReceivedResponsesError(rawEvent.response.error),
      }
    }

    case "error": {
      return {
        kind: "failure",
        error: buildReceivedResponsesError(rawEvent),
      }
    }

    default: {
      return { kind: "events", events: [] }
    }
  }
}

const translatedEvents = (
  events: Array<AnthropicStreamEventData>,
): ResponsesTranslationResult => ({ kind: "events", events })

const translatedStateEvents = (
  state: ResponsesStreamState,
  events: Array<AnthropicStreamEventData>,
): ResponsesTranslationResult =>
  state.pendingFailure ?
    { kind: "failure", error: state.pendingFailure }
  : translatedEvents(events)

// Helper handlers to keep translateResponsesStreamEvent concise
const handleResponseCreated = (
  rawEvent: ResponseCreatedEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  return messageStart(state, rawEvent.response)
}

const handleOutputItemAdded = (
  rawEvent: ResponseOutputItemAddedEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const functionCallDetails = extractFunctionCallDetails(rawEvent)
  if (!functionCallDetails) {
    return events
  }

  const { outputIndex, toolCallId, name, initialArguments } =
    functionCallDetails
  openFunctionCallBlock(state, {
    outputIndex,
    toolCallId,
    name,
    events,
    start: initialArguments !== undefined,
  })

  if (initialArguments !== undefined && initialArguments.length > 0) {
    appendFunctionArguments(state, {
      outputIndex,
      argumentsText: initialArguments,
      events,
    })
  }

  return events
}

const handleOutputItemDone = (
  rawEvent: ResponseOutputItemDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const item = rawEvent.item
  const itemType = item.type
  if (itemType !== "reasoning") {
    return events
  }

  const outputIndex = rawEvent.output_index
  const reasoningText = extractReasoningText(item)
  const encryptedContent = item.encrypted_content
  if (!reasoningText && !encryptedContent) {
    return events
  }

  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)
  const emittedThinkingText = reasoningText || THINKING_TEXT
  if (!state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "thinking_delta",
        thinking: emittedThinkingText,
      },
    })
    state.blockHasDelta.add(blockIndex)
  }

  if (encryptedContent) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature: `${encryptedContent}@${item.id}`,
      },
    })
    state.blockHasDelta.add(blockIndex)
  }

  return events
}

const extractReasoningText = (
  item: Extract<ResponseOutputItemDoneEvent["item"], { type: "reasoning" }>,
): string => {
  const blocks = [...(item.summary ?? []), ...(item.content ?? [])]
  return blocks
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim()
}

const handleFunctionCallArgumentsDelta = (
  rawEvent: ResponseFunctionCallArgumentsDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  const deltaText = rawEvent.delta

  if (!deltaText) {
    return events
  }

  openFunctionCallBlock(state, {
    outputIndex,
    events,
  })

  const functionCallState =
    state.functionCallStateByOutputIndex.get(outputIndex)
  if (!functionCallState?.started) {
    functionCallState?.pendingArguments.push(deltaText)
    return events
  }

  appendFunctionArguments(state, {
    outputIndex,
    argumentsText: deltaText,
    events,
  })

  return events
}

const handleFunctionCallArgumentsDone = (
  rawEvent: ResponseFunctionCallArgumentsDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  openFunctionCallBlock(state, {
    outputIndex,
    name: rawEvent.name,
    events,
  })
  const functionCallState =
    state.functionCallStateByOutputIndex.get(outputIndex)
  if (!functionCallState?.started)
    return handleFunctionCallArgumentsValidationError(state, events)

  const finalArguments =
    typeof rawEvent.arguments === "string" ? rawEvent.arguments : undefined

  if (
    !state.blockHasDelta.has(functionCallState.blockIndex)
    && finalArguments
  ) {
    appendFunctionArguments(state, {
      outputIndex,
      argumentsText: finalArguments,
      events,
    })
  }

  state.functionCallStateByOutputIndex.delete(outputIndex)
  return events
}

const handleOutputTextDelta = (
  rawEvent: ResponseTextDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  const contentIndex = rawEvent.content_index
  const deltaText = rawEvent.delta

  if (!deltaText) {
    return events
  }

  const blockIndex = openTextBlockIfNeeded(state, {
    outputIndex,
    contentIndex,
    events,
  })

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "text_delta",
      text: deltaText,
    },
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

const handleReasoningSummaryTextDelta = (
  rawEvent: ResponseReasoningSummaryTextDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const outputIndex = rawEvent.output_index
  const deltaText = rawEvent.delta
  const events = new Array<AnthropicStreamEventData>()
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "thinking_delta",
      thinking: deltaText,
    },
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

const handleReasoningTextDelta = (
  rawEvent: ResponseReasoningTextDeltaEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const deltaText = rawEvent.delta
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index ?? 0
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: {
      type: "thinking_delta",
      thinking: deltaText,
    },
  })
  state.blockHasDelta.add(blockIndex)

  return events
}

const handleReasoningSummaryTextDone = (
  rawEvent: ResponseReasoningSummaryTextDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const outputIndex = rawEvent.output_index
  const text = rawEvent.text
  const events = new Array<AnthropicStreamEventData>()
  const blockIndex = openThinkingBlockIfNeeded(state, outputIndex, events)

  if (text && !state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "thinking_delta",
        thinking: text,
      },
    })
  }

  return events
}

const handleOutputTextDone = (
  rawEvent: ResponseTextDoneEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const outputIndex = rawEvent.output_index
  const contentIndex = rawEvent.content_index
  const text = rawEvent.text

  const blockIndex = openTextBlockIfNeeded(state, {
    outputIndex,
    contentIndex,
    events,
  })

  if (text && !state.blockHasDelta.has(blockIndex)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "text_delta",
        text,
      },
    })
  }

  return events
}

export const createResponsesNormalTerminalEvents = (
  state: ResponsesStreamState,
  response: ResponsesResult,
): Array<AnthropicStreamEventData> => {
  if (state.terminal !== "open") return []
  const events = closeResponsesOpenBlocks(state)
  const anthropic = translateResponsesResultToAnthropic(response)
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: anthropic.stop_reason,
        stop_sequence: anthropic.stop_sequence,
      },
      usage: anthropic.usage,
      ...(anthropic.copilot_usage !== undefined ?
        { copilot_usage: anthropic.copilot_usage }
      : {}),
    },
    { type: "message_stop" },
  )
  state.terminal = "succeeded"
  return events
}

const handleFunctionCallArgumentsValidationError = (
  state: ResponsesStreamState,
  events: Array<AnthropicStreamEventData> = [],
): Array<AnthropicStreamEventData> => {
  state.pendingFailure = buildErrorEvent(SAFE_RESPONSES_STREAM_ERROR_MESSAGE)

  return events
}

const messageStart = (
  state: ResponsesStreamState,
  response: ResponsesResult,
): Array<AnthropicStreamEventData> => {
  const metadata = response as ResponsesResult & {
    recommended_auto_tier?: "eco" | "balanced"
  }
  state.messageStartSent = true
  const inputCachedTokens = response.usage?.input_tokens_details?.cached_tokens
  const inputTokens =
    (response.usage?.input_tokens ?? 0) - (inputCachedTokens ?? 0)
  return [
    {
      type: "message_start",
      message: {
        id: response.id,
        type: "message",
        role: "assistant",
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: inputCachedTokens ?? 0,
          cache_creation_input_tokens: 0,
        },
        ...(metadata.recommended_auto_tier !== undefined ?
          { recommended_auto_tier: metadata.recommended_auto_tier }
        : {}),
      },
    },
  ]
}

const openTextBlockIfNeeded = (
  state: ResponsesStreamState,
  params: {
    outputIndex: number
    contentIndex: number
    events: Array<AnthropicStreamEventData>
  },
): number => {
  const { outputIndex, contentIndex, events } = params
  const key = getBlockKey(outputIndex, contentIndex)
  let blockIndex = state.blockIndexByKey.get(key)

  if (blockIndex === undefined) {
    blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1
    state.blockIndexByKey.set(key, blockIndex)
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

const openThinkingBlockIfNeeded = (
  state: ResponsesStreamState,
  outputIndex: number,
  events: Array<AnthropicStreamEventData>,
): number => {
  //thinking blocks has multiple summary_index, should combine into one block
  const summaryIndex = 0
  const key = getBlockKey(outputIndex, summaryIndex)
  let blockIndex = state.blockIndexByKey.get(key)

  if (blockIndex === undefined) {
    blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1
    state.blockIndexByKey.set(key, blockIndex)
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events)
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "thinking",
        thinking: "",
      },
    })
    state.openBlocks.add(blockIndex)
  }

  return blockIndex
}

const closeBlockIfOpen = (
  state: ResponsesStreamState,
  blockIndex: number,
  events: Array<AnthropicStreamEventData>,
) => {
  if (!state.openBlocks.has(blockIndex)) {
    return
  }

  events.push({ type: "content_block_stop", index: blockIndex })
  state.openBlocks.delete(blockIndex)
  state.blockHasDelta.delete(blockIndex)
}

const closeOpenBlocks = (
  state: ResponsesStreamState,
  events: Array<AnthropicStreamEventData>,
) => {
  for (const blockIndex of state.openBlocks) {
    closeBlockIfOpen(state, blockIndex, events)
  }
}

export const closeResponsesOpenBlocks = (
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> => {
  const events = new Array<AnthropicStreamEventData>()
  const indices = Array.from(state.openBlocks).sort(
    (left, right) => left - right,
  )
  for (const blockIndex of indices) closeBlockIfOpen(state, blockIndex, events)
  state.blockHasDelta.clear()
  state.functionCallStateByOutputIndex.clear()
  return events
}

export const buildErrorEvent = (message: string): AnthropicErrorEvent => ({
  type: "error",
  error: {
    type: "api_error",
    message,
  },
})

function buildReceivedResponsesError(
  error: {
    message?: unknown
    code?: unknown
    param?: unknown
    status?: unknown
  } | null,
): AnthropicErrorEvent {
  if (!error || typeof error.message !== "string") {
    return buildErrorEvent(SAFE_RESPONSES_STREAM_ERROR_MESSAGE)
  }
  return {
    type: "error",
    error: {
      type: "api_error",
      message: error.message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.param === "string" ? { param: error.param } : {}),
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    },
  }
}

export const SAFE_RESPONSES_STREAM_ERROR_MESSAGE =
  "Upstream Responses stream failed."

const getBlockKey = (outputIndex: number, contentIndex: number): string =>
  `${outputIndex}:${contentIndex}`

const openFunctionCallBlock = (
  state: ResponsesStreamState,
  params: {
    outputIndex: number
    toolCallId?: string
    name?: string
    events: Array<AnthropicStreamEventData>
    start?: boolean
  },
): number => {
  const { outputIndex, toolCallId, name, events, start = true } = params

  let functionCallState = state.functionCallStateByOutputIndex.get(outputIndex)

  if (!functionCallState) {
    const blockIndex = state.nextContentBlockIndex
    state.nextContentBlockIndex += 1

    functionCallState = {
      blockIndex,
      toolCallId: toolCallId ?? "",
      name: name ?? "",
      pendingArguments: [],
    }

    state.functionCallStateByOutputIndex.set(outputIndex, functionCallState)
  } else {
    if (toolCallId) functionCallState.toolCallId += toolCallId
    if (name) functionCallState.name += name
  }

  const { blockIndex } = functionCallState

  if (
    !state.openBlocks.has(blockIndex)
    && start
    && functionCallState.toolCallId
    && functionCallState.name
  ) {
    closeOpenBlocks(state, events)
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: functionCallState.toolCallId,
        name: functionCallState.name,
        input: {},
      },
    })
    state.openBlocks.add(blockIndex)
    functionCallState.started = true
    flushPendingFunctionArguments(state, outputIndex, events)
  }

  return blockIndex
}

function appendFunctionArguments(
  state: ResponsesStreamState,
  options: {
    outputIndex: number
    argumentsText: string
    events: Array<AnthropicStreamEventData>
  },
): void {
  const { outputIndex, argumentsText, events } = options
  const functionCallState =
    state.functionCallStateByOutputIndex.get(outputIndex)
  if (!functionCallState?.started) {
    functionCallState?.pendingArguments.push(argumentsText)
    return
  }
  events.push({
    type: "content_block_delta",
    index: functionCallState.blockIndex,
    delta: { type: "input_json_delta", partial_json: argumentsText },
  })
  state.blockHasDelta.add(functionCallState.blockIndex)
}

function flushPendingFunctionArguments(
  state: ResponsesStreamState,
  outputIndex: number,
  events: Array<AnthropicStreamEventData>,
): void {
  const functionCallState =
    state.functionCallStateByOutputIndex.get(outputIndex)
  if (!functionCallState?.started) return
  const pending = functionCallState.pendingArguments.splice(0)
  for (const argumentsText of pending) {
    appendFunctionArguments(state, { outputIndex, argumentsText, events })
  }
}

type FunctionCallDetails = {
  outputIndex: number
  toolCallId: string
  name: string
  initialArguments?: string
}

const extractFunctionCallDetails = (
  rawEvent: ResponseOutputItemAddedEvent,
): FunctionCallDetails | undefined => {
  const item = rawEvent.item
  const itemType = item.type
  if (itemType !== "function_call") {
    return undefined
  }

  const outputIndex = rawEvent.output_index
  const toolCallId = item.call_id
  const name = item.name
  const initialArguments = item.arguments
  return {
    outputIndex,
    toolCallId,
    name,
    initialArguments,
  }
}
