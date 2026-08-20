/**
 * Handler for Google Generative AI API format.
 * Accepts requests at /v1/models/{model}:generateContent and
 * /v1/models/{model}:streamGenerateContent?alt=sse
 *
 * Translates Google ↔ OpenAI ChatCompletions format to proxy through Copilot.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import {
  type EndpointRouteDecision,
  type EndpointRouteFailure,
} from "~/lib/endpoint-routing"
import { createEndpointTranslationError, isAbortError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import { withSseHeartbeat } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  addPromptCaching,
  detectInitiator,
  hasVisionContent,
} from "~/services/copilot/copilot-client"
import {
  createAnthropicMessages,
  detectAnthropicInitiator,
  type AnthropicStreamChunk,
} from "~/services/copilot/create-anthropic-messages"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import {
  isChatWebSearchFunctionTool,
  isResponsesWebSearchFunctionTool,
} from "~/services/copilot/mcp-web-search"
import { sanitizeAnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"

import type { AnthropicResponse } from "../messages/anthropic-types"
import type { GoogleAIRequest } from "./google-ai-types"

import {
  chatPayloadToAnthropic,
  streamAnthropicAsChatCompletions,
  anthropicResponseToChat,
} from "../chat-completions/anthropic-bridge"
import { chatCompletionsToResponses } from "../chat-completions/responses-fallback"
import { selectChatUpstreamEndpoint } from "../chat-completions/responses-fallback-executor"
import {
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "../messages/web-search-helpers"
import {
  inlineGoogleFileData,
  translateGoogleToOpenAI,
} from "./request-translation"
import {
  createGoogleStreamState,
  translateChunkToGoogle,
  translateOpenAIToGoogle,
  translateResponsesResultToGoogle,
  translateResponsesStreamEventToGoogle,
} from "./response-translation"

const logger = createHandlerLogger("google-ai-handler")

const GOOGLE_ACTIONS = new Set(["generateContent", "streamGenerateContent"])

function googleActionError(c: Context, message: string): Response {
  return c.json(
    {
      error: {
        code: 400,
        message,
        status: "INVALID_ARGUMENT",
      },
    },
    400,
  )
}

function missingGoogleModelAction(c: Context): Response {
  return c.json(
    {
      error: {
        code: 400,
        message: "Missing model and action in URL path",
        status: "INVALID_ARGUMENT",
      },
    },
    400,
  )
}

function getUnsupportedGoogleRootFields(
  payload: GoogleAIRequest,
): Array<string> {
  const unsupported: Array<string> = []

  if (payload.cachedContent !== undefined) {
    unsupported.push("cachedContent")
  }
  if (payload.labels !== undefined) {
    unsupported.push("labels")
  }
  if (payload.safetySettings !== undefined) {
    unsupported.push("safetySettings")
  }

  return unsupported
}

function getUnsupportedGoogleToolTypes(
  payload: GoogleAIRequest,
): Array<string> {
  const unsupported = new Set<string>()

  for (const tool of payload.tools ?? []) {
    if (tool.codeExecution) {
      unsupported.add("codeExecution")
    }
  }

  return [...unsupported]
}

/**
 * Parse model name and action from the URL path segment.
 * e.g. "gemini-3-flash-preview:streamGenerateContent" → { model: "gemini-3-flash-preview", action: "streamGenerateContent" }
 */
function parseModelAction(modelAction: string): {
  model: string
  action: string
} {
  const colonIdx = modelAction.lastIndexOf(":")
  if (colonIdx === -1) {
    return { model: modelAction, action: "" }
  }
  return {
    model: modelAction.slice(0, colonIdx),
    action: modelAction.slice(colonIdx + 1),
  }
}

async function resolveGoogleModelRedirect(
  c: Context,
  rawModel: string,
): Promise<{
  model: string
  reasoningEffort?: ReasoningEffort
}> {
  const { baseModel, reasoningEffort: suffixEffort } =
    parseModelSuffix(rawModel)
  const model = normalizeModelName(baseModel)
  const requestedEffort = normalizeReasoningEffortForModel(model, suffixEffort)
  if (suffixEffort && requestedEffort !== suffixEffort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested effort ${suffixEffort} for ${model} was clamped to ${requestedEffort}`,
      data: {
        model,
        requestedEffort: suffixEffort,
        effectiveEffort: requestedEffort,
      },
    })
  }
  const redirect = await applyModelRedirect({
    model,
    effort: requestedEffort,
  })
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: model,
        sourceEffort: requestedEffort,
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
  if (redirect.effort && reasoningEffort !== redirect.effort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested redirected effort ${redirect.effort} for ${targetModel} was clamped to ${reasoningEffort}`,
      data: {
        model: targetModel,
        requestedEffort: redirect.effort,
        effectiveEffort: reasoningEffort,
      },
    })
  }
  return {
    model: targetModel,
    reasoningEffort,
  }
}

export async function handleGoogleAI(c: Context) {
  setRequestContext(c, { suppressModelDiagnostics: true })
  // Extract model and action from URL path
  // URL path: /v1/models/{model}:{action} or /models/{model}:{action}
  const modelAction = c.req.param("modelAction")
  if (!modelAction) return missingGoogleModelAction(c)

  const { model: rawModel, action } = parseModelAction(modelAction)
  if (!action) {
    return googleActionError(c, "Missing Google AI action suffix")
  }
  if (!GOOGLE_ACTIONS.has(action)) {
    return googleActionError(c, "Unsupported Google AI action")
  }
  const isStream = action === "streamGenerateContent"

  // Apply silent model redirect — google-ai response format does not include
  // a model field, so client-facing transparency is automatic.
  const { model, reasoningEffort } = await resolveGoogleModelRedirect(
    c,
    rawModel,
  )

  logger.debug("Google AI request")

  // Parse Google AI request body
  const googlePayload = await c.req.json<GoogleAIRequest>()
  logger.debug("Google AI request payload:", JSON.stringify(googlePayload))

  // Inline http(s) fileData attachments (upstream rejects external URLs)
  await inlineGoogleFileData(googlePayload, c.req.raw.signal)

  const unsupportedRootFields = getUnsupportedGoogleRootFields(googlePayload)
  if (unsupportedRootFields.length > 0) {
    return c.json(
      {
        error: {
          code: 400,
          message: `Unsupported Google AI request field(s): ${unsupportedRootFields.join(", ")}`,
          status: "INVALID_ARGUMENT",
        },
      },
      400,
    )
  }

  const unsupportedToolTypes = getUnsupportedGoogleToolTypes(googlePayload)
  if (unsupportedToolTypes.length > 0) {
    return c.json(
      {
        error: {
          code: 400,
          message: `Unsupported Google AI tool type(s): ${unsupportedToolTypes.join(", ")}`,
          status: "INVALID_ARGUMENT",
        },
      },
      400,
    )
  }

  // Translate Google → OpenAI ChatCompletions format
  const openAIPayload = translateGoogleToOpenAI(googlePayload, model, isStream)
  applyGoogleReasoningEffort(c, openAIPayload, reasoningEffort)

  // Apply auto-replacements
  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(openAIPayload)
  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  // Find the selected model for token counting and capability checks
  const selectedModel = state.models?.data.find(
    (m) => m.id === finalPayload.model,
  )

  const routeDecision = selectGoogleUpstreamEndpoint({
    payload: finalPayload,
    selectedModel,
  })
  if ("code" in routeDecision) {
    throw createEndpointTranslationError(routeDecision)
  }

  setRequestContext(c, {
    requestedModel: rawModel,
    model: finalPayload.model,
    provider: googleProviderName(routeDecision.target),
    replacements: appliedRules,
    reasoningEffort,
  })

  // Calculate token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(finalPayload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch {
    // Token counting is best-effort
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  consola.debug(
    `[google-ai] Translated payload: max_tokens=${finalPayload.max_tokens}, stream=${finalPayload.stream}, tools=${finalPayload.tools?.length ?? 0}, messages=${finalPayload.messages.length}`,
  )
  logger.debug("Translated OpenAI payload:", JSON.stringify(finalPayload))

  return await dispatchGoogleRequest(c, {
    finalPayload,
    requestedModel: rawModel,
    routeDecision,
    selectedModel,
    isStream,
    reasoningEffort,
  })
}

/** Route to the correct upstream API based on model capabilities. */
async function dispatchGoogleRequest(
  c: Context,
  options: {
    finalPayload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    routeDecision: EndpointRouteDecision
    selectedModel: Model | undefined
    isStream: boolean
    reasoningEffort?: ReasoningEffort
  },
) {
  const { finalPayload, routeDecision, selectedModel, isStream } = options

  if (routeDecision.target === "/responses") {
    consola.debug("[google-ai] Using Responses API")
    return await handleWithResponsesApi(c, finalPayload, {
      isStream,
      effortOverride: options.reasoningEffort,
    })
  }

  if (routeDecision.target === "/v1/messages") {
    consola.debug("[google-ai] Using native /v1/messages")
    return await handleWithAnthropicMessages(c, finalPayload, {
      requestedModel: options.requestedModel,
      selectedModel,
      isStream,
    })
  }

  consola.debug("[google-ai] Using ChatCompletions API")
  return await handleWithChatCompletions(c, finalPayload)
}

export function selectGoogleUpstreamEndpoint(options: {
  payload: ChatCompletionsPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure {
  return selectChatUpstreamEndpoint(options)
}

function googleProviderName(endpoint: EndpointRouteDecision["target"]): string {
  switch (endpoint) {
    case "/responses": {
      return "GoogleAI→Responses"
    }
    case "/v1/messages": {
      return "GoogleAI→AnthropicMessages"
    }
    case "/chat/completions": {
      return "GoogleAI→ChatCompletions"
    }
    default: {
      return "GoogleAI"
    }
  }
}

function payloadHasFileParts(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === "file"),
  )
}

function applyGoogleReasoningEffort(
  c: Context,
  payload: ChatCompletionsPayload,
  effort: ReasoningEffort | undefined,
): void {
  const extra = payload as unknown as Record<string, unknown>
  if (!effort) {
    delete extra.reasoning_effort
    return
  }
  if (usesImplicitReasoningDefault(payload.model)) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_implicit_default",
      message: `${payload.model} is configured for implicit reasoning defaults; removing explicit reasoning_effort=${effort}`,
      data: {
        model: payload.model,
        requestedEffort: effort,
      },
    })
    delete extra.reasoning_effort
    return
  }
  extra.reasoning_effort = effort
}

// ─── ChatCompletions path ───

async function handleWithChatCompletions(
  c: Context,
  finalPayload: ChatCompletionsPayload,
) {
  const needsWebSearch =
    finalPayload.tools?.some((tool) => isChatWebSearchFunctionTool(tool))
    ?? false
  if (needsWebSearch) {
    return await handleChatCompletionsWithWebSearch(c, finalPayload)
  }

  const response = await createChatCompletions(finalPayload, {
    signal: c.req.raw.signal,
  })

  // Track which account handled this request (multi-token mode)
  const ccAccountId = getLastUsedAccountId()
  if (ccAccountId !== undefined) {
    setRequestContext(c, { accountId: ccAccountId })
  }

  // ─── Non-Streaming Response ───
  if (isNonStreamingCC(response)) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )

    if (response.usage) {
      setRequestContext(c, {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      })
    }

    const googleResponse = translateOpenAIToGoogle(response)
    return c.json(googleResponse)
  }

  // ─── Streaming Response ───
  logger.debug("Streaming response from Copilot")

  return streamSSE(c, async (stream) => {
    try {
      const streamState = createGoogleStreamState()

      for await (const rawEvent of withSseHeartbeat(response, stream)) {
        logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

        // Capture usage for logging
        if (chunk.usage) {
          setRequestContext(c, {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          })
        }

        const googleChunk = translateChunkToGoogle(chunk, streamState)
        if (googleChunk) {
          await stream.writeSSE({
            data: JSON.stringify(googleChunk),
          })
        }
      }
    } catch (error) {
      if (isAbortError(error)) return
      throw error
    }
  })
}

async function handleChatCompletionsWithWebSearch(
  c: Context,
  payload: ChatCompletionsPayload,
) {
  const requestedStream = Boolean(payload.stream)
  const bufferedPayload = { ...payload, stream: false }
  const initial = (await createChatCompletions(bufferedPayload, {
    signal: c.req.raw.signal,
  })) as ChatCompletionResponse
  const result = await resolveWebSearchCalls(initial, bufferedPayload, {
    abortSignal: c.req.raw.signal,
  })

  if (result.usage) {
    setRequestContext(c, {
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    })
  }

  if (!requestedStream) return c.json(translateOpenAIToGoogle(result))

  return streamSSE(c, async (stream) => {
    const streamState = createGoogleStreamState()
    for (const choice of result.choices) {
      const chunk: ChatCompletionChunk = {
        id: result.id,
        object: "chat.completion.chunk",
        created: result.created,
        model: result.model,
        choices: [
          {
            index: choice.index,
            delta: {
              role: "assistant",
              content: choice.message.content,
              reasoning_text: choice.message.reasoning_text,
              reasoning_opaque: choice.message.reasoning_opaque,
              tool_calls: choice.message.tool_calls?.map((toolCall, index) => ({
                ...toolCall,
                index,
              })),
            },
            finish_reason: choice.finish_reason,
            logprobs: choice.logprobs,
          },
        ],
      }
      const googleChunk = translateChunkToGoogle(chunk, streamState)
      if (googleChunk) {
        await stream.writeSSE({ data: JSON.stringify(googleChunk) })
      }
    }
  })
}

// ─── Native /v1/messages path ───

async function handleWithAnthropicMessages(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: {
    selectedModel?: Model
    isStream: boolean
    requestedModel: string
  },
) {
  const reason =
    payloadHasFileParts(payload) ? "PDF file attachment" : undefined
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message:
      reason ?
        `${reason} routed ${payload.model} to native /v1/messages`
      : `Model ${payload.model} routed to native /v1/messages`,
    data: {
      model: payload.model,
      sourceEndpoint: "GoogleAI",
      targetEndpoint: "AnthropicMessages",
      ...(reason ? { reason } : {}),
    },
  })
  setRequestContext(c, { provider: "GoogleAI→AnthropicMessages" })

  const anthropicPayload = await chatPayloadToAnthropic(
    payload,
    options.selectedModel,
    c.req.raw.signal,
  )
  const nativeOptions = sanitizeAnthropicRequestHeaderOptions({
    anthropicBeta: c.req.header("anthropic-beta"),
    anthropicVersion: c.req.header("anthropic-version"),
    modelProviderPreference: c.req.header("x-model-provider-preference"),
  })
  const response = await createAnthropicMessages(anthropicPayload, {
    ...nativeOptions,
    initiator: detectAnthropicInitiator(anthropicPayload.messages),
    signal: c.req.raw.signal,
  })

  const nativeAccountId = getLastUsedAccountId()
  if (nativeAccountId !== undefined) {
    setRequestContext(c, { accountId: nativeAccountId })
  }

  if (!options.isStream || !isAsyncIterable(response)) {
    const chatResponse = anthropicResponseToChat(
      response as AnthropicResponse,
      options.requestedModel,
    )
    if (chatResponse.usage) {
      setRequestContext(c, {
        inputTokens: chatResponse.usage.prompt_tokens,
        outputTokens: chatResponse.usage.completion_tokens,
      })
    }
    return c.json(translateOpenAIToGoogle(chatResponse))
  }

  // Anthropic SSE → ChatCompletions chunks → Google chunks
  return streamSSE(c, async (stream) => {
    try {
      const googleState = createGoogleStreamState()
      const chunkShim = {
        writeSSE: async ({ data }: { data: string }) => {
          if (data === "[DONE]") return
          const chunk = JSON.parse(data) as ChatCompletionChunk
          if (!Array.isArray(chunk.choices)) return
          if (chunk.usage) {
            setRequestContext(c, {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            })
          }
          const googleChunk = translateChunkToGoogle(chunk, googleState)
          if (googleChunk) {
            await stream.writeSSE({ data: JSON.stringify(googleChunk) })
          }
        },
      }
      await streamAnthropicAsChatCompletions(
        chunkShim,
        withSseHeartbeat(
          response as AsyncIterable<AnthropicStreamChunk>,
          stream,
        ),
        options.requestedModel,
      )
    } catch (error) {
      if (isAbortError(error)) return
      throw error
    }
  })
}

// ─── Responses API path ───

async function handleWithResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: { isStream: boolean; effortOverride?: ReasoningEffort },
) {
  const { isStream, effortOverride } = options
  addPromptCaching(payload.messages, payload.tools ?? undefined)
  // Shared converter carries image_url and file parts through to
  // input_image/input_file (the local converter used to drop them)
  const responsesPayload = chatCompletionsToResponses(payload, effortOverride)
  const vision = hasVisionContent(payload.messages)
  const initiator = detectInitiator(payload.messages)
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  if (
    responsesPayload.tools?.some((tool) =>
      isResponsesWebSearchFunctionTool(tool),
    )
  ) {
    return await handleResponsesMcpWebSearch(c, responsesPayload, {
      isStream,
      vision,
      initiator,
    })
  }

  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    signal: c.req.raw.signal,
  })

  // Track which account handled this request (multi-token mode)
  const respAccountId = getLastUsedAccountId()
  if (respAccountId !== undefined) {
    setRequestContext(c, { accountId: respAccountId })
  }

  // ─── Non-streaming ───
  if (!isStream || !isAsyncIterable(response)) {
    const result = response as ResponsesResult
    logger.debug("Non-streaming Responses result:", JSON.stringify(result))

    if (result.usage) {
      setRequestContext(c, {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      })
    }

    const googleResponse = translateResponsesResultToGoogle(result)
    return c.json(googleResponse)
  }

  // ─── Streaming ───
  logger.debug("Streaming response from Copilot (Responses API)")

  return streamSSE(c, async (stream) => {
    try {
      const streamState = createGoogleStreamState()

      for await (const chunk of withSseHeartbeat(response, stream)) {
        const eventName = chunk.event
        if (eventName === "ping") continue

        const data = chunk.data
        if (!data) continue

        logger.debug("Responses raw stream event:", data)

        const parsed = JSON.parse(data) as ResponseStreamEvent
        const googleChunk = translateResponsesStreamEventToGoogle(
          parsed,
          streamState,
        )

        if (!googleChunk) continue

        // Capture usage from completed response
        const isCompleted =
          parsed.type === "response.completed"
          || parsed.type === "response.incomplete"
        if (isCompleted && parsed.response.usage) {
          setRequestContext(c, {
            inputTokens: parsed.response.usage.input_tokens,
            outputTokens: parsed.response.usage.output_tokens,
          })
        }

        await stream.writeSSE({
          data: JSON.stringify(googleChunk),
        })
      }
    } catch (error) {
      if (isAbortError(error)) return
      throw error
    }
  })
}

async function handleResponsesMcpWebSearch(
  c: Context,
  payload: ResponsesPayload,
  options: {
    isStream: boolean
    vision: boolean
    initiator: "agent" | "user"
  },
) {
  payload.stream = false
  const requestOptions = {
    vision: options.vision,
    initiator: options.initiator,
    signal: c.req.raw.signal,
  }
  const initial = (await createResponses(
    payload,
    requestOptions,
  )) as ResponsesResult
  const result = await resolveResponsesWebSearchCalls(
    initial,
    payload,
    requestOptions,
  )

  const accountId = getLastUsedAccountId()
  if (accountId !== undefined) setRequestContext(c, { accountId })
  if (result.usage) {
    setRequestContext(c, {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    })
  }
  const googleResponse = translateResponsesResultToGoogle(result)
  if (!options.isStream) return c.json(googleResponse)

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify(googleResponse) })
  })
}

const isNonStreamingCC = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
