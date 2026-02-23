/**
 * Handler for Google Generative AI API format.
 * Accepts requests at /v1/models/{model}:generateContent and
 * /v1/models/{model}:streamGenerateContent?alt=sse
 *
 * Translates Google ↔ OpenAI ChatCompletions format to proxy through Copilot.
 */

import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { createHandlerLogger } from "~/lib/logger"
import { normalizeModelName } from "~/lib/model-resolver"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type { GoogleAIRequest } from "./google-ai-types"

import { translateGoogleToOpenAI } from "./request-translation"
import {
  createGoogleStreamState,
  translateChunkToGoogle,
  translateOpenAIToGoogle,
} from "./response-translation"

const logger = createHandlerLogger("google-ai-handler")

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

  // Normalize model name (e.g., gemini-3-flash-preview stays as-is for Copilot)
  const model = normalizeModelName(rawModel)

  logger.debug(`Google AI request: model=${model}, action=${action}`)

  // Parse Google AI request body
  const googlePayload = await c.req.json<GoogleAIRequest>()
  logger.debug("Google AI request payload:", JSON.stringify(googlePayload))

  // Translate Google → OpenAI ChatCompletions format
  const openAIPayload = translateGoogleToOpenAI(googlePayload, model, isStream)

  // Apply auto-replacements
  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(openAIPayload)
  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  setRequestContext(c, {
    requestedModel: rawModel,
    model: finalPayload.model,
    provider: "GoogleAI→ChatCompletions",
    replacements: appliedRules,
  })

  // Find the selected model for token counting
  const selectedModel = state.models?.data.find(
    (m) => m.id === finalPayload.model,
  )

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

  // Set max_tokens if not provided
  if (finalPayload.max_tokens === null && selectedModel) {
    finalPayload.max_tokens =
      selectedModel.capabilities.limits.max_output_tokens
  }

  logger.debug("Translated OpenAI payload:", JSON.stringify(finalPayload))

  // Call Copilot's ChatCompletions API
  const response = await createChatCompletions(finalPayload)

  // ─── Non-Streaming Response ───
  if (isNonStreaming(response)) {
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

  // Google streaming uses raw SSE: data: {json}\r\n\r\n
  return streamSSE(c, async (stream) => {
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
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
