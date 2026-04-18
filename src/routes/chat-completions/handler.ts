import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { isAbortError } from "~/lib/error"
import { applyModelRedirect } from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
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
        "gen_ai.request.model": model,
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
  const { baseModel, reasoningEffort } = parseModelSuffix(rawPayload.model)
  rawPayload.model = baseModel

  // Apply auto-replacements to the payload
  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(rawPayload)

  // Apply user-configured silent model redirect (e.g. opus-4-7 -> opus-4-6)
  const redirect = await applyModelRedirect(replacedPayload.model)

  // Normalize model name (e.g., claude-opus-4-5 -> claude-opus-4.5)
  let payload = {
    ...replacedPayload,
    model: normalizeModelName(redirect.model),
  }

  // Fallback: if the base model has no routable account but the -1m variant
  // does, auto-route to it. The merged model list may include models that no
  // individual account can serve, causing routedFetch to use the legacy path.
  if (
    !payload.model.endsWith("-1m")
    && !tokenPool.getAccountForModel(payload.model)
  ) {
    const candidate = `${payload.model}-1m`
    if (state.models?.data.some((m) => m.id === candidate)) {
      consola.debug(
        `No routable account for ${payload.model}, falling back to ${candidate}`,
      )
      payload = { ...payload, model: candidate }
    }
  }

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
          "gen_ai.request.model": payload.model,
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
          "gen_ai.request.model": payload.model,
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
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
