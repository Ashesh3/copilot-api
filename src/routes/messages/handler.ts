/* eslint-disable max-lines, max-lines-per-function, complexity */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type {
  EndpointRouteDecision,
  EndpointRouteFailure,
} from "~/lib/endpoint-routing"
import type { Model } from "~/services/copilot/get-models"

import {
  getLastUsedAccountId,
  runWithPinnedRoutedAccount,
} from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { sessionTokenMatchesModel } from "~/lib/copilot-session-token"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
  type CustomProviderModelReference,
} from "~/lib/custom-providers"
import {
  getModelEndpointSupport,
  selectCopilotEndpoint,
} from "~/lib/endpoint-routing"
import {
  createEndpointTranslationError,
  HTTPError,
  isAbortError,
  LocalHTTPError,
} from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseReasoningEffort,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import {
  installRoutingAffinityFallback,
  resolveClaudeRoutingAffinity,
} from "~/lib/routing-affinity"
import {
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  setSentryOutputMessages,
  setSentryConversationIdFromRequest,
} from "~/lib/sentry"
import {
  raceSsePreflush,
  unwrapSsePreflushSettlement,
  withHeartbeatWhilePending,
  withSseHeartbeat,
  writeSseHeartbeat,
} from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { getTokenCount } from "~/lib/tokenizer"
import { emitAnthropicToolSpans } from "~/lib/tool-spans"
import {
  buildErrorEvent,
  createResponsesStreamState,
  SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
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
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import { isWebSearchToolType } from "~/services/copilot/mcp-web-search"
import {
  createInvalidAnthropicMessagesJsonError,
  getCanonicalAnthropicBetaIdentifiers,
  prepareAnthropicMessagesRequest,
  validateAnthropicRequestHeaderOptions,
} from "~/services/copilot/messages-contract"
import {
  consumeExtraSend,
  createRetryBudget,
} from "~/services/copilot/transport-retry"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  normalizeAnthropicAttachments,
  normalizeAnthropicImages,
} from "./attachment-normalization"
import {
  handleWithNativeMessages,
  type NativeMessagesRequestOptions,
} from "./native-handler"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  createFallbackMessageDeltaEvents,
  emitAnthropicStreamError,
  translateChunkToAnthropicEvents,
} from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import {
  isInvalidThinkingSignatureResponse,
  stripThinkingBlocks,
} from "./thinking-recovery"
import {
  checkMessagesToChatTranslation,
  checkMessagesNativeCompatibility,
  checkMessagesToResponsesTranslation,
} from "./translation-fidelity"
import {
  emitAnthropicResponseAsStream,
  extractWebSearchCalls,
  hasWebSearchInChunks,
  reconstructFromChunks,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "./web-search-helpers"

export function selectMessagesUpstreamEndpoint(options: {
  payload: AnthropicMessagesPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure {
  const support =
    options.selectedModel ?
      getModelEndpointSupport(options.selectedModel)
    : {
        chat: true,
        embeddings: false,
        messages: false,
        responses: false,
        responsesWebSocket: false,
      }
  return selectCopilotEndpoint({
    source: "messages",
    support,
    candidates: [
      {
        endpoint: "/v1/messages",
        reason: "endpoint_unavailable",
        check: { supported: true, blockers: [] },
      },
      {
        endpoint: "/responses",
        reason: "endpoint_unavailable",
        check: checkMessagesToResponsesTranslation(options.payload),
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        check: checkMessagesToChatTranslation(options.payload),
      },
    ],
  })
}

/**
 * Strip thinking blocks from all assistant messages in the payload.
 * Returns true if any thinking blocks were removed.
 * Used to recover from "Invalid signature in thinking block" errors
 * when models are switched mid-conversation.
 */
export { stripThinkingBlocks } from "./thinking-recovery"

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
  let rawPayload: AnthropicMessagesPayload
  try {
    rawPayload = await c.req.json<AnthropicMessagesPayload>()
  } catch {
    throw createInvalidAnthropicMessagesJsonError()
  }
  const anthropicPayload = prepareAnthropicMessagesRequest({
    payload: rawPayload,
    requireMaxTokens: true,
  }).body as unknown as AnthropicMessagesPayload
  const nativeOptions: NativeMessagesRequestOptions =
    validateAnthropicRequestHeaderOptions({
      anthropicBeta: c.req.header("anthropic-beta"),
      anthropicVersion: c.req.header("anthropic-version"),
      modelProviderPreference: c.req.header("x-model-provider-preference"),
    })
  installRoutingAffinityFallback(
    resolveClaudeRoutingAffinity(anthropicPayload.metadata),
  )
  const conversationId = setSentryConversationIdFromRequest(c, anthropicPayload)
  logger.debug("Received Anthropic request", {
    messageCount: anthropicPayload.messages.length,
    stream: Boolean(anthropicPayload.stream),
    toolCount: anthropicPayload.tools?.length ?? 0,
  })

  const model = normalizeModelName(
    parseModelSuffix(anthropicPayload.model).baseModel,
  )

  return await Sentry.startSpan(
    createSentryInvokeAgentSpanOptions(model, conversationId),
    async () => {
      return await handleCompletionInner(c, anthropicPayload, nativeOptions)
    },
  )
}

async function handleCompletionInner(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  nativeOptions: NativeMessagesRequestOptions,
) {
  // Emit synthetic tool execution spans from tool results in message history
  emitAnthropicToolSpans(anthropicPayload.messages)

  // Capture the originally requested model before any manipulation
  const requestedModel = anthropicPayload.model

  // Parse model suffix for reasoning effort override (e.g. "claude-sonnet-4.6:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    anthropicPayload.model,
  )
  // Normalize model name (e.g. "claude-opus-4-6[1m]" → "claude-opus-4.6-1m")
  const normalized = normalizeModelName(baseModel)

  const bodyEffortOverride = getOutputConfigReasoningEffort(anthropicPayload)
  const requestedRawEffort = suffixEffort ?? bodyEffortOverride
  const requestedEffort = normalizeReasoningEffortForModel(
    normalized,
    requestedRawEffort,
  )
  if (requestedRawEffort && requestedEffort !== requestedRawEffort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested effort ${requestedRawEffort} for ${normalized} was clamped to ${requestedEffort}`,
      data: {
        model: normalized,
        requestedEffort: requestedRawEffort,
        effectiveEffort: requestedEffort,
      },
    })
  }

  // Apply silent model redirect (response will still report requestedModel)
  const redirect = await applyModelRedirect({
    model: normalized,
    effort: requestedEffort,
  })
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: normalized,
        sourceEffort: requestedEffort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }
  const redirectEffort = normalizeReasoningEffortForModel(
    redirect.model,
    redirect.effort,
  )
  if (redirect.effort && redirectEffort !== redirect.effort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested redirected effort ${redirect.effort} for ${redirect.model} was clamped to ${redirectEffort}`,
      data: {
        model: redirect.model,
        requestedEffort: redirect.effort,
        effectiveEffort: redirectEffort,
      },
    })
  }
  // eslint-disable-next-line require-atomic-updates
  anthropicPayload.model = redirect.model

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const initiatorOverride = subagentMarker ? "agent" : undefined
  if (subagentMarker) logger.debug("Detected Subagent marker")

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  const { anthropicBeta } = nativeOptions
  logger.debug("Anthropic Beta header present:", Boolean(anthropicBeta))

  // Route to model variants based on client signals
  applyModelVariantRouting(c, anthropicPayload, anthropicBeta)

  const customReference = resolveCustomChatModel(anthropicPayload.model)
  if (customReference) {
    const customTranslation = checkMessagesToChatTranslation(anthropicPayload)
    if (!customTranslation.supported) {
      throw createEndpointTranslationError({
        blockers: customTranslation.blockers,
        code: "endpoint_translation_unsupported",
        source: "messages",
      })
    }
    await normalizeAnthropicAttachments(anthropicPayload, c.req.raw.signal)
    await prepareMessagesPayloadForDispatch(c, {
      payload: anthropicPayload,
      isCompact,
      attachmentsPrepared: true,
    })
    setRequestContext(c, {
      requestedModel,
      model: anthropicPayload.model,
      provider: "ChatCompletions",
      reasoningEffort:
        redirectEffort ?? getBodyReasoningEffort(anthropicPayload),
    })
    return await handleWithChatCompletions(c, anthropicPayload, {
      initiatorOverride,
      effortOverride: redirectEffort,
      requestedModel,
    })
  }

  const inboundSessionToken = c.req.header("copilot-session-token")
  const copilotSessionToken =
    (
      sessionTokenMatchesModel({
        token: inboundSessionToken,
        requestedModel: baseModel,
        finalModel: anthropicPayload.model,
      })
    ) ?
      inboundSessionToken
    : undefined

  const selectedModel = state.models?.data.find(
    (m) => m.id === anthropicPayload.model,
  )
  if (state.models && !selectedModel) throw createMessagesModelNotFoundError()

  const routeDecision = selectMessagesUpstreamEndpoint({
    payload: anthropicPayload,
    selectedModel,
  })
  if ("code" in routeDecision)
    throw createEndpointTranslationError(routeDecision)

  if (routeDecision.target === "/v1/messages") {
    const nativeCompatibility =
      checkMessagesNativeCompatibility(anthropicPayload)
    if (!nativeCompatibility.supported) {
      throw createEndpointTranslationError({
        blockers: nativeCompatibility.blockers,
        code: "endpoint_translation_unsupported",
        source: "messages",
      })
    }
  }

  const attachmentsPrepared = routeDecision.target !== "/v1/messages"
  // Fidelity selection above must see the original semantic block shape.
  // Only the chosen dispatch path may now rewrite its attachment transport.
  if (attachmentsPrepared) {
    await normalizeAnthropicAttachments(anthropicPayload, c.req.raw.signal)
  }
  await prepareMessagesPayloadForDispatch(c, {
    payload: anthropicPayload,
    isCompact,
    attachmentsPrepared,
  })

  let apiType = "ChatCompletions"
  if (routeDecision.target === "/v1/messages") {
    apiType = "AnthropicMessages"
  } else if (routeDecision.target === "/responses") {
    apiType = "Responses"
  }
  if (routeDecision.translated) {
    recordNonDefaultBehavior(c, {
      kind: "endpoint_fallback",
      message: `Model ${anthropicPayload.model} does not support native /v1/messages; falling back to ${apiType}`,
      data: {
        model: anthropicPayload.model,
        sourceEndpoint: "AnthropicMessages",
        targetEndpoint: apiType,
      },
    })
  }

  // Determine effective reasoning effort for logging
  const bodyEffort = getBodyReasoningEffort(anthropicPayload)
  const effectiveEffort = redirectEffort ?? bodyEffort
  const effortOverride = redirectEffort

  setRequestContext(c, {
    requestedModel,
    model: anthropicPayload.model,
    provider: apiType,
    reasoningEffort: effectiveEffort,
  })

  if (routeDecision.target === "/v1/messages") {
    const retryBudget = createRetryBudget()
    const requestOptions: NativeMessagesRequestOptions = {
      ...nativeOptions,
      requestedModel,
      originalStream: Boolean(anthropicPayload.stream),
      retryBudget,
      copilotSessionToken,
      ...(initiatorOverride ? { initiatorOverride } : {}),
    }
    try {
      return await handleWithNativeMessages(c, anthropicPayload, requestOptions)
    } catch (error) {
      if (
        requestOptions.originalStream
        || !(error instanceof HTTPError)
        || error.response.status !== 400
        || !(await isInvalidThinkingSignatureResponse(error.response))
      ) {
        throw error
      }

      if (!consumeExtraSend(retryBudget)) {
        throw error
      }
      const recoveredPayload = structuredClone(anthropicPayload)
      if (!stripThinkingBlocks(recoveredPayload)) throw error
      recordNonDefaultBehavior(c, {
        kind: "reasoning_retry_without_thinking",
        message: `Stripped thinking blocks after native /v1/messages rejected their signature for ${anthropicPayload.model}`,
        data: {
          model: anthropicPayload.model,
          reason: "invalid signature",
          endpoint: "AnthropicMessages",
        },
      })
      const accountId = getLastUsedAccountId()
      return await runWithPinnedRoutedAccount(
        accountId,
        async () =>
          await handleWithNativeMessages(c, recoveredPayload, {
            ...requestOptions,
            retryBudget,
          }),
      )
    }
  }

  if (routeDecision.target === "/responses") {
    return await handleWithResponsesApi(c, anthropicPayload, {
      copilotSessionToken,
      initiatorOverride,
      effortOverride,
      requestedModel,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    copilotSessionToken,
    initiatorOverride,
    effortOverride,
    requestedModel,
  })
}

async function prepareMessagesPayloadForDispatch(
  c: Context,
  options: {
    attachmentsPrepared?: boolean
    isCompact: boolean
    payload: AnthropicMessagesPayload
  },
): Promise<void> {
  const { attachmentsPrepared, isCompact, payload } = options
  if (!attachmentsPrepared) {
    // Native Messages can preserve accepted document sources and their
    // metadata. It still needs external image URLs inlined for Copilot.
    await normalizeAnthropicImages(payload, c.req.raw.signal)
  }

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    mergeToolResultForClaude(payload)
  }

  if (state.manualApprove) await awaitApproval()
}

interface BufferedChatCompletionsResult {
  hadWebSearch: boolean
  initialResponse: ChatCompletionResponse | null
}

function setOptionalTokenDetails(
  span: Sentry.Span,
  cachedTokens: number,
  reasoningTokens = 0,
): void {
  if (cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", cachedTokens)
  }
  if (reasoningTokens > 0) {
    span.setAttribute("gen_ai.usage.output_tokens.reasoning", reasoningTokens)
  }
}

function setChatCompletionSpanResult(
  span: Sentry.Span,
  response: ChatCompletionResponse | null,
): void {
  const inputTokens = response?.usage?.prompt_tokens ?? 0
  const outputTokens = response?.usage?.completion_tokens ?? 0
  const cachedTokens =
    response?.usage?.prompt_tokens_details?.cached_tokens ?? 0
  span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
  span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
  setOptionalTokenDetails(span, cachedTokens)
  setSentryOutputMessages(span, response?.choices[0]?.message?.content ?? "")
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

  for (const event of createFallbackMessageDeltaEvents(streamState)) {
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
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
  cachedTokens: number
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
  let streamCachedTokens = 0
  let streamText = ""

  for await (const rawEvent of response) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

    if (chunk.usage) {
      streamInputTokens = chunk.usage.prompt_tokens
      streamOutputTokens = chunk.usage.completion_tokens
      streamCachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
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

  for (const event of createFallbackMessageDeltaEvents(streamState)) {
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
  }

  return {
    inputTokens: streamInputTokens,
    outputTokens: streamOutputTokens,
    cachedTokens: streamCachedTokens,
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

function getCopilotModelIds(): Set<string> {
  return new Set(state.models?.data.map((model) => model.id) ?? [])
}

function resolveCustomChatModel(
  model: string,
): CustomProviderModelReference | undefined {
  const copilotModelIds = getCopilotModelIds()
  const unnormalizedReference = resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds,
  })
  if (unnormalizedReference) return unnormalizedReference

  const normalizedModel = normalizeModelName(model)
  if (normalizedModel === model) return undefined

  return resolveCustomProviderModel({
    model: normalizedModel,
    kind: "chat",
    copilotModelIds,
  })
}

function applyThinkingBudget(
  payload: ChatCompletionsPayload,
  budgetTokens: number | undefined,
): void {
  const extra = payload as unknown as Record<string, unknown>
  delete extra.thinking_budget
  if (!budgetTokens) return
  if (usesImplicitReasoningDefault(normalizeModelName(payload.model))) return

  extra.thinking_budget = budgetTokens
}

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    requestedModel?: string
  },
) => {
  try {
    return await executeChatCompletions(c, anthropicPayload, options)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const body = await error.response.clone().text()
      const isSignatureError =
        body.includes("Invalid signature")
        || body.includes("Invalid `signature`")
      // Generic "Bad Request" with reasoning enabled means CAPI rejected
      // because reasoning_opaque was missing or invalid on prior turns.
      const isReasoningBadRequest =
        body.trim() === "Bad Request"
        && Boolean(options?.effortOverride || anthropicPayload.thinking)

      if (
        (isSignatureError || isReasoningBadRequest)
        && stripThinkingBlocks(anthropicPayload)
      ) {
        const reason =
          isSignatureError ? "invalid signature" : "Bad Request with reasoning"
        recordNonDefaultBehavior(c, {
          kind: "reasoning_retry_without_thinking",
          message: `Stripped thinking blocks due to ${reason}, retrying ChatCompletions without reasoning`,
          data: {
            model: anthropicPayload.model,
            reason,
            endpoint: "ChatCompletions",
          },
        })
        // Fully downgrade reasoning: clear thinking config AND effortOverride.
        // Clearing effortOverride alone is insufficient — executeChatCompletions
        // re-adds reasoning_effort when anthropicPayload.thinking is present.
        delete anthropicPayload.thinking
        return await executeChatCompletions(c, anthropicPayload, {
          ...options,
          effortOverride: undefined,
        })
      }
    }
    throw error
  }
}

const executeChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    requestedModel?: string
  },
) => {
  const {
    copilotSessionToken,
    initiatorOverride,
    effortOverride,
    requestedModel,
  } = options ?? {}
  const reasoningEnabled = Boolean(effortOverride || anthropicPayload.thinking)

  // In multi-token mode, reasoning_opaque is cryptographically tied to a
  // specific Copilot token. Stripping thinking blocks destroys reasoning_opaque,
  // but CAPI requires it when reasoning is enabled — missing it causes 400.
  // Preserve thinking blocks when reasoning is enabled so reasoning_opaque
  // flows through; session routing keeps requests on the same account.
  // If the signature IS invalid (wrong account), CAPI returns "Invalid
  // signature" and the retry in handleWithChatCompletions handles it.
  if (!reasoningEnabled) {
    stripThinkingBlocksForMultiToken(anthropicPayload)
  }

  const openAIPayload = translateToOpenAI(anthropicPayload)

  // Enable thinking/reasoning on the ChatCompletions path
  // Copilot API uses reasoning_effort to enable thinking (returns reasoning_text in response)
  // thinking_budget is also sent for models that support explicit budget control
  if (anthropicPayload.thinking) {
    const extra = openAIPayload as unknown as Record<string, unknown>
    const usesImplicitDefault = usesImplicitReasoningDefault(
      normalizeModelName(openAIPayload.model),
    )
    if (!usesImplicitDefault) {
      const upstreamEffort = effortOverride ?? "medium"
      if (!effortOverride) {
        recordNonDefaultBehavior(c, {
          kind: "reasoning_effort_default",
          message: `Thinking is enabled for ${openAIPayload.model}, but no explicit effort survived parsing/redirect; sending upstream reasoning_effort=${upstreamEffort}`,
          data: {
            model: openAIPayload.model,
            defaultEffort: upstreamEffort,
            thinkingType: anthropicPayload.thinking.type,
          },
        })
      }
      extra.reasoning_effort = upstreamEffort
    } else if (effortOverride) {
      recordNonDefaultBehavior(c, {
        kind: "reasoning_effort_implicit_default",
        message: `${openAIPayload.model} is configured for implicit reasoning defaults; removing explicit reasoning_effort=${effortOverride}`,
        data: {
          model: openAIPayload.model,
          requestedEffort: effortOverride,
        },
      })
    }
    // Claude requires temperature=1 when thinking is enabled
    openAIPayload.temperature = 1
    delete openAIPayload.top_p
  } else if (
    effortOverride
    && !usesImplicitReasoningDefault(normalizeModelName(openAIPayload.model))
  ) {
    // Subagent/skill requests may set output_config.effort without a thinking
    // block. Forward reasoning_effort so Copilot enables extended thinking;
    // also pin temperature=1 and drop top_p as the model requires.
    const extra = openAIPayload as unknown as Record<string, unknown>
    extra.reasoning_effort = effortOverride
    openAIPayload.temperature = 1
    delete openAIPayload.top_p
  }

  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(openAIPayload)
  if (anthropicPayload.thinking) {
    applyThinkingBudget(
      replacedPayload,
      anthropicPayload.thinking.budget_tokens,
    )
  }
  const customReference = resolveCustomChatModel(replacedPayload.model)
  if (customReference) {
    const customPayload = {
      ...replacedPayload,
      model: customReference.requestedModel,
    }
    return await executeCustomProviderChatCompletions(c, {
      reference: customReference,
      payload: customPayload,
      requestedModel,
      appliedRules,
      reasoningEffort: effortOverride,
    })
  }

  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  if (appliedRules.length > 0) {
    setRequestContext(c, { replacements: appliedRules })
  }

  await tryCountTokens(c, finalPayload)

  logger.debug("Prepared translated Chat request", {
    messageCount: finalPayload.messages.length,
    model: finalPayload.model,
    stream: Boolean(finalPayload.stream),
    toolCount: finalPayload.tools?.length ?? 0,
  })

  if (!finalPayload.stream) {
    const { initialResponse, hadWebSearch } = await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: finalPayload.messages,
        model: finalPayload.model,
      }),
      async (span) => {
        const response = (await createChatCompletions(finalPayload, {
          copilotSessionToken,
          initiator: initiatorOverride,
          signal: c.req.raw.signal,
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
        await resolveWebSearchCalls(initialResponse, finalPayload, {
          copilotSessionToken,
          initiatorOverride,
          abortSignal: c.req.raw.signal,
        })
      : initialResponse

    logger.debug("Received non-streaming Chat response", {
      choiceCount: finalResponse.choices.length,
      model: finalResponse.model,
    })

    const anthropicResponse = translateToAnthropic(
      finalResponse,
      requestedModel,
    )
    logger.debug("Translated Anthropic response", {
      blockCount: anthropicResponse.content.length,
      model: anthropicResponse.model,
    })
    return c.json(anthropicResponse)
  }

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  logger.debug("Streaming response from Copilot")
  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: finalPayload.messages,
      model: finalPayload.model,
      streaming: true,
    }),
    async (streamSpan, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const downstreamAbort = new AbortController()
        const upstreamSignal = AbortSignal.any([
          c.req.raw.signal,
          downstreamAbort.signal,
        ])
        const preflush = await raceSsePreflush(
          createChatCompletions(finalPayload, {
            copilotSessionToken,
            initiator: initiatorOverride,
            signal: upstreamSignal,
          }),
        )

        return streamSSE(c, async (stream) => {
          stream.onAbort(() => downstreamAbort.abort())

          try {
            if (preflush.kind === "pending") {
              // Returning the SSE response is not enough to reset an edge read
              // timer: write one comment immediately so headers and a body byte
              // are committed while the upstream first-event probe continues.
              await writeSseHeartbeat(stream)
            }
            const response =
              preflush.kind === "settled" ?
                preflush.value
              : unwrapSsePreflushSettlement(
                  await withHeartbeatWhilePending(preflush.pending, stream),
                )

            // Track which account handled this request (multi-token mode)
            const accountId = getLastUsedAccountId()
            if (accountId !== undefined) {
              setRequestContext(c, { accountId })
            }

            if (needsWebSearchBuffering) {
              const buffered = await streamChatCompletionsWithWebSearch(
                stream,
                withSseHeartbeat(
                  response as AsyncIterable<{ data?: string }>,
                  stream,
                ),
                requestedModel,
              )

              setChatCompletionSpanResult(streamSpan, buffered.initialResponse)

              if (buffered.hadWebSearch && buffered.initialResponse) {
                finishSpan()
                const initialResp = buffered.initialResponse
                // Runs inside the already-open stream, so heartbeating it
                // forfeits no HTTP status. The resolver loops full generations
                // plus live web fetches — easily past Cloudflare's budget.
                const resolved = await withHeartbeatWhilePending(
                  Sentry.withActiveSpan(null, () =>
                    resolveWebSearchCalls(initialResp, finalPayload, {
                      copilotSessionToken,
                      initiatorOverride,
                      abortSignal: upstreamSignal,
                    }),
                  ),
                  stream,
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
              withSseHeartbeat(
                response as AsyncIterable<{ data?: string }>,
                stream,
              ),
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
            setOptionalTokenDetails(streamSpan, directResult.cachedTokens)
            setSentryOutputMessages(streamSpan, directResult.responseText)
          } catch (error) {
            if (isAbortError(error)) return
            // Headers are already committed, so this must travel in-band.
            await emitAnthropicStreamError(stream, error)
          } finally {
            finishSpan()
          }
        })
      } catch (error) {
        finishSpan()
        throw error
      }
    },
  )
}

async function executeCustomProviderChatCompletions(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload
    requestedModel?: string
    appliedRules: Array<string>
    reasoningEffort?: ReasoningEffort
  },
) {
  const { reference, payload, requestedModel, appliedRules, reasoningEffort } =
    options
  const responseModel = requestedModel ?? payload.model

  logger.debug(
    `Routing Anthropic custom chat model ${responseModel} to ${reference.provider.id}/${reference.upstreamModel}`,
  )

  setRequestContext(c, {
    requestedModel,
    provider: reference.provider.name,
    model: reference.upstreamModel,
    replacements: appliedRules,
    reasoningEffort,
  })

  if (payload.tools?.some((tool) => tool.function.name === "web_search")) {
    return await executeCustomProviderWebSearch(c, {
      reference,
      payload,
      responseModel,
      reasoningEffort,
    })
  }

  if (!payload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: reference.upstreamModel,
      }),
      async (span) => {
        const response = (await createCustomProviderChatCompletions(
          reference,
          payload,
          { signal: c.req.raw.signal, reasoningEffort },
        )) as ChatCompletionResponse

        if (response.usage) {
          setRequestContext(c, {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          })
        }
        setChatCompletionSpanResult(span, response)

        const anthropicResponse = translateToAnthropic(response, responseModel)
        logger.debug("Translated custom provider Anthropic response", {
          blockCount: anthropicResponse.content.length,
          model: anthropicResponse.model,
        })
        return c.json(anthropicResponse)
      },
    )
  }

  return await handleCustomProviderChatCompletionStream(c, {
    reference,
    payload,
    responseModel,
    reasoningEffort,
  })
}

async function executeCustomProviderWebSearch(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload
    responseModel: string
    reasoningEffort?: ReasoningEffort
  },
) {
  const requestedStream = Boolean(options.payload.stream)
  const payload = { ...options.payload, stream: false, stream_options: null }
  const createCompletion = async (
    currentPayload: ChatCompletionsPayload,
  ): Promise<ChatCompletionResponse> =>
    (await createCustomProviderChatCompletions(
      options.reference,
      currentPayload,
      {
        signal: c.req.raw.signal,
        reasoningEffort: options.reasoningEffort,
      },
    )) as ChatCompletionResponse

  const initial = await createCompletion(payload)
  const resolved = await resolveWebSearchCalls(initial, payload, {
    abortSignal: c.req.raw.signal,
    createCompletion,
  })
  setRequestContext(c, {
    inputTokens: resolved.usage?.prompt_tokens,
    outputTokens: resolved.usage?.completion_tokens,
  })
  const result = translateToAnthropic(resolved, options.responseModel)

  if (!requestedStream) return c.json(result)
  return streamSSE(c, async (stream) => {
    await emitAnthropicResponseAsStream(stream, result)
  })
}

async function handleCustomProviderChatCompletionStream(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload
    responseModel: string
    reasoningEffort?: ReasoningEffort
  },
) {
  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: options.payload.messages,
      model: options.reference.upstreamModel,
      streaming: true,
    }),
    async (streamSpan, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const response = await createCustomProviderChatCompletions(
          options.reference,
          options.payload,
          {
            signal: c.req.raw.signal,
            reasoningEffort: options.reasoningEffort,
          },
        )

        return streamSSE(c, async (stream) => {
          try {
            const directResult = await streamChatCompletionsDirect(
              stream,
              withSseHeartbeat(
                response as AsyncIterable<{ data?: string }>,
                stream,
              ),
              options.responseModel,
            )

            setRequestContext(c, {
              inputTokens: directResult.inputTokens,
              outputTokens: directResult.outputTokens,
            })
            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              directResult.inputTokens,
            )
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              directResult.outputTokens,
            )
            setOptionalTokenDetails(streamSpan, directResult.cachedTokens)
            setSentryOutputMessages(streamSpan, directResult.responseText)
          } catch (error) {
            if (isAbortError(error)) return
            // Headers are already committed, so this must travel in-band.
            await emitAnthropicStreamError(stream, error)
          } finally {
            finishSpan()
          }
        })
      } catch (error) {
        finishSpan()
        throw error
      }
    },
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
  return SAFE_RESPONSES_STREAM_ERROR_MESSAGE
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
  cachedTokens: number
  reasoningTokens: number
  responseText: string
}> => {
  const streamState = createResponsesStreamState()
  let streamInputTokens = 0
  let streamOutputTokens = 0
  let streamCachedTokens = 0
  let streamReasoningTokens = 0
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
      streamCachedTokens =
        parsed.response.usage.input_tokens_details?.cached_tokens ?? 0
      streamReasoningTokens =
        parsed.response.usage.output_tokens_details?.reasoning_tokens ?? 0
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
    cachedTokens: streamCachedTokens,
    reasoningTokens: streamReasoningTokens,
    responseText,
  }
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    requestedModel?: string
  },
) => {
  try {
    return await executeResponsesApi(c, anthropicPayload, options)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const body = await error.response.clone().text()
      const isSignatureError =
        body.includes("Invalid signature")
        || body.includes("Invalid `signature`")
      const isReasoningBadRequest =
        body.trim() === "Bad Request"
        && Boolean(options?.effortOverride || anthropicPayload.thinking)

      if (
        (isSignatureError || isReasoningBadRequest)
        && stripThinkingBlocks(anthropicPayload)
      ) {
        const reason =
          isSignatureError ? "invalid signature" : "Bad Request with reasoning"
        recordNonDefaultBehavior(c, {
          kind: "reasoning_retry_without_thinking",
          message: `Stripped thinking blocks due to ${reason}, retrying Responses without reasoning`,
          data: {
            model: anthropicPayload.model,
            reason,
            endpoint: "Responses",
          },
        })
        delete anthropicPayload.thinking
        return await executeResponsesApi(c, anthropicPayload, {
          ...options,
          effortOverride: undefined,
        })
      }
    }
    throw error
  }
}

const executeResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    requestedModel?: string
  },
) => {
  const {
    copilotSessionToken,
    initiatorOverride,
    effortOverride,
    requestedModel,
  } = options ?? {}
  const reasoningEnabled = Boolean(effortOverride || anthropicPayload.thinking)
  if (!reasoningEnabled) {
    stripThinkingBlocksForMultiToken(anthropicPayload)
  }
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    effortOverride,
  )
  logger.debug("Prepared translated Responses request", {
    inputKind: Array.isArray(responsesPayload.input) ? "items" : "text",
    model: responsesPayload.model,
    stream: Boolean(responsesPayload.stream),
    toolCount: responsesPayload.tools?.length ?? 0,
  })

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  if (responsesPayload.stream) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return await Sentry.startSpanManual(
      createSentryChatSpanOptions({
        inputMessages: anthropicPayload.messages,
        model: anthropicPayload.model,
        streaming: true,
      }),
      async (streamSpan, finish) => {
        let spanFinished = false
        const finishSpan = () => {
          if (spanFinished) return
          spanFinished = true
          finish()
        }

        try {
          const response = await createResponses(responsesPayload, {
            copilotSessionToken,
            vision,
            initiator: initiatorOverride ?? initiator,
            signal: c.req.raw.signal,
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
                  withSseHeartbeat(response as ResponsesStream, stream),
                )

                const inputTokens =
                  buffered.initialResult?.usage?.input_tokens ?? 0
                const outputTokens =
                  buffered.initialResult?.usage?.output_tokens ?? 0
                const cachedTokens =
                  buffered.initialResult?.usage?.input_tokens_details
                    ?.cached_tokens ?? 0
                const reasoningTokens =
                  buffered.initialResult?.usage?.output_tokens_details
                    ?.reasoning_tokens ?? 0
                streamSpan.setAttribute(
                  "gen_ai.usage.input_tokens",
                  inputTokens,
                )
                streamSpan.setAttribute(
                  "gen_ai.usage.output_tokens",
                  outputTokens,
                )
                setOptionalTokenDetails(
                  streamSpan,
                  cachedTokens,
                  reasoningTokens,
                )
                setSentryOutputMessages(
                  streamSpan,
                  buffered.initialResult?.output_text ?? "",
                )

                if (buffered.hadWebSearch && buffered.initialResult) {
                  finishSpan()
                  const initialRes = buffered.initialResult
                  // Inside the open stream — see the note on the Chat
                  // Completions web-search path above.
                  const resolved = await withHeartbeatWhilePending(
                    Sentry.withActiveSpan(null, () =>
                      resolveResponsesWebSearchCalls(
                        initialRes,
                        responsesPayload,
                        {
                          copilotSessionToken,
                          vision,
                          initiator: initiatorOverride ?? initiator,
                          signal: c.req.raw.signal,
                        },
                      ),
                    ),
                    stream,
                  )
                  const anthropicResponse =
                    translateResponsesResultToAnthropic(resolved)
                  if (requestedModel) anthropicResponse.model = requestedModel
                  await emitAnthropicResponseAsStream(stream, anthropicResponse)
                }
                return
              }

              const directUsage = await streamResponsesDirect(
                stream,
                withSseHeartbeat(response as ResponsesStream, stream),
              )

              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens",
                directUsage.inputTokens,
              )
              streamSpan.setAttribute(
                "gen_ai.usage.output_tokens",
                directUsage.outputTokens,
              )
              setOptionalTokenDetails(
                streamSpan,
                directUsage.cachedTokens,
                directUsage.reasoningTokens,
              )
              setSentryOutputMessages(streamSpan, directUsage.responseText)
            } catch (error) {
              if (isAbortError(error)) return
              // Headers are already committed, so this must travel in-band.
              await emitAnthropicStreamError(stream, error)
            } finally {
              finishSpan()
            }
          })
        } catch (error) {
          finishSpan()
          throw error
        }
      },
    )
  }

  const { initialResult, hadWebSearch } = await Sentry.startSpan(
    createSentryChatSpanOptions({
      inputMessages: anthropicPayload.messages,
      model: anthropicPayload.model,
    }),
    async (span) => {
      const result = (await createResponses(responsesPayload, {
        copilotSessionToken,
        vision,
        initiator: initiatorOverride ?? initiator,
        signal: c.req.raw.signal,
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
      const cachedTokens =
        result.usage?.input_tokens_details?.cached_tokens ?? 0
      const reasoningTokens =
        result.usage?.output_tokens_details?.reasoning_tokens ?? 0
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
      span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
      setOptionalTokenDetails(span, cachedTokens, reasoningTokens)
      setSentryOutputMessages(span, result.output_text)

      return { initialResult: result, hadWebSearch }
    },
  )

  const resolved =
    hadWebSearch ?
      await resolveResponsesWebSearchCalls(initialResult, responsesPayload, {
        copilotSessionToken,
        vision,
        initiator: initiatorOverride ?? initiator,
        signal: c.req.raw.signal,
      })
    : initialResult

  logger.debug("Received non-streaming Responses result", {
    model: resolved.model,
    outputCount: resolved.output.length,
    status: resolved.status,
  })

  const anthropicResponse = translateResponsesResultToAnthropic(resolved)
  if (requestedModel) anthropicResponse.model = requestedModel
  logger.debug("Translated Anthropic response", {
    blockCount: anthropicResponse.content.length,
    model: anthropicResponse.model,
  })
  return c.json(anthropicResponse)
}

const modelExists = (id: string) =>
  state.models?.data.some((m) => m.id === id) ?? false

function createMessagesModelNotFoundError(): LocalHTTPError {
  const clientBody = {
    type: "error",
    error: {
      type: "not_found_error",
      code: "model_not_found",
      message: "The requested Copilot Messages model was not found.",
      param: "model",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 404 }),
    clientBody,
  )
}

/**
 * Route to model variants based on client signals (1m context, fast mode).
 * Mutates the payload in place.
 */
function applyModelVariantRouting(
  c: Context,
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): void {
  // 1M context via beta header → route to -1m model variant
  if (
    getCanonicalAnthropicBetaIdentifiers(anthropicBeta).has(
      "context-1m-2025-08-07",
    )
  ) {
    const candidate = `${payload.model}-1m`
    if (modelExists(candidate)) {
      recordNonDefaultBehavior(c, {
        kind: "model_variant_routing",
        message: `anthropic-beta context-1m routed ${payload.model} to ${candidate}`,
        data: {
          sourceModel: payload.model,
          targetModel: candidate,
          reason: "context-1m beta header",
        },
      })
      payload.model = candidate
    }
  }

  // Fallback: if the base model has no routable account but the -1m variant
  // does, auto-route to it. The merged model list (state.models) may include
  // models that no individual account can serve via the token pool, causing
  // routedFetch to fall back to the legacy single-token path which often 400s.
  if (!payload.model.endsWith("-1m")) {
    const hasEnabledAccount = tokenPool.hasEnabledAccountForKnownModel(
      payload.model,
    )
    if (hasEnabledAccount === undefined) {
      const candidate = `${payload.model}-1m`
      if (modelExists(candidate)) {
        recordNonDefaultBehavior(c, {
          kind: "model_fallback",
          message: `No enabled account can serve ${payload.model}; falling back to ${candidate}`,
          data: {
            sourceModel: payload.model,
            targetModel: candidate,
            reason: "no routable account for known model",
          },
        })
        payload.model = candidate
      }
    }
  }

  // Fast mode → route to -fast model variant, strip unsupported field
  if (payload.speed === "fast") {
    const candidate = `${payload.model}-fast`
    if (modelExists(candidate)) {
      recordNonDefaultBehavior(c, {
        kind: "model_variant_routing",
        message: `speed=fast routed ${payload.model} to ${candidate}`,
        data: {
          sourceModel: payload.model,
          targetModel: candidate,
          reason: "speed=fast",
        },
      })
      payload.model = candidate
    }
    recordNonDefaultBehavior(c, {
      kind: "request_field_stripped",
      message: `Removed unsupported speed=${payload.speed} before forwarding ${payload.model}`,
      data: {
        model: payload.model,
        field: "speed",
        value: payload.speed,
      },
    })
    delete payload.speed
  }
}

/**
 * Extract reasoning effort info from the Anthropic request body for logging.
 * Claude Code sends effort as `output_config.effort` (low/medium/high/max)
 * and thinking mode as `thinking.type` (enabled/adaptive).
 * When effort is omitted, this proxy defaults the effective value to "medium".
 */
function getBodyReasoningEffort(
  payload: AnthropicMessagesPayload,
): string | undefined {
  // No thinking config at all — no effort to report
  if (!payload.thinking && !payload.output_config?.effort) return undefined

  const parts: Array<string> = []

  // output_config.effort is the actual effort level (low/medium/high/max)
  // When omitted, align the log context with the proxy's runtime default.
  const effort =
    payload.output_config?.effort ?? (payload.thinking ? "medium" : undefined)
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

function getOutputConfigReasoningEffort(
  payload: AnthropicMessagesPayload,
): ReasoningEffort | undefined {
  return parseReasoningEffort(payload.output_config?.effort)
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

const hasToolReference = (toolResult: AnthropicToolResultBlock): boolean =>
  Array.isArray(toolResult.content)
  && toolResult.content.some((block) => block.type === "tool_reference")

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

    if (
      !valid
      || toolResults.length === 0
      || textBlocks.length === 0
      || toolResults.some((toolResult) => hasToolReference(toolResult))
    ) {
      continue
    }

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
