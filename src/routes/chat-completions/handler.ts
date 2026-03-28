import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { shouldRecordAiContent } from "~/lib/sentry"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
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

  // Capture the originally requested model before any manipulation
  const requestedModel = rawPayload.model

  // Parse model suffix to strip reasoning effort suffix (e.g. "gpt-5.3-codex:high" -> "gpt-5.3-codex")
  const { baseModel, reasoningEffort } = parseModelSuffix(rawPayload.model)
  rawPayload.model = baseModel

  // Apply auto-replacements to the payload
  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(rawPayload)

  // Normalize model name (e.g., claude-opus-4-5 -> claude-opus-4.5)
  let payload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
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

  return await executeRequest(c, payload)
}

const executeRequest = async (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
) => {
  return await Sentry.startSpan(
    {
      op: "gen_ai.request",
      name: `request ${payload.model}`,
      attributes: {
        "gen_ai.request.model": payload.model,
        ...(shouldRecordAiContent() && {
          "gen_ai.request.messages": JSON.stringify(payload.messages),
        }),
      },
    },
    async (span) => {
      const response = await createChatCompletions(payload)

      // Track which account handled this request (multi-token mode)
      const accountId = getLastUsedAccountId()
      if (accountId !== undefined) {
        setRequestContext(c, { accountId })
      }

      if (isNonStreaming(response)) {
        return handleNonStreamingResponse(c, response, span)
      }

      // For streaming, the span must live inside the streamSSE callback
      // because streamSSE returns a Response immediately (before the stream body is consumed).
      // We close the outer span here and open a new one inside the callback.
      return handleStreamingResponse(c, response, payload)
    },
  )
}

const handleNonStreamingResponse = (
  c: Context,
  response: ChatCompletionResponse,
  span: Sentry.Span,
) => {
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
  if (shouldRecordAiContent()) {
    span.setAttribute(
      "gen_ai.response.text",
      JSON.stringify([response.choices[0]?.message?.content ?? ""]),
    )
  }

  return c.json(response)
}

const handleStreamingResponse = (
  c: Context,
  response: AsyncIterable<{ data?: string; event?: string }>,
  payload: ChatCompletionsPayload & { model: string },
) => {
  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    // Use startNewTrace to create an independent root span, detached from
    // the http.server request span which ends when streamSSE returns the Response.
    await Sentry.startNewTrace(() => {
      return Sentry.startSpan(
        {
          op: "gen_ai.request",
          name: `request ${payload.model}`,
          attributes: {
            "gen_ai.request.model": payload.model,
            ...(shouldRecordAiContent() && {
              "gen_ai.request.messages": JSON.stringify(payload.messages),
            }),
          },
        },
        async (span) => {
          let streamInputTokens = 0
          let streamOutputTokens = 0

          for await (const chunk of response) {
            consola.debug("Streaming chunk:", JSON.stringify(chunk))
            // Capture usage from final chunk if available
            if (chunk.data && chunk.data !== "[DONE]") {
              const parsed = JSON.parse(chunk.data) as ChatCompletionChunk
              if (parsed.usage) {
                streamInputTokens = parsed.usage.prompt_tokens
                streamOutputTokens = parsed.usage.completion_tokens
                setRequestContext(c, {
                  inputTokens: parsed.usage.prompt_tokens,
                  outputTokens: parsed.usage.completion_tokens,
                })
              }
            }
            await stream.writeSSE(chunk as SSEMessage)
          }

          // Set token attributes after streaming completes — span is still open
          span.setAttribute("gen_ai.usage.input_tokens", streamInputTokens)
          span.setAttribute("gen_ai.usage.output_tokens", streamOutputTokens)
        },
      )
    })
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
