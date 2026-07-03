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
import { isAbortError } from "~/lib/error"
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
import { checkRateLimit } from "~/lib/rate-limit"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  addPromptCaching,
  detectInitiator,
  hasVisionContent,
} from "~/services/copilot/copilot-client"
import {
  createAnthropicMessages,
  modelSupportsNativeMessages,
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
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import type { AnthropicResponse } from "../messages/anthropic-types"
import type { GoogleAIRequest } from "./google-ai-types"

import {
  chatPayloadToAnthropic,
  streamAnthropicAsChatCompletions,
  anthropicResponseToChat,
} from "../chat-completions/anthropic-bridge"
import { chatCompletionsToResponses } from "../chat-completions/responses-fallback"
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

const RESPONSES_ENDPOINT = "/responses"

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
    if (tool.googleSearch) {
      unsupported.add("googleSearch")
    }
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
    return { model: modelAction, action: "generateContent" }
  }
  return {
    model: modelAction.slice(0, colonIdx),
    action: modelAction.slice(colonIdx + 1),
  }
}

/**
 * Cap max_tokens at the model's advertised limit to prevent 400 errors.
 */
function capMaxTokens(
  c: Context,
  payload: ChatCompletionsPayload,
  selectedModel: Model | undefined,
): void {
  const maxAllowed = selectedModel?.capabilities.limits?.max_output_tokens
  if (!maxAllowed) return

  if (isNullish(payload.max_tokens)) {
    payload.max_tokens = maxAllowed
  } else if (payload.max_tokens > maxAllowed) {
    recordNonDefaultBehavior(c, {
      kind: "max_tokens_capped",
      message: `Capping max_tokens from ${payload.max_tokens} to ${maxAllowed} for ${payload.model}`,
      data: {
        model: payload.model,
        requestedMaxTokens: payload.max_tokens,
        effectiveMaxTokens: maxAllowed,
      },
    })
    payload.max_tokens = maxAllowed
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
  await checkRateLimit(state)

  // Extract model and action from URL path
  // URL path: /v1/models/{model}:{action} or /models/{model}:{action}
  const modelAction = c.req.param("modelAction")
  if (!modelAction) {
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

  const { model: rawModel, action } = parseModelAction(modelAction)
  const isStream = action === "streamGenerateContent"

  // Apply silent model redirect — google-ai response format does not include
  // a model field, so client-facing transparency is automatic.
  const { model, reasoningEffort } = await resolveGoogleModelRedirect(
    c,
    rawModel,
  )

  logger.debug(`Google AI request: model=${model}, action=${action}`)

  // Parse Google AI request body
  const googlePayload = await c.req.json<GoogleAIRequest>()
  logger.debug("Google AI request payload:", JSON.stringify(googlePayload))

  // Inline http(s) fileData attachments (upstream rejects external URLs)
  await inlineGoogleFileData(googlePayload)

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

  // Determine API type based on supported_endpoints
  const useResponsesApi =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  setRequestContext(c, {
    requestedModel: rawModel,
    model: finalPayload.model,
    provider:
      useResponsesApi ? "GoogleAI→Responses" : "GoogleAI→ChatCompletions",
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

  capMaxTokens(c, finalPayload, selectedModel)

  consola.debug(
    `[google-ai] Translated payload: model=${finalPayload.model}, max_tokens=${finalPayload.max_tokens}, stream=${finalPayload.stream}, tools=${finalPayload.tools?.length ?? 0}, messages=${finalPayload.messages.length}`,
  )
  logger.debug("Translated OpenAI payload:", JSON.stringify(finalPayload))

  return await dispatchGoogleRequest(c, {
    finalPayload,
    selectedModel,
    useResponsesApi,
    isStream,
    reasoningEffort,
  })
}

/** Route to the correct upstream API based on model capabilities. */
async function dispatchGoogleRequest(
  c: Context,
  options: {
    finalPayload: ChatCompletionsPayload & { model: string }
    selectedModel: Model | undefined
    useResponsesApi: boolean
    isStream: boolean
    reasoningEffort?: ReasoningEffort
  },
) {
  const { finalPayload, selectedModel, useResponsesApi, isStream } = options

  if (useResponsesApi) {
    consola.debug(`[google-ai] Using Responses API for ${finalPayload.model}`)
    return await handleWithResponsesApi(c, finalPayload, {
      isStream,
      effortOverride: options.reasoningEffort,
    })
  }

  // PDF file parts cannot ride /chat/completions upstream; claude models
  // accept them natively via /v1/messages
  if (
    payloadHasFileParts(finalPayload)
    && modelSupportsNativeMessages(selectedModel)
  ) {
    consola.debug(
      `[google-ai] Using native /v1/messages for ${finalPayload.model} (PDF attachment)`,
    )
    return await handleWithAnthropicMessages(c, finalPayload, {
      selectedModel,
      isStream,
    })
  }

  consola.debug(
    `[google-ai] Using ChatCompletions API for ${finalPayload.model}`,
  )
  return await handleWithChatCompletions(c, finalPayload)
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

      for await (const rawEvent of response) {
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

// ─── Native /v1/messages path (claude models with PDF attachments) ───

async function handleWithAnthropicMessages(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: { selectedModel?: Model; isStream: boolean },
) {
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message: `PDF file attachment routed ${payload.model} to native /v1/messages`,
    data: {
      model: payload.model,
      sourceEndpoint: "ChatCompletions",
      targetEndpoint: "AnthropicMessages",
    },
  })
  setRequestContext(c, { provider: "GoogleAI→AnthropicMessages" })

  const anthropicPayload = await chatPayloadToAnthropic(
    payload,
    options.selectedModel,
  )
  const response = await createAnthropicMessages(anthropicPayload, {
    signal: c.req.raw.signal,
  })

  const nativeAccountId = getLastUsedAccountId()
  if (nativeAccountId !== undefined) {
    setRequestContext(c, { accountId: nativeAccountId })
  }

  if (!options.isStream || !isAsyncIterable(response)) {
    const chatResponse = anthropicResponseToChat(
      response as AnthropicResponse,
      payload.model,
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
        response as AsyncIterable<AnthropicStreamChunk>,
        payload.model,
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
    logger.debug(
      "Non-streaming Responses result:",
      JSON.stringify(result).slice(-400),
    )

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

      for await (const chunk of response) {
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

const isNonStreamingCC = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
