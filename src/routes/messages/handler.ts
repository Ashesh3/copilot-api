/* eslint-disable max-lines, max-lines-per-function */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { getSentryModelName, shouldRecordAiContent } from "~/lib/sentry"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { emitAnthropicToolSpans } from "~/lib/tool-spans"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import { isWebSearchToolType } from "~/services/copilot/mcp-web-search"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import {
  emitAnthropicResponseAsStream,
  extractWebSearchCalls,
  hasWebSearchInChunks,
  reconstructFromChunks,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "./web-search-helpers"

/**
 * Strip thinking blocks from all assistant messages in the payload.
 * Returns true if any thinking blocks were removed.
 * Used to recover from "Invalid signature in thinking block" errors
 * when models are switched mid-conversation.
 */
export function stripThinkingBlocks(
  payload: AnthropicMessagesPayload,
): boolean {
  let stripped = false
  for (const msg of payload.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    const before = msg.content.length
    msg.content = msg.content.filter((block) => block.type !== "thinking")
    if (msg.content.length < before) stripped = true
  }
  return stripped
}

/**
 * Strip thinking blocks from assistant messages in multi-token mode.
 *
 * Thinking block signatures (reasoning_opaque / signature) are cryptographically
 * tied to the specific Copilot token that generated them. In multi-token mode,
 * round-robin may route the next request to a different account, making
 * previous signatures invalid. Stripping them avoids the wasted 400 round-trip.
 *
 * In single-token mode, signatures stay valid and thinking context is preserved.
 */
function stripThinkingBlocksForMultiToken(
  payload: AnthropicMessagesPayload,
): void {
  if (!state.isMultiToken) return

  for (const msg of payload.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    msg.content = msg.content.filter((block) => block.type !== "thinking")
  }
}

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

const hasWebSearchToolInPayload = (
  tools: AnthropicMessagesPayload["tools"],
): boolean => {
  if (!tools) return false
  return tools.some((tool) => isWebSearchToolType(tool))
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Emit synthetic tool execution spans from tool results in message history
  emitAnthropicToolSpans(anthropicPayload.messages)

  // Capture the originally requested model before any manipulation
  const requestedModel = anthropicPayload.model

  // Parse model suffix for reasoning effort override (e.g. "claude-sonnet-4.6:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    anthropicPayload.model,
  )
  // Normalize model name (e.g. "claude-opus-4-6[1m]" → "claude-opus-4.6-1m")
  anthropicPayload.model = normalizeModelName(baseModel)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const initiatorOverride = subagentMarker ? "agent" : undefined
  if (subagentMarker) {
    logger.debug("Detected Subagent marker:", JSON.stringify(subagentMarker))
  }

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)

  // Route to model variants based on client signals
  applyModelVariantRouting(anthropicPayload, anthropicBeta)

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    mergeToolResultForClaude(anthropicPayload)
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = state.models?.data.find(
    (m) => m.id === anthropicPayload.model,
  )

  // Log the requested vs routed model
  let apiType = "ChatCompletions"
  if (shouldUseResponsesApi(selectedModel)) {
    apiType = "Responses"
  }

  // Determine effective reasoning effort for logging
  const bodyEffort = getBodyReasoningEffort(anthropicPayload)
  const effectiveEffort = suffixEffort ?? bodyEffort

  setRequestContext(c, {
    requestedModel,
    model: anthropicPayload.model,
    provider: apiType,
    reasoningEffort: effectiveEffort,
  })

  const result =
    shouldUseResponsesApi(selectedModel) ?
      await handleWithResponsesApi(c, anthropicPayload, {
        initiatorOverride,
        effortOverride: suffixEffort,
        requestedModel,
      })
    : await handleWithChatCompletions(c, anthropicPayload, {
        initiatorOverride,
        requestedModel,
      })

  return result
}

const RESPONSES_ENDPOINT = "/responses"

interface BufferedChatCompletionsResult {
  hadWebSearch: boolean
  initialResponse: ChatCompletionResponse | null
}

function setChatCompletionSpanResult(
  span: Sentry.Span,
  response: ChatCompletionResponse | null,
): void {
  const inputTokens = response?.usage?.prompt_tokens ?? 0
  const outputTokens = response?.usage?.completion_tokens ?? 0
  span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
  span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
  if (shouldRecordAiContent()) {
    span.setAttribute(
      "gen_ai.response.text",
      JSON.stringify([response?.choices[0]?.message?.content ?? ""]),
    )
  }
}

const streamChatCompletionsWithWebSearch = async (
  stream: {
    writeSSE: (data: { event: string; data: string }) => Promise<void>
  },
  response: AsyncIterable<{ data?: string }>,
  requestedModel?: string,
): Promise<BufferedChatCompletionsResult> => {
  const bufferedChunks: Array<ChatCompletionChunk> = []

  for await (const rawEvent of response) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue
    bufferedChunks.push(JSON.parse(rawEvent.data) as ChatCompletionChunk)
  }

  const initialResponse = reconstructFromChunks(bufferedChunks)

  if (hasWebSearchInChunks(bufferedChunks)) {
    return { hadWebSearch: true, initialResponse }
  }

  // No web_search calls — replay buffered chunks
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }

  for (const chunk of bufferedChunks) {
    const events = translateChunkToAnthropicEvents(
      chunk,
      streamState,
      requestedModel,
    )
    for (const event of events) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
  }

  return { hadWebSearch: false, initialResponse }
}

const streamChatCompletionsDirect = async (
  stream: {
    writeSSE: (data: { event: string; data: string }) => Promise<void>
  },
  response: AsyncIterable<{ data?: string }>,
  requestedModel?: string,
): Promise<{
  inputTokens: number
  outputTokens: number
  responseText: string
}> => {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }

  let streamInputTokens = 0
  let streamOutputTokens = 0
  let streamText = ""

  for await (const rawEvent of response) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

    if (chunk.usage) {
      streamInputTokens = chunk.usage.prompt_tokens
      streamOutputTokens = chunk.usage.completion_tokens
    }
    for (const choice of chunk.choices) {
      streamText += choice.delta.content ?? ""
    }

    const events = translateChunkToAnthropicEvents(
      chunk,
      streamState,
      requestedModel,
    )
    for (const event of events) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
  }

  return {
    inputTokens: streamInputTokens,
    outputTokens: streamOutputTokens,
    responseText: streamText,
  }
}

const tryCountTokens = async (
  c: Context,
  payload: Parameters<typeof getTokenCount>[0],
): Promise<void> => {
  try {
    const selectedModel = state.models?.data.find((m) => m.id === payload.model)
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch {
    // Token counting is best-effort, don't fail the request
  }
}

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    requestedModel?: string
  },
) => {
  try {
    return await executeChatCompletions(c, anthropicPayload, options)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const body = await error.response.clone().text()
      if (
        (body.includes("Invalid signature")
          || body.includes("Invalid `signature`"))
        && stripThinkingBlocks(anthropicPayload)
      ) {
        logger.warn(
          "Stripped thinking blocks due to invalid signature, retrying",
        )
        return await executeChatCompletions(c, anthropicPayload, options)
      }
    }
    throw error
  }
}

const executeChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    requestedModel?: string
  },
) => {
  const { initiatorOverride, requestedModel } = options ?? {}
  stripThinkingBlocksForMultiToken(anthropicPayload)
  const openAIPayload = translateToOpenAI(anthropicPayload)

  // Enable thinking/reasoning on the ChatCompletions path
  // Copilot API uses reasoning_effort to enable thinking (returns reasoning_text in response)
  // thinking_budget is also sent for models that support explicit budget control
  if (anthropicPayload.thinking) {
    const extra = openAIPayload as unknown as Record<string, unknown>
    extra.reasoning_effort = "high"
    if (anthropicPayload.thinking.budget_tokens) {
      extra.thinking_budget = anthropicPayload.thinking.budget_tokens
    }
    // Claude requires temperature=1 when thinking is enabled
    openAIPayload.temperature = 1
  }

  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(openAIPayload)
  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  if (appliedRules.length > 0) {
    setRequestContext(c, { replacements: appliedRules })
  }

  await tryCountTokens(c, finalPayload)

  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(finalPayload),
  )

  if (!finalPayload.stream) {
    const { initialResponse, hadWebSearch } = await Sentry.startSpan(
      {
        op: "gen_ai.request",
        name: `request ${finalPayload.model}`,
        attributes: {
          "gen_ai.request.model": finalPayload.model,
          "gen_ai.response.model": getSentryModelName(finalPayload.model),
          ...(shouldRecordAiContent() && {
            "gen_ai.request.messages": JSON.stringify(finalPayload.messages),
          }),
        },
      },
      async (span) => {
        const response = (await createChatCompletions(finalPayload, {
          initiator: initiatorOverride,
        })) as ChatCompletionResponse

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        const hadWebSearch = extractWebSearchCalls(response).length > 0
        setChatCompletionSpanResult(span, response)

        return { initialResponse: response, hadWebSearch }
      },
    )

    const finalResponse =
      hadWebSearch ?
        await resolveWebSearchCalls(
          initialResponse,
          finalPayload,
          initiatorOverride,
        )
      : initialResponse

    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(finalResponse).slice(-400),
    )

    const anthropicResponse = translateToAnthropic(
      finalResponse,
      requestedModel,
    )
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  logger.debug("Streaming response from Copilot")
  return await Sentry.startNewTrace(() =>
    Sentry.startSpanManual(
      {
        op: "gen_ai.request",
        name: `stream ${finalPayload.model}`,
        attributes: {
          "gen_ai.request.model": finalPayload.model,
          "gen_ai.response.model": getSentryModelName(finalPayload.model),
          ...(shouldRecordAiContent() && {
            "gen_ai.request.messages": JSON.stringify(finalPayload.messages),
          }),
        },
      },
      async (streamSpan, finish) => {
        let spanFinished = false
        const finishSpan = () => {
          if (spanFinished) return
          spanFinished = true
          finish()
        }

        try {
          const response = await createChatCompletions(finalPayload, {
            initiator: initiatorOverride,
          })

          // Track which account handled this request (multi-token mode)
          const accountId = getLastUsedAccountId()
          if (accountId !== undefined) {
            setRequestContext(c, { accountId })
          }

          return streamSSE(c, async (stream) => {
            try {
              if (needsWebSearchBuffering) {
                const buffered = await streamChatCompletionsWithWebSearch(
                  stream,
                  response as AsyncIterable<{ data?: string }>,
                  requestedModel,
                )

                setChatCompletionSpanResult(
                  streamSpan,
                  buffered.initialResponse,
                )

                if (buffered.hadWebSearch && buffered.initialResponse) {
                  finishSpan()
                  const resolved = await Sentry.withActiveSpan(null, () =>
                    resolveWebSearchCalls(
                      buffered.initialResponse,
                      finalPayload,
                      initiatorOverride,
                    ),
                  )
                  const anthropicResponse = translateToAnthropic(
                    resolved,
                    requestedModel,
                  )
                  await emitAnthropicResponseAsStream(stream, anthropicResponse)
                }
                return
              }

              const directResult = await streamChatCompletionsDirect(
                stream,
                response as AsyncIterable<{ data?: string }>,
                requestedModel,
              )

              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens",
                directResult.inputTokens,
              )
              streamSpan.setAttribute(
                "gen_ai.usage.output_tokens",
                directResult.outputTokens,
              )
              if (shouldRecordAiContent()) {
                streamSpan.setAttribute(
                  "gen_ai.response.text",
                  JSON.stringify([directResult.responseText]),
                )
              }
            } finally {
              finishSpan()
            }
          })
        } catch (error) {
          finishSpan()
          throw error
        }
      },
    ),
  )
}

type SSEStream = {
  writeSSE: (data: { event: string; data: string }) => Promise<void>
}

type ResponsesStream = AsyncIterable<{ event?: string; data?: string }>

const parseResponsesStreamError = (
  parsed: ResponseStreamEvent,
): string | null => {
  if (parsed.type !== "error") return null
  return "message" in parsed ?
      (parsed as { message: string }).message
    : "Upstream error"
}

const writeResponsesEvents = async (
  stream: SSEStream,
  parsed: ResponseStreamEvent,
  streamState: ReturnType<typeof createResponsesStreamState>,
): Promise<void> => {
  const events = translateResponsesStreamEvent(parsed, streamState)
  for (const event of events) {
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
  }
}

const isWebSearchFunctionCall = (parsed: ResponseStreamEvent): boolean =>
  parsed.type === "response.output_item.done"
  && "item" in parsed
  && (parsed.item as { type?: string }).type === "function_call"
  && (parsed.item as { name?: string }).name === "web_search"

const isResponseCompleted = (
  parsed: ResponseStreamEvent,
): parsed is ResponseStreamEvent & { response: ResponsesResult } =>
  (parsed.type === "response.completed"
    || parsed.type === "response.incomplete")
  && "response" in parsed

const bufferResponsesStream = async (
  stream: SSEStream,
  response: ResponsesStream,
): Promise<{
  events: Array<ResponseStreamEvent>
  hasWebSearch: boolean
  completedResult: ResponsesResult | null
}> => {
  const events: Array<ResponseStreamEvent> = []
  let hasWebSearch = false
  let completedResult: ResponsesResult | null = null

  for await (const chunk of response) {
    if (chunk.event === "ping") {
      await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
      continue
    }
    if (!chunk.data) continue

    const parsed = JSON.parse(chunk.data) as ResponseStreamEvent
    events.push(parsed)

    if (isWebSearchFunctionCall(parsed)) hasWebSearch = true
    if (isResponseCompleted(parsed)) completedResult = parsed.response
  }

  return { events, hasWebSearch, completedResult }
}

const replayBufferedEvents = async (
  stream: SSEStream,
  bufferedEvents: Array<ResponseStreamEvent>,
): Promise<void> => {
  const streamState = createResponsesStreamState()
  let errorForwarded = false

  for (const parsed of bufferedEvents) {
    const errorMsg = parseResponsesStreamError(parsed)
    if (errorMsg) {
      const errorEvent = buildErrorEvent(errorMsg)
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
      errorForwarded = true
      continue
    }

    await writeResponsesEvents(stream, parsed, streamState)
    if (streamState.messageCompleted) break
  }

  if (!streamState.messageCompleted && !errorForwarded) {
    logger.warn(
      "Responses stream ended without completion; sending error event",
    )
    const errorEvent = buildErrorEvent(
      "Responses stream ended without completion",
    )
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  }
}

const streamResponsesWithWebSearch = async (
  stream: SSEStream,
  response: ResponsesStream,
): Promise<{
  hadWebSearch: boolean
  initialResult: ResponsesResult | null
}> => {
  const { events, hasWebSearch, completedResult } = await bufferResponsesStream(
    stream,
    response,
  )

  if (hasWebSearch && completedResult) {
    return { hadWebSearch: true, initialResult: completedResult }
  }

  await replayBufferedEvents(stream, events)
  return { hadWebSearch: false, initialResult: completedResult }
}

const streamResponsesDirect = async (
  stream: SSEStream,
  response: ResponsesStream,
): Promise<{
  inputTokens: number
  outputTokens: number
  responseText: string
}> => {
  const streamState = createResponsesStreamState()
  let streamInputTokens = 0
  let streamOutputTokens = 0
  let responseText = ""

  for await (const chunk of response) {
    if (chunk.event === "ping") {
      await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
      continue
    }
    if (!chunk.data) continue

    const parsed = JSON.parse(chunk.data) as ResponseStreamEvent
    const errorMsg = parseResponsesStreamError(parsed)
    if (errorMsg) {
      const errorEvent = buildErrorEvent(errorMsg)
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
      continue
    }

    // Capture usage from response.completed events
    if (isResponseCompleted(parsed) && parsed.response.usage) {
      streamInputTokens = parsed.response.usage.input_tokens
      streamOutputTokens = parsed.response.usage.output_tokens ?? 0
      responseText = parsed.response.output_text
    }

    await writeResponsesEvents(stream, parsed, streamState)
    if (streamState.messageCompleted) break
  }

  if (!streamState.messageCompleted) {
    logger.warn(
      "Responses stream ended without completion; sending error event",
    )
    const errorEvent = buildErrorEvent(
      "Responses stream ended without completion",
    )
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  }

  return {
    inputTokens: streamInputTokens,
    outputTokens: streamOutputTokens,
    responseText,
  }
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    effortOverride?: "low" | "medium" | "high" | "xhigh"
    requestedModel?: string
  },
) => {
  try {
    return await executeResponsesApi(c, anthropicPayload, options)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const body = await error.response.clone().text()
      if (
        (body.includes("Invalid signature")
          || body.includes("Invalid `signature`"))
        && stripThinkingBlocks(anthropicPayload)
      ) {
        logger.warn(
          "Stripped thinking blocks due to invalid signature (Responses API), retrying",
        )
        return await executeResponsesApi(c, anthropicPayload, options)
      }
    }
    throw error
  }
}

const executeResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    effortOverride?: "low" | "medium" | "high" | "xhigh"
    requestedModel?: string
  },
) => {
  const { initiatorOverride, effortOverride, requestedModel } = options ?? {}
  stripThinkingBlocksForMultiToken(anthropicPayload)
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    effortOverride,
  )
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  if (responsesPayload.stream) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return await Sentry.startNewTrace(() =>
      Sentry.startSpanManual(
        {
          op: "gen_ai.request",
          name: `stream ${anthropicPayload.model}`,
          attributes: {
            "gen_ai.request.model": anthropicPayload.model,
            "gen_ai.response.model": getSentryModelName(anthropicPayload.model),
            ...(shouldRecordAiContent() && {
              "gen_ai.request.messages": JSON.stringify(
                anthropicPayload.messages,
              ),
            }),
          },
        },
        async (streamSpan, finish) => {
          let spanFinished = false
          const finishSpan = () => {
            if (spanFinished) return
            spanFinished = true
            finish()
          }

          try {
            const response = await createResponses(responsesPayload, {
              vision,
              initiator: initiatorOverride ?? initiator,
            })

            const responsesAccountId = getLastUsedAccountId()
            if (responsesAccountId !== undefined) {
              setRequestContext(c, { accountId: responsesAccountId })
            }

            return streamSSE(c, async (stream) => {
              try {
                if (needsWebSearchBuffering) {
                  const buffered = await streamResponsesWithWebSearch(
                    stream,
                    response as ResponsesStream,
                  )

                  const inputTokens =
                    buffered.initialResult?.usage?.input_tokens ?? 0
                  const outputTokens =
                    buffered.initialResult?.usage?.output_tokens ?? 0
                  streamSpan.setAttribute(
                    "gen_ai.usage.input_tokens",
                    inputTokens,
                  )
                  streamSpan.setAttribute(
                    "gen_ai.usage.output_tokens",
                    outputTokens,
                  )
                  if (shouldRecordAiContent()) {
                    streamSpan.setAttribute(
                      "gen_ai.response.text",
                      JSON.stringify([
                        buffered.initialResult?.output_text ?? "",
                      ]),
                    )
                  }

                  if (buffered.hadWebSearch && buffered.initialResult) {
                    finishSpan()
                    const resolved = await Sentry.withActiveSpan(null, () =>
                      resolveResponsesWebSearchCalls(
                        buffered.initialResult,
                        responsesPayload,
                        {
                          vision,
                          initiator: initiatorOverride ?? initiator,
                        },
                      ),
                    )
                    const anthropicResponse =
                      translateResponsesResultToAnthropic(resolved)
                    if (requestedModel) anthropicResponse.model = requestedModel
                    await emitAnthropicResponseAsStream(
                      stream,
                      anthropicResponse,
                    )
                  }
                  return
                }

                const directUsage = await streamResponsesDirect(
                  stream,
                  response as ResponsesStream,
                )

                streamSpan.setAttribute(
                  "gen_ai.usage.input_tokens",
                  directUsage.inputTokens,
                )
                streamSpan.setAttribute(
                  "gen_ai.usage.output_tokens",
                  directUsage.outputTokens,
                )
                if (shouldRecordAiContent()) {
                  streamSpan.setAttribute(
                    "gen_ai.response.text",
                    JSON.stringify([directUsage.responseText]),
                  )
                }
              } finally {
                finishSpan()
              }
            })
          } catch (error) {
            finishSpan()
            throw error
          }
        },
      ),
    )
  }

  const { initialResult, hadWebSearch } = await Sentry.startSpan(
    {
      op: "gen_ai.request",
      name: `request ${anthropicPayload.model}`,
      attributes: {
        "gen_ai.request.model": anthropicPayload.model,
        "gen_ai.response.model": getSentryModelName(anthropicPayload.model),
        ...(shouldRecordAiContent() && {
          "gen_ai.request.messages": JSON.stringify(anthropicPayload.messages),
        }),
      },
    },
    async (span) => {
      const result = (await createResponses(responsesPayload, {
        vision,
        initiator: initiatorOverride ?? initiator,
      })) as ResponsesResult

      const responsesAccountId = getLastUsedAccountId()
      if (responsesAccountId !== undefined) {
        setRequestContext(c, { accountId: responsesAccountId })
      }

      const hadWebSearch = result.output.some(
        (item) => item.type === "function_call" && item.name === "web_search",
      )
      const inputTokens = result.usage?.input_tokens ?? 0
      const outputTokens = result.usage?.output_tokens ?? 0
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
      span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
      if (shouldRecordAiContent()) {
        span.setAttribute(
          "gen_ai.response.text",
          JSON.stringify([result.output_text]),
        )
      }

      return { initialResult: result, hadWebSearch }
    },
  )

  const resolved =
    hadWebSearch ?
      await resolveResponsesWebSearchCalls(initialResult, responsesPayload, {
        vision,
        initiator: initiatorOverride ?? initiator,
      })
    : initialResult

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(resolved).slice(-400),
  )

  const anthropicResponse = translateResponsesResultToAnthropic(resolved)
  if (requestedModel) anthropicResponse.model = requestedModel
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

/**
 * Route to model variants based on client signals (1m context, fast mode).
 * Mutates the payload in place.
 */
function applyModelVariantRouting(
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): void {
  // 1M context via beta header → route to -1m model variant
  if (anthropicBeta?.includes("context-1m")) {
    const candidate = `${payload.model}-1m`
    if (state.models?.data.some((m) => m.id === candidate)) {
      payload.model = candidate
    }
  }

  // Fast mode → route to -fast model variant, strip unsupported field
  if (payload.speed === "fast") {
    const candidate = `${payload.model}-fast`
    if (state.models?.data.some((m) => m.id === candidate)) {
      payload.model = candidate
    }
    delete payload.speed
  }
}

/**
 * Extract reasoning effort info from the Anthropic request body for logging.
 * Claude Code sends effort as `output_config.effort` (low/medium/high/max)
 * and thinking mode as `thinking.type` (enabled/adaptive).
 * When effort is "high" (the default), Claude Code omits output_config.effort entirely.
 */
function getBodyReasoningEffort(
  payload: AnthropicMessagesPayload,
): string | undefined {
  // No thinking config at all — no effort to report
  if (!payload.thinking && !payload.output_config?.effort) return undefined

  const parts: Array<string> = []

  // output_config.effort is the actual effort level (low/medium/high/max)
  // Claude Code omits this field when effort is "high" (the API default)
  const effort =
    payload.output_config?.effort ?? (payload.thinking ? "high" : undefined)
  if (effort) {
    parts.push(effort)
  }

  // thinking.type indicates the thinking mode (enabled/adaptive)
  if (payload.thinking) {
    parts.push(payload.thinking.type)
    if (payload.thinking.budget_tokens) {
      parts.push(`${payload.thinking.budget_tokens.toLocaleString()} budget`)
    }
  }

  return parts.length > 0 ? parts.join(", ") : undefined
}

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  if (Array.isArray(tr.content)) {
    return {
      ...tr,
      content: [...tr.content, textBlock],
    }
  }
  // content is null/undefined — start fresh with just the text block
  return { ...tr, content: [textBlock] }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  if (Array.isArray(tr.content)) {
    return { ...tr, content: [...tr.content, ...textBlocks] }
  }
  // content is null/undefined
  return { ...tr, content: [...textBlocks] }
}

const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  // equal lengths -> pairwise merge
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  // lengths differ -> append all textBlocks to the last tool_result
  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}
