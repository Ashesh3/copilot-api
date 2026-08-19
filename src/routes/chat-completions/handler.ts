/* eslint-disable max-lines -- protocol routing, streaming, and fallback paths share request context */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { EndpointRouteDecision } from "~/lib/endpoint-routing"
import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { sessionTokenMatchesModel } from "~/lib/copilot-session-token"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
  type CustomProviderModelReference,
} from "~/lib/custom-providers"
import {
  createEndpointTranslationError,
  createInvalidJsonBodyError,
  isAbortError,
} from "~/lib/error"
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
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  setSentryOutputMessages,
  setSentryConversationIdFromRequest,
} from "~/lib/sentry"
import { withSseHeartbeat } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { getTokenCount } from "~/lib/tokenizer"
import { emitChatCompletionsToolSpans } from "~/lib/tool-spans"
import {
  createChatCompletions,
  createChatCompletionsWithProcessedPayload,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createWebSearchFunctionTool,
  isChatWebSearchFunctionTool,
  isWebSearchToolType,
} from "~/services/copilot/mcp-web-search"

import type { NativeMessagesRequestOptions } from "../messages/native-handler"

import {
  emitChatCompletionResponseAsStream,
  resolveWebSearchCalls,
} from "../messages/web-search-helpers"
import { executeAnthropicBridge } from "./anthropic-bridge"
import { normalizeChatCompletionsRequest } from "./chat-contract"
import {
  executeResponsesFallback,
  recordChatEndpointFallback,
  selectChatUpstreamEndpoint,
} from "./responses-fallback-executor"

export { selectChatUpstreamEndpoint } from "./responses-fallback-executor"

export async function handleCompletion(c: Context) {
  const rawPayload = await parseChatRequestBody(c)
  const normalizedPayload = normalizeChatCompletionsRequest(rawPayload)
  const nativeOptions: NativeMessagesRequestOptions = {
    anthropicBeta: c.req.header("anthropic-beta"),
    anthropicVersion: c.req.header("anthropic-version"),
    modelProviderPreference: c.req.header("x-model-provider-preference"),
  }
  const conversationId = setSentryConversationIdFromRequest(
    c,
    normalizedPayload,
  )

  const model = normalizeModelName(
    parseModelSuffix(normalizedPayload.model).baseModel,
  )

  return await Sentry.startSpan(
    createSentryInvokeAgentSpanOptions(model, conversationId),
    async () => {
      return await handleCompletionInner(c, normalizedPayload, nativeOptions)
    },
  )
}

async function parseChatRequestBody(
  c: Context,
): Promise<ChatCompletionsPayload> {
  try {
    return await c.req.json<ChatCompletionsPayload>()
  } catch {
    throw createInvalidJsonBodyError()
  }
}

// Route preparation intentionally stays together so model-scoped headers are
// matched only after every payload/model transformation is complete.
// eslint-disable-next-line max-lines-per-function
async function handleCompletionInner(
  c: Context,
  rawPayload: ChatCompletionsPayload,
  nativeOptions: NativeMessagesRequestOptions,
) {
  emitChatCompletionsToolSpans(rawPayload.messages)

  const requestedModel = rawPayload.model

  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    rawPayload.model,
  )
  rawPayload.model = baseModel

  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(rawPayload)

  const unnormalizedModel = replacedPayload.model
  const customReferenceBeforeCopilot = resolveCustomProviderModel({
    model: unnormalizedModel,
    kind: "chat",
    copilotModelIds: getCopilotModelIds(),
  })
  const normalizedModel = normalizeModelName(unnormalizedModel)
  const payloadEffort = getPayloadReasoningEffort(replacedPayload)
  const requestedEffort = getNormalizedRequestedEffort(c, {
    model: normalizedModel,
    suffixEffort,
    payloadEffort,
  })

  if (customReferenceBeforeCopilot) {
    convertHostedWebSearchTools(replacedPayload)
    const customPayload = {
      ...replacedPayload,
      model: unnormalizedModel,
    }
    return await executeCustomProviderRequest(c, {
      reference: customReferenceBeforeCopilot,
      payload: customPayload,
      requestedModel,
      appliedRules,
      reasoningEffort: requestedEffort,
    })
  }

  const { targetModel, reasoningEffort, redirected } =
    await resolveRedirectedModel(c, {
      model: normalizedModel,
      effort: requestedEffort,
    })
  applyRedirectedReasoningEffort({
    c,
    payload: replacedPayload,
    model: targetModel,
    effort: reasoningEffort,
  })

  let payload = {
    ...replacedPayload,
    model: targetModel,
  }
  disableParallelWebSearch(payload)

  const customReference = resolveCustomProviderModel({
    model: payload.model,
    kind: "chat",
    copilotModelIds: getCopilotModelIds(),
  })
  if (customReference) {
    convertHostedWebSearchTools(payload)
    return await executeCustomProviderRequest(c, {
      reference: customReference,
      payload,
      requestedModel,
      appliedRules,
      reasoningEffort,
    })
  }

  const modelBeforeFallback = payload.model
  payload = applyRoutableModelFallback(c, payload)
  const inboundSessionToken = c.req.header("copilot-session-token")
  const copilotSessionToken =
    (
      sessionTokenMatchesModel({
        token: inboundSessionToken,
        requestedModel: baseModel,
        finalModel: payload.model,
        modelWasRedirected:
          replacedPayload.model !== baseModel
          || redirected
          || payload.model !== modelBeforeFallback,
      })
    ) ?
      inboundSessionToken
    : undefined

  consola.debug("Prepared Chat request", {
    messageCount: payload.messages.length,
    model: payload.model,
    stream: Boolean(payload.stream),
    toolCount: payload.tools?.length ?? 0,
  })

  setRequestContext(c, {
    requestedModel,
    provider: "ChatCompletions",
    model: payload.model,
    replacements: appliedRules,
    reasoningEffort,
  })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  const decision = selectChatUpstreamEndpoint({ payload, selectedModel })
  if ("code" in decision) throw createEndpointTranslationError(decision)

  await setInputTokenContext(c, payload, selectedModel)

  if (state.manualApprove) await awaitApproval()

  return await dispatchCopilotCompletion(c, {
    payload,
    requestedModel,
    reasoningEffort,
    selectedModel,
    decision,
    nativeOptions: { ...nativeOptions, requestedModel, copilotSessionToken },
    copilotSessionToken,
  })
}

async function dispatchCopilotCompletion(
  c: Context,
  options: {
    decision: EndpointRouteDecision
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    reasoningEffort?: ReasoningEffort
    selectedModel: Model | undefined
    nativeOptions: NativeMessagesRequestOptions
    copilotSessionToken?: string
  },
) {
  const {
    decision,
    payload,
    requestedModel,
    reasoningEffort,
    selectedModel,
    nativeOptions,
    copilotSessionToken,
  } = options
  if (decision.translated) recordChatEndpointFallback(c, payload, decision)

  switch (decision.target) {
    case "/responses": {
      return await executeResponsesFallback(c, {
        payload,
        requestedModel,
        reasoningEffort,
        copilotSessionToken,
      })
    }
    case "/v1/messages": {
      return await executeAnthropicBridge(c, {
        nativeOptions,
        payload,
        selectedModel,
      })
    }
    case "/chat/completions": {
      if (payload.tools?.some((tool) => isWebSearchToolType(tool))) {
        convertHostedWebSearchTools(payload)
      }
      return await executeRequest(c, payload, {
        requestedModel,
        copilotSessionToken,
      })
    }
    default: {
      throw new Error("Unsupported Chat endpoint route")
    }
  }
}

function getCopilotModelIds(): Set<string> {
  return new Set(state.models?.data.map((model) => model.id) ?? [])
}

async function setInputTokenContext(
  c: Context,
  payload: ChatCompletionsPayload,
  selectedModel: Parameters<typeof getTokenCount>[1] | undefined,
): Promise<void> {
  if (!selectedModel) return

  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    setRequestContext(c, { inputTokens: tokenCount.input })
  } catch {
    consola.warn("Failed to calculate token count")
  }
}

async function executeCustomProviderRequest(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    appliedRules: Array<string>
    reasoningEffort?: ReasoningEffort
  },
) {
  const { reference, payload, requestedModel, appliedRules, reasoningEffort } =
    options

  consola.debug(
    `Routing custom chat model ${requestedModel} to ${reference.provider.id}/${reference.upstreamModel}`,
  )

  setRequestContext(c, {
    requestedModel,
    provider: reference.provider.name,
    model: reference.upstreamModel,
    replacements: appliedRules,
    reasoningEffort,
  })

  if (state.manualApprove) await awaitApproval()

  if (payload.tools?.some((tool) => isChatWebSearchFunctionTool(tool))) {
    return await executeCustomProviderWebSearchRequest(c, {
      reference,
      payload,
      requestedModel,
      reasoningEffort,
    })
  }

  if (payload.stream) {
    return await handleCustomProviderStreamingResponse(c, {
      reference,
      payload,
      requestedModel,
      reasoningEffort,
    })
  }

  const response = (await createCustomProviderChatCompletions(
    reference,
    payload,
    { signal: c.req.raw.signal, reasoningEffort },
  )) as ChatCompletionResponse

  return handleCustomProviderNonStreamingResponse(c, response, requestedModel)
}

function handleCustomProviderNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  requestedModel: string,
) {
  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }
  return c.json({ ...response, model: requestedModel })
}

async function handleCustomProviderStreamingResponse(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    reasoningEffort?: ReasoningEffort
  },
) {
  const response = await createCustomProviderChatCompletions(
    options.reference,
    options.payload,
    { signal: c.req.raw.signal, reasoningEffort: options.reasoningEffort },
  )

  if (isNonStreaming(response)) {
    return handleCustomProviderNonStreamingResponse(
      c,
      response,
      options.requestedModel,
    )
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of withSseHeartbeat(response, stream)) {
        let outChunk = chunk
        if (chunk.data && chunk.data !== "[DONE]") {
          const parsed = JSON.parse(chunk.data) as ChatCompletionChunk
          if (parsed.usage) {
            setRequestContext(c, {
              inputTokens: parsed.usage.prompt_tokens,
              outputTokens: parsed.usage.completion_tokens,
            })
          }
          if (parsed.model !== options.requestedModel) {
            parsed.model = options.requestedModel
            outChunk = { ...chunk, data: JSON.stringify(parsed) }
          }
        }
        await stream.writeSSE(outChunk as SSEMessage)
      }
    } catch (error) {
      if (isAbortError(error)) return
      throw error
    }
  })
}

const executeRequest = async (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: { requestedModel?: string; copilotSessionToken?: string } = {},
) => {
  const needsWebSearch =
    payload.tools?.some((tool) => isChatWebSearchFunctionTool(tool)) ?? false
  if (!payload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: payload.model,
      }),
      async (span) => {
        const { processedPayload, response } =
          await createChatCompletionsWithProcessedPayload(
            payload as ChatCompletionsPayload & { stream?: false | null },
            {
              copilotSessionToken: options.copilotSessionToken,
              signal: c.req.raw.signal,
            },
          )

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        const finalResponse =
          needsWebSearch ?
            await resolveWebSearchCalls(response, processedPayload, {
              abortSignal: c.req.raw.signal,
              copilotSessionToken: options.copilotSessionToken,
            })
          : response

        return handleNonStreamingResponse(c, finalResponse, {
          span,
          requestedModel: options.requestedModel,
        })
      },
    )
  }

  if (needsWebSearch) {
    return await executeStreamingWebSearchRequest(c, payload, options)
  }

  return await handleStreamingResponse(c, payload, options)
}

async function executeCustomProviderWebSearchRequest(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
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
  const result = { ...resolved, model: options.requestedModel }

  if (result.usage) {
    setRequestContext(c, {
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    })
  }

  if (!requestedStream) return c.json(result)
  return streamSSE(c, async (stream) => {
    await emitChatCompletionResponseAsStream(stream, result)
  })
}

function convertHostedWebSearchTools(payload: ChatCompletionsPayload): void {
  if (!payload.tools) return
  payload.tools = payload.tools.map((tool) =>
    isWebSearchToolType(tool) ? createWebSearchFunctionTool(tool) : tool,
  )
  payload.parallel_tool_calls = false
}

function disableParallelWebSearch(payload: ChatCompletionsPayload): void {
  if (
    Array.isArray(payload.tools)
    && payload.tools.some((tool) => isChatWebSearchFunctionTool(tool))
  ) {
    payload.parallel_tool_calls = false
  }
}

async function executeStreamingWebSearchRequest(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: { requestedModel?: string; copilotSessionToken?: string },
) {
  const bufferedPayload = { ...payload, stream: false as const }
  return await Sentry.startSpan(
    createSentryChatSpanOptions({
      inputMessages: payload.messages,
      model: payload.model,
      streaming: true,
    }),
    async (span) => {
      const { processedPayload, response: initial } =
        await createChatCompletionsWithProcessedPayload(bufferedPayload, {
          copilotSessionToken: options.copilotSessionToken,
          signal: c.req.raw.signal,
        })
      const finalResponse = await resolveWebSearchCalls(
        initial,
        processedPayload,
        {
          abortSignal: c.req.raw.signal,
          copilotSessionToken: options.copilotSessionToken,
        },
      )
      const response =
        options.requestedModel ?
          { ...finalResponse, model: options.requestedModel }
        : finalResponse
      setChatCompletionSpanResult(span, response)
      return streamSSE(c, async (stream) => {
        await emitChatCompletionResponseAsStream(stream, response)
      })
    },
  )
}

function setChatCompletionSpanResult(
  span: Sentry.Span,
  response: ChatCompletionResponse,
): void {
  span.setAttribute(
    "gen_ai.usage.input_tokens",
    response.usage?.prompt_tokens ?? 0,
  )
  span.setAttribute(
    "gen_ai.usage.output_tokens",
    response.usage?.completion_tokens ?? 0,
  )
  setSentryOutputMessages(span, response.choices[0]?.message?.content ?? "")
}

function getPayloadReasoningEffort(
  payload: ChatCompletionsPayload,
): ReasoningEffort | undefined {
  const effort = (payload as unknown as Record<string, unknown>)
    .reasoning_effort
  return parseReasoningEffort(effort)
}

function getNormalizedRequestedEffort(
  c: Context,
  options: {
    model: string
    suffixEffort?: ReasoningEffort
    payloadEffort?: ReasoningEffort
  },
): ReasoningEffort | undefined {
  const requestedRawEffort = options.suffixEffort ?? options.payloadEffort
  const requestedEffort = normalizeReasoningEffortForModel(
    options.model,
    requestedRawEffort,
  )
  if (requestedRawEffort && requestedEffort !== requestedRawEffort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested effort ${requestedRawEffort} for ${options.model} was clamped to ${requestedEffort}`,
      data: {
        model: options.model,
        requestedEffort: requestedRawEffort,
        effectiveEffort: requestedEffort,
      },
    })
  }
  return requestedEffort
}

async function resolveRedirectedModel(
  c: Context,
  request: { model: string; effort?: ReasoningEffort },
): Promise<{
  reasoningEffort?: ReasoningEffort
  redirected: boolean
  targetModel: string
}> {
  const redirect = await applyModelRedirect(request)
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: request.model,
        sourceEffort: request.effort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }

  const targetModel = normalizeModelName(redirect.model)
  const reasoningEffort = normalizeReasoningEffortForModel(
    targetModel,
    redirect.effort,
  )
  reportClampedRedirectEffort(c, {
    model: targetModel,
    requestedEffort: redirect.effort,
    effectiveEffort: reasoningEffort,
  })
  return { targetModel, reasoningEffort, redirected: redirect.redirected }
}

function reportClampedRedirectEffort(
  c: Context,
  options: {
    model: string
    requestedEffort?: ReasoningEffort
    effectiveEffort?: ReasoningEffort
  },
): void {
  if (
    !options.requestedEffort
    || options.effectiveEffort === options.requestedEffort
  ) {
    return
  }
  recordNonDefaultBehavior(c, {
    kind: "reasoning_effort_clamped",
    message: `Requested redirected effort ${options.requestedEffort} for ${options.model} was clamped to ${options.effectiveEffort}`,
    data: {
      model: options.model,
      requestedEffort: options.requestedEffort,
      effectiveEffort: options.effectiveEffort,
    },
  })
}

function applyRoutableModelFallback(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
): ChatCompletionsPayload & { model: string } {
  if (
    payload.model.endsWith("-1m")
    || tokenPool.hasEnabledAccountForKnownModel(payload.model) !== undefined
  ) {
    return payload
  }

  const candidate = `${payload.model}-1m`
  if (!state.models?.data.some((m) => m.id === candidate)) return payload

  recordNonDefaultBehavior(c, {
    kind: "model_fallback",
    message: `No enabled account can serve ${payload.model}; falling back to ${candidate}`,
    data: {
      sourceModel: payload.model,
      targetModel: candidate,
      reason: "no routable account for known model",
    },
  })
  return { ...payload, model: candidate }
}

function applyRedirectedReasoningEffort(options: {
  c: Context
  payload: ChatCompletionsPayload
  model: string
  effort: ReasoningEffort | undefined
}): void {
  const extra = options.payload as unknown as Record<string, unknown>
  if (!options.effort) {
    delete extra.reasoning_effort
    return
  }
  if (usesImplicitReasoningDefault(options.model)) {
    recordNonDefaultBehavior(options.c, {
      kind: "reasoning_effort_implicit_default",
      message: `${options.model} is configured for implicit reasoning defaults; removing explicit reasoning_effort=${options.effort}`,
      data: {
        model: options.model,
        requestedEffort: options.effort,
      },
    })
    delete extra.reasoning_effort
    return
  }
  extra.reasoning_effort = options.effort
}

const handleNonStreamingResponse = (
  c: Context,
  response: ChatCompletionResponse,
  context: { span: Sentry.Span; requestedModel?: string },
) => {
  const { span, requestedModel } = context
  consola.debug("Received non-streaming Chat response", {
    choiceCount: response.choices.length,
    model: response.model,
  })
  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }

  span.setAttribute(
    "gen_ai.usage.input_tokens",
    response.usage?.prompt_tokens ?? 0,
  )
  span.setAttribute(
    "gen_ai.usage.output_tokens",
    response.usage?.completion_tokens ?? 0,
  )
  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
  if (cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", cachedTokens)
  }
  setSentryOutputMessages(span, response.choices[0]?.message?.content ?? "")

  if (requestedModel) {
    return c.json({ ...response, model: requestedModel })
  }
  return c.json(response)
}

const handleStreamingResponse = (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: { requestedModel?: string; copilotSessionToken?: string },
) => {
  consola.debug("Streaming response")
  return Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: payload.messages,
      model: payload.model,
      streaming: true,
    }),
    async (span, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const response = await createChatCompletions(payload, {
          copilotSessionToken: options.copilotSessionToken,
          signal: c.req.raw.signal,
        })

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        if (isNonStreaming(response)) {
          const result = handleNonStreamingResponse(c, response, {
            span,
            requestedModel: options.requestedModel,
          })
          finishSpan()
          return result
        }

        return streamSSE(c, async (stream) => {
          try {
            let streamInputTokens = 0
            let streamOutputTokens = 0
            let streamCachedTokens = 0

            for await (const chunk of withSseHeartbeat(response, stream)) {
              let outChunk = chunk
              // Capture usage from final chunk if available
              if (chunk.data && chunk.data !== "[DONE]") {
                const parsed = JSON.parse(chunk.data) as ChatCompletionChunk
                if (parsed.usage) {
                  streamInputTokens = parsed.usage.prompt_tokens
                  streamOutputTokens = parsed.usage.completion_tokens
                  streamCachedTokens =
                    parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
                  setRequestContext(c, {
                    inputTokens: parsed.usage.prompt_tokens,
                    outputTokens: parsed.usage.completion_tokens,
                  })
                }
                if (
                  options.requestedModel
                  && parsed.model !== options.requestedModel
                ) {
                  parsed.model = options.requestedModel
                  outChunk = { ...chunk, data: JSON.stringify(parsed) }
                }
              }
              await stream.writeSSE(outChunk as SSEMessage)
            }

            // Set token attributes after streaming completes - span is still open.
            span.setAttribute("gen_ai.usage.input_tokens", streamInputTokens)
            span.setAttribute("gen_ai.usage.output_tokens", streamOutputTokens)
            if (streamCachedTokens > 0) {
              span.setAttribute(
                "gen_ai.usage.input_tokens.cached",
                streamCachedTokens,
              )
            }
          } catch (error) {
            if (isAbortError(error)) return
            throw error
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

const isNonStreaming = (
  response: unknown,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")
