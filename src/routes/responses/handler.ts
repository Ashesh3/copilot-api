import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type FunctionTool,
  type ResponseOutputFunctionCall,
  type ResponseOutputItem,
  type ResponseOutputMessage,
  type ResponseOutputText,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseUsage,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import { getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

type ResponsesReasoningEffort = NonNullable<
  NonNullable<ResponsesPayload["reasoning"]>["effort"]
>

function isResponsesReasoningEffort(
  value: unknown,
): value is ResponsesReasoningEffort {
  return (
    value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
  )
}

function normalizeResponsesReasoning(
  payload: ResponsesPayload,
  suffixEffort?: "low" | "medium" | "high" | "xhigh",
): ResponsesReasoningEffort | undefined {
  // Accept OpenAI-compatible top-level aliases and normalize to reasoning.effort
  const topLevelEffortRaw = payload.reasoningEffort ?? payload.reasoning_effort
  const topLevelEffort =
    isResponsesReasoningEffort(topLevelEffortRaw) ? topLevelEffortRaw : (
      undefined
    )

  if (topLevelEffort) {
    payload.reasoning =
      payload.reasoning ?
        {
          ...payload.reasoning,
          effort: payload.reasoning.effort ?? topLevelEffort,
        }
      : { effort: topLevelEffort }
  }
  delete payload.reasoningEffort
  delete payload.reasoning_effort

  if (suffixEffort) {
    payload.reasoning =
      payload.reasoning ?
        {
          ...payload.reasoning,
          effort: suffixEffort,
        }
      : { effort: suffixEffort }
  }

  return payload.reasoning?.effort ?? undefined
}

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()

  // Capture the originally requested model before any manipulation
  const requestedModel = payload.model

  // Parse model suffix and apply reasoning effort override (e.g. "gpt-5.3-codex:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  payload.model = baseModel
  const effectiveEffort = normalizeResponsesReasoning(payload, suffixEffort)

  setRequestContext(c, {
    requestedModel,
    provider: "Responses",
    model: payload.model,
    reasoningEffort: effectiveEffort,
  })
  logger.debug("Responses request payload:", JSON.stringify(payload))

  useFunctionApplyPatch(payload)

  // Remove web_search tool as it's not supported by GitHub Copilot
  removeWebSearchTool(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    consola.debug(
      `[responses] Model ${payload.model} does not support /responses, falling back to ChatCompletions`,
    )
    setRequestContext(c, { provider: "Responses→ChatCompletions" })
    return handleWithChatCompletions(c, payload)
  }

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, { vision, initiator })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()

      for await (const chunk of response) {
        logger.debug("Responses stream chunk:", JSON.stringify(chunk))

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }
    })
  }

  logger.debug(
    "Forwarding native Responses result:",
    JSON.stringify(response).slice(-400),
  )
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type === "custom" && t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

// ─── ChatCompletions fallback for models without /responses support ───

interface CCFunctionCallState {
  itemId: string
  callId: string
  name: string
  arguments: string
  outputIndex: number
}

interface CCStreamState {
  seqNum: number
  responseId: string
  createdAt: number
  resolvedModel: string
  accumulatedText: string
  textItemAdded: boolean
  messageItemId: string
  functionCalls: Map<number, CCFunctionCallState>
  nextOutputIndex: number
  usage: { inputTokens?: number; outputTokens?: number }
  responseCreated: boolean
}

type WriteEventFn = (event: string, data: unknown) => Promise<void>

const createCCStreamState = (model: string): CCStreamState => ({
  seqNum: 0,
  responseId: "resp_cc",
  createdAt: Math.floor(Date.now() / 1000),
  resolvedModel: model,
  accumulatedText: "",
  textItemAdded: false,
  messageItemId: "msg_cc_001",
  functionCalls: new Map(),
  nextOutputIndex: 0,
  usage: {},
  responseCreated: false,
})

const convertInputToMessages = (
  input: ResponsesPayload["input"],
): ChatCompletionsPayload["messages"] => {
  const messages: ChatCompletionsPayload["messages"] = []

  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
    return messages
  }

  if (!Array.isArray(input)) return messages

  let pendingToolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [...pendingToolCalls],
      })
      pendingToolCalls = []
    }
  }

  for (const item of input) {
    const itemType = (item as { type?: string }).type
    if (itemType === "reasoning") continue
    if (itemType === "function_call") {
      const fc = item as { call_id: string; name: string; arguments: string }
      pendingToolCalls.push({
        id: fc.call_id,
        type: "function",
        function: { name: fc.name, arguments: fc.arguments },
      })
      continue
    }
    flushToolCalls()
    if (itemType === "function_call_output") {
      const fco = item as { call_id: string; output: unknown }
      messages.push({
        role: "tool",
        content:
          typeof fco.output === "string" ?
            fco.output
          : JSON.stringify(fco.output),
        tool_call_id: fco.call_id,
      })
      continue
    }
    if (!itemType || itemType === "message") {
      convertMessageItem(item, messages)
    }
  }

  flushToolCalls()
  return messages
}

const convertMessageItem = (
  item: unknown,
  messages: ChatCompletionsPayload["messages"],
): void => {
  const msg = item as {
    role: "user" | "assistant" | "system" | "developer"
    content?: string | Array<{ type?: string; text?: string }>
  }
  const role = msg.role === "developer" ? "developer" : msg.role
  let content: string

  if (typeof msg.content === "string") {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("")
  } else {
    content = ""
  }

  messages.push({ role, content })
}

const convertToolsForCC = (
  tools: ResponsesPayload["tools"],
): ChatCompletionsPayload["tools"] => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const converted = tools
    .filter((t): t is FunctionTool => "name" in t && "parameters" in t)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters ?? {},
      },
    }))

  return converted.length > 0 ? converted : undefined
}

const convertToolChoiceForCC = (
  toolChoice: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] => {
  if (!toolChoice) return undefined

  if (typeof toolChoice === "string") {
    return toolChoice as "none" | "auto" | "required"
  }

  if (typeof toolChoice === "object" && "name" in toolChoice) {
    return {
      type: "function",
      function: { name: (toolChoice as { name: string }).name },
    }
  }

  return undefined
}

const responsesToChatCompletions = (
  payload: ResponsesPayload,
): ChatCompletionsPayload => {
  const messages = convertInputToMessages(payload.input)

  if (payload.instructions) {
    messages.unshift({ role: "system", content: payload.instructions })
  }

  const tools = convertToolsForCC(payload.tools)
  const toolChoice = convertToolChoiceForCC(payload.tool_choice)

  // Map structured output (text.format) to response_format
  const textFormat = (payload as Record<string, unknown>).text as
    | { format?: { type: string; [key: string]: unknown } }
    | undefined
  const responseFormat =
    (
      textFormat?.format?.type === "json_schema"
      || textFormat?.format?.type === "json_object"
    ) ?
      { type: textFormat.format.type as "json_object" }
    : undefined

  return {
    model: payload.model,
    messages,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens,
    stream: payload.stream ?? false,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  }
}

const chatCompletionToResponsesResult = (
  response: ChatCompletionResponse,
  model: string,
): ResponsesResult => {
  const choice = response.choices[0]
  const output: Array<ResponseOutputItem> = []
  let outputText = ""

  // Map text content
  if (choice.message.content) {
    outputText = choice.message.content
    output.push({
      id: `msg_${response.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage)
  }

  // Map tool calls
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        id: `fc_${tc.id}`,
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      } satisfies ResponseOutputFunctionCall)
    }
  }

  // Map finish_reason to status
  let status = "completed"
  let incompleteDetails: ResponsesResult["incomplete_details"] = null
  if (choice.finish_reason === "length") {
    status = "incomplete"
    incompleteDetails = { reason: "max_output_tokens" }
  }

  return {
    id: `resp_${response.id}`,
    object: "response",
    created_at: response.created,
    model,
    output,
    output_text: outputText,
    status,
    usage: mapCCUsage(response.usage),
    error: null,
    incomplete_details: incompleteDetails,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}

const mapCCUsage = (
  usage: ChatCompletionResponse["usage"],
): ResponseUsage | null => {
  if (!usage) return null
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details ?
      {
        input_tokens_details: {
          cached_tokens: usage.prompt_tokens_details.cached_tokens,
        },
      }
    : {}),
  }
}

const buildCCResponseResult = (
  state: CCStreamState,
  outputItems: Array<ResponseOutputItem>,
  resultOpts: { status: string; outputText: string },
): ResponsesResult => ({
  id: state.responseId,
  object: "response",
  created_at: state.createdAt,
  model: state.resolvedModel,
  output: outputItems,
  output_text: resultOpts.outputText,
  status: resultOpts.status,
  usage: {
    input_tokens: state.usage.inputTokens ?? 0,
    output_tokens: state.usage.outputTokens ?? 0,
    total_tokens:
      (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0),
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

const emitTextDelta = async (
  s: CCStreamState,
  content: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  if (!s.textItemAdded) {
    s.textItemAdded = true
    const textOutputIndex = s.nextOutputIndex++
    await writeEvent("response.output_item.added", {
      item: {
        id: s.messageItemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
      output_index: textOutputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
  }

  s.accumulatedText += content
  await writeEvent("response.output_text.delta", {
    content_index: 0,
    delta: content,
    item_id: s.messageItemId,
    output_index: 0,
    sequence_number: s.seqNum++,
    type: "response.output_text.delta",
  })
}

const emitToolCallDelta = async (
  s: CCStreamState,
  tc: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>[0],
  writeEvent: WriteEventFn,
): Promise<void> => {
  const tcIndex = tc.index
  let fcState = s.functionCalls.get(tcIndex)

  if (!fcState) {
    const callId = tc.id ?? `call_cc_${tcIndex}`
    const name = tc.function?.name ?? ""
    fcState = {
      itemId: `fc_${callId}`,
      callId,
      name,
      arguments: "",
      outputIndex: s.nextOutputIndex++,
    }
    s.functionCalls.set(tcIndex, fcState)

    await writeEvent("response.output_item.added", {
      item: {
        id: fcState.itemId,
        type: "function_call",
        call_id: fcState.callId,
        name: fcState.name,
        arguments: "",
        status: "in_progress",
      },
      output_index: fcState.outputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
  }

  if (tc.function?.name && !fcState.name) {
    fcState.name = tc.function.name
  }

  if (tc.function?.arguments) {
    fcState.arguments += tc.function.arguments
    await writeEvent("response.function_call_arguments.delta", {
      delta: tc.function.arguments,
      item_id: fcState.itemId,
      output_index: fcState.outputIndex,
      sequence_number: s.seqNum++,
      type: "response.function_call_arguments.delta",
    })
  }
}

const emitDoneEvents = async (
  s: CCStreamState,
  finishReason: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  if (s.accumulatedText) {
    await emitTextDoneEvents(s, writeEvent)
  }

  for (const [, fcState] of s.functionCalls) {
    await emitFunctionCallDoneEvents(s, fcState, writeEvent)
  }

  await emitResponseCompleted(s, finishReason, writeEvent)
}

const emitTextDoneEvents = async (
  s: CCStreamState,
  writeEvent: WriteEventFn,
): Promise<void> => {
  await writeEvent("response.output_text.done", {
    content_index: 0,
    item_id: s.messageItemId,
    output_index: 0,
    sequence_number: s.seqNum++,
    text: s.accumulatedText,
    type: "response.output_text.done",
  })

  await writeEvent("response.output_item.done", {
    item: {
      id: s.messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: s.accumulatedText,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage,
    output_index: 0,
    sequence_number: s.seqNum++,
    type: "response.output_item.done",
  })
}

const emitFunctionCallDoneEvents = async (
  s: CCStreamState,
  fcState: CCFunctionCallState,
  writeEvent: WriteEventFn,
): Promise<void> => {
  await writeEvent("response.function_call_arguments.done", {
    arguments: fcState.arguments,
    item_id: fcState.itemId,
    name: fcState.name,
    output_index: fcState.outputIndex,
    sequence_number: s.seqNum++,
    type: "response.function_call_arguments.done",
  })

  await writeEvent("response.output_item.done", {
    item: {
      id: fcState.itemId,
      type: "function_call",
      call_id: fcState.callId,
      name: fcState.name,
      arguments: fcState.arguments,
      status: "completed",
    } satisfies ResponseOutputFunctionCall,
    output_index: fcState.outputIndex,
    sequence_number: s.seqNum++,
    type: "response.output_item.done",
  })
}

const emitResponseCompleted = async (
  s: CCStreamState,
  finishReason: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  const finalOutput: Array<ResponseOutputItem> = []

  if (s.accumulatedText) {
    finalOutput.push({
      id: s.messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: s.accumulatedText,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage)
  }

  for (const [, fcState] of s.functionCalls) {
    finalOutput.push({
      id: fcState.itemId,
      type: "function_call",
      call_id: fcState.callId,
      name: fcState.name,
      arguments: fcState.arguments,
      status: "completed",
    } satisfies ResponseOutputFunctionCall)
  }

  let finalStatus = "completed"
  let incompleteDetails: ResponsesResult["incomplete_details"] = null
  if (finishReason === "length") {
    finalStatus = "incomplete"
    incompleteDetails = { reason: "max_output_tokens" }
  }

  const finalResult = buildCCResponseResult(s, finalOutput, {
    status: finalStatus,
    outputText: s.accumulatedText,
  })
  finalResult.incomplete_details = incompleteDetails

  await writeEvent("response.completed", {
    response: finalResult,
    sequence_number: s.seqNum++,
    type: "response.completed",
  })
}

const streamChatCompletionsAsResponses = async (
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  ccStream: AsyncIterable<{ data?: string; event?: string }>,
  model: string,
): Promise<{ inputTokens?: number; outputTokens?: number }> => {
  const s = createCCStreamState(model)

  const writeEvent: WriteEventFn = async (event, data) => {
    await stream.writeSSE({ event, data: JSON.stringify(data) })
  }

  for await (const rawEvent of ccStream) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    if (chunk.id) s.responseId = `resp_${chunk.id}`
    if (chunk.created) s.createdAt = chunk.created
    if (chunk.model) s.resolvedModel = chunk.model

    if (chunk.usage) {
      s.usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      }
    }

    if (!s.responseCreated) {
      const skeleton = buildCCResponseResult(s, [], {
        status: "in_progress",
        outputText: "",
      })
      await writeEvent("response.created", {
        response: skeleton,
        sequence_number: s.seqNum++,
        type: "response.created",
      })
      s.responseCreated = true
    }

    const delta = chunk.choices.at(0)?.delta
    if (!delta) continue

    const content = delta.content as string | undefined
    if (content) {
      await emitTextDelta(s, content, writeEvent)
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        await emitToolCallDelta(s, tc, writeEvent)
      }
    }

    const finishReason = chunk.choices.at(0)?.finish_reason
    if (finishReason) {
      await emitDoneEvents(s, finishReason, writeEvent)
    }
  }

  return s.usage
}

const handleWithChatCompletions = async (
  c: Context,
  payload: ResponsesPayload,
) => {
  const ccPayload = responsesToChatCompletions(payload)
  logger.debug("ChatCompletions fallback payload:", JSON.stringify(ccPayload))

  const response = await createChatCompletions(ccPayload)

  // Non-streaming
  if (!payload.stream) {
    const ccResponse = response as ChatCompletionResponse
    logger.debug(
      "ChatCompletions fallback response:",
      JSON.stringify(ccResponse).slice(-400),
    )

    if (ccResponse.usage) {
      setRequestContext(c, {
        inputTokens: ccResponse.usage.prompt_tokens,
        outputTokens: ccResponse.usage.completion_tokens,
      })
    }

    const result = chatCompletionToResponsesResult(ccResponse, payload.model)
    return c.json(result)
  }

  // Streaming
  logger.debug("ChatCompletions fallback streaming")

  return streamSSE(c, async (sseStream) => {
    const ccStream = response as AsyncIterable<{
      data?: string
      event?: string
    }>
    const streamUsage = await streamChatCompletionsAsResponses(
      sseStream,
      ccStream,
      payload.model,
    )

    setRequestContext(c, {
      inputTokens: streamUsage.inputTokens,
      outputTokens: streamUsage.outputTokens,
    })
  })
}
