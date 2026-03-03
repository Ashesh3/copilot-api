import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { createHandlerLogger } from "~/lib/logger"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
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
  hasWebSearchInChunks,
  reconstructFromChunks,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "./web-search-helpers"

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
    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
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
  // Priority: suffix > body thinking config
  const bodyEffort = getBodyReasoningEffort(anthropicPayload)
  const effectiveEffort = suffixEffort ?? bodyEffort

  setRequestContext(c, {
    requestedModel,
    model: anthropicPayload.model,
    provider: apiType,
    reasoningEffort: effectiveEffort,
  })

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      initiatorOverride,
      effortOverride: suffixEffort,
      requestedModel,
    })
  }

  return await handleWithChatCompletions(
    c,
    anthropicPayload,
    initiatorOverride,
    requestedModel,
  )
}

const RESPONSES_ENDPOINT = "/responses"

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  initiatorOverride?: "agent" | "user",
  requestedModel?: string,
) => {
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

  // Calculate token count for the translated payload
  try {
    const selectedModel = state.models?.data.find(
      (m) => m.id === finalPayload.model,
    )
    if (selectedModel) {
      const tokenCount = await getTokenCount(finalPayload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch {
    // Token counting is best-effort, don't fail the request
  }

  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(finalPayload),
  )

  const response = await createChatCompletions(finalPayload, {
    initiator: initiatorOverride,
  })

  if (isNonStreaming(response)) {
    // Check for web_search tool calls and execute them in a loop
    const finalResponse = await resolveWebSearchCalls(
      response,
      finalPayload,
      initiatorOverride,
    )

    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(finalResponse).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(finalResponse, requestedModel)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  // Streaming path
  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    if (needsWebSearchBuffering) {
      // Buffer all chunks to detect web_search tool calls
      const bufferedChunks: Array<ChatCompletionChunk> = []

      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue
        bufferedChunks.push(JSON.parse(rawEvent.data) as ChatCompletionChunk)
      }

      if (hasWebSearchInChunks(bufferedChunks)) {
        const reconstructed = reconstructFromChunks(bufferedChunks)
        if (reconstructed) {
          const resolved = await resolveWebSearchCalls(
            reconstructed,
            finalPayload,
            initiatorOverride,
          )
          const anthropicResponse = translateToAnthropic(
            resolved,
            requestedModel,
          )
          await emitAnthropicResponseAsStream(stream, anthropicResponse)
          return
        }
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
      return
    }

    // No web_search tool — stream directly without buffering
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
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
  })
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
  const { initiatorOverride, effortOverride, requestedModel } = options ?? {}
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    effortOverride,
  )
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiatorOverride ?? initiator,
  })

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      if (needsWebSearchBuffering) {
        // Buffer all stream events to check for web_search function calls
        const bufferedEvents: Array<ResponseStreamEvent> = []
        let hasWebSearchCall = false
        let completedResult: ResponsesResult | null = null

        for await (const chunk of response) {
          const eventName = chunk.event
          if (eventName === "ping") {
            await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
            continue
          }

          const data = chunk.data
          if (!data) continue

          const parsed = JSON.parse(data) as ResponseStreamEvent
          bufferedEvents.push(parsed)

          if (
            parsed.type === "response.output_item.done"
            && "item" in parsed
            && (parsed.item as { type?: string }).type === "function_call"
            && (parsed.item as { name?: string }).name === "web_search"
          ) {
            hasWebSearchCall = true
          }

          if (
            (parsed.type === "response.completed"
              || parsed.type === "response.incomplete")
            && "response" in parsed
          ) {
            completedResult = parsed.response as ResponsesResult
          }
        }

        if (hasWebSearchCall && completedResult) {
          const resolved = await resolveResponsesWebSearchCalls(
            completedResult,
            responsesPayload,
            { vision, initiator: initiatorOverride ?? initiator },
          )
          const anthropicResponse =
            translateResponsesResultToAnthropic(resolved)
          if (requestedModel) anthropicResponse.model = requestedModel
          await emitAnthropicResponseAsStream(stream, anthropicResponse)
          return
        }

        // Replay buffered events
        const streamState = createResponsesStreamState()
        let errorForwarded = false
        for (const parsed of bufferedEvents) {
          if (parsed.type === "error") {
            const errorMessage =
              "message" in parsed ?
                (parsed as { message: string }).message
              : "Upstream error"
            const errorEvent = buildErrorEvent(errorMessage)
            await stream.writeSSE({
              event: errorEvent.type,
              data: JSON.stringify(errorEvent),
            })
            errorForwarded = true
            continue
          }

          const events = translateResponsesStreamEvent(parsed, streamState)
          for (const event of events) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }

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
        return
      }

      // No web_search tool — stream directly without buffering
      const streamState = createResponsesStreamState()

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        const data = chunk.data
        if (!data) continue

        const parsed = JSON.parse(data) as ResponseStreamEvent
        if (parsed.type === "error") {
          const errorMessage =
            "message" in parsed ?
              (parsed as { message: string }).message
            : "Upstream error"
          const errorEvent = buildErrorEvent(errorMessage)
          await stream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
          continue
        }

        const events = translateResponsesStreamEvent(parsed, streamState)
        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }

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
    })
  }

  // Non-streaming: check for web_search calls
  const result = response as ResponsesResult
  const resolved = await resolveResponsesWebSearchCalls(
    result,
    responsesPayload,
    { vision, initiator: initiatorOverride ?? initiator },
  )

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

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

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
