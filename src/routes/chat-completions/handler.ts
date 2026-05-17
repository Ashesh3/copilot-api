import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
  type CustomProviderModelReference,
} from "~/lib/custom-providers"
import { isAbortError } from "~/lib/error"
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
import { getSentryModelName, shouldRecordAiContent } from "~/lib/sentry"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { getTokenCount } from "~/lib/tokenizer"
import { emitChatCompletionsToolSpans } from "~/lib/tool-spans"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const rawPayload = await c.req.json<ChatCompletionsPayload>()

  const model = normalizeModelName(parseModelSuffix(rawPayload.model).baseModel)

  return await Sentry.startSpan(
    {
      op: "gen_ai.invoke_agent",
      name: "invoke_agent copilot-proxy",
      attributes: {
        "gen_ai.agent.name": "copilot-proxy",
        "gen_ai.request.model": getSentryModelName(model),
      },
    },
    async () => {
      return await handleCompletionInner(c, rawPayload)
    },
  )
}

async function handleCompletionInner(
  c: Context,
  rawPayload: ChatCompletionsPayload,
) {
  // Emit synthetic tool execution spans from tool results in message history
  emitChatCompletionsToolSpans(rawPayload.messages)

  // Capture the originally requested model before any manipulation
  const requestedModel = rawPayload.model

  // Parse model suffix to strip reasoning effort suffix (e.g. "gpt-5.3-codex:high" -> "gpt-5.3-codex")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    rawPayload.model,
  )
  rawPayload.model = baseModel

  // Apply auto-replacements to the payload
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

  // Apply user-configured silent model redirect (e.g. opus-4-7 -> opus-4-6)
  const { targetModel, reasoningEffort } = await resolveRedirectedModel(c, {
    model: normalizedModel,
    effort: requestedEffort,
  })
  applyRedirectedReasoningEffort({
    c,
    payload: replacedPayload,
    model: targetModel,
    effort: reasoningEffort,
  })

  // Normalize model name (e.g., claude-opus-4-5 -> claude-opus-4.5)
  let payload = {
    ...replacedPayload,
    model: targetModel,
  }

  const customReference = resolveCustomProviderModel({
    model: payload.model,
    kind: "chat",
    copilotModelIds: getCopilotModelIds(),
  })
  if (customReference) {
    return await executeCustomProviderRequest(c, {
      reference: customReference,
      payload,
      requestedModel,
      appliedRules,
      reasoningEffort,
    })
  }

  payload = applyRoutableModelFallback(c, payload)

  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

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

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  return await executeRequest(c, payload, requestedModel)
}

function getCopilotModelIds(): Set<string> {
  return new Set(state.models?.data.map((model) => model.id) ?? [])
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
      for await (const chunk of response) {
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
  requestedModel?: string,
) => {
  if (!payload.stream) {
    return await Sentry.startSpan(
      {
        op: "gen_ai.request",
        name: `request ${payload.model}`,
        attributes: {
          "gen_ai.request.model": getSentryModelName(payload.model),
          "gen_ai.response.model": getSentryModelName(payload.model),
          ...(shouldRecordAiContent() && {
            "gen_ai.request.messages": JSON.stringify(payload.messages),
          }),
        },
      },
      async (span) => {
        const response = (await createChatCompletions(payload, {
          signal: c.req.raw.signal,
        })) as ChatCompletionResponse

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        return handleNonStreamingResponse(c, response, { span, requestedModel })
      },
    )
  }

  return await handleStreamingResponse(c, payload, requestedModel)
}

function getPayloadReasoningEffort(
  payload: ChatCompletionsPayload,
): ReasoningEffort | undefined {
  const effort = (payload as unknown as Record<string, unknown>)
    .reasoning_effort
  if (
    effort === "low"
    || effort === "medium"
    || effort === "high"
    || effort === "xhigh"
  ) {
    return effort
  }
  if (effort === "max") return "xhigh"
  return undefined
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
): Promise<{ targetModel: string; reasoningEffort?: ReasoningEffort }> {
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
  return { targetModel, reasoningEffort }
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
  consola.debug("Non-streaming response:", JSON.stringify(response))
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
  if (shouldRecordAiContent()) {
    span.setAttribute(
      "gen_ai.response.text",
      JSON.stringify([response.choices[0]?.message?.content ?? ""]),
    )
  }

  if (requestedModel) {
    return c.json({ ...response, model: requestedModel })
  }
  return c.json(response)
}

const handleStreamingResponse = (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  requestedModel?: string,
) => {
  consola.debug("Streaming response")
  return Sentry.startNewTrace(() =>
    Sentry.startSpanManual(
      {
        op: "gen_ai.request",
        name: `request ${payload.model}`,
        attributes: {
          "gen_ai.request.model": getSentryModelName(payload.model),
          "gen_ai.response.model": getSentryModelName(payload.model),
          ...(shouldRecordAiContent() && {
            "gen_ai.request.messages": JSON.stringify(payload.messages),
          }),
        },
      },
      async (span, finish) => {
        let spanFinished = false
        const finishSpan = () => {
          if (spanFinished) return
          spanFinished = true
          finish()
        }

        try {
          const response = await createChatCompletions(payload, {
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
              requestedModel,
            })
            finishSpan()
            return result
          }

          return streamSSE(c, async (stream) => {
            try {
              let streamInputTokens = 0
              let streamOutputTokens = 0
              let streamCachedTokens = 0

              for await (const chunk of response) {
                consola.debug("Streaming chunk:", JSON.stringify(chunk))
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
                  if (requestedModel && parsed.model !== requestedModel) {
                    parsed.model = requestedModel
                    outChunk = { ...chunk, data: JSON.stringify(parsed) }
                  }
                }
                await stream.writeSSE(outChunk as SSEMessage)
              }

              // Set token attributes after streaming completes — span is still open
              span.setAttribute("gen_ai.usage.input_tokens", streamInputTokens)
              span.setAttribute(
                "gen_ai.usage.output_tokens",
                streamOutputTokens,
              )
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
    ),
  )
}

const isNonStreaming = (
  response: unknown,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")
