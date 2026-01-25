import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import {
  createAzureOpenAIChatCompletions,
  isAzureOpenAIModel,
} from "~/services/azure-openai"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const translatedPayload = translateToOpenAI(anthropicPayload)

  // Apply auto-replacements to the payload
  const openAIPayload = await applyReplacementsToPayload(translatedPayload)

  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Route to Azure OpenAI if the model has the azure_openai_ prefix
  const isAzureModel = isAzureOpenAIModel(openAIPayload.model)

  if (isAzureModel) {
    if (!state.azureOpenAIConfig) {
      return c.json({ error: "Azure OpenAI not configured" }, 500)
    }

    setRequestContext(c, { provider: "Azure OpenAI", model: openAIPayload.model })

    const response = await createAzureOpenAIChatCompletions(
      state.azureOpenAIConfig,
      openAIPayload,
    )

    if (isNonStreaming(response)) {
      consola.debug(
        "Non-streaming response from Azure OpenAI:",
        JSON.stringify(response).slice(-400),
      )
      // Set token counts from response
      if (response.usage) {
        setRequestContext(c, {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        })
      }
      const anthropicResponse = translateToAnthropic(response)
      consola.debug(
        "Translated Anthropic response:",
        JSON.stringify(anthropicResponse),
      )
      return c.json(anthropicResponse)
    }

    consola.debug("Streaming response from Azure OpenAI")
    return streamSSE(c, async (stream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      }

      for await (const rawEvent of response) {
        consola.debug(
          "Azure OpenAI raw stream event:",
          JSON.stringify(rawEvent),
        )
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        // Capture usage from final chunk if available
        if (chunk.usage) {
          setRequestContext(c, {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          })
        }
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          consola.debug("Translated Anthropic event:", JSON.stringify(event))
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    })
  }

  setRequestContext(c, { provider: "Copilot", model: openAIPayload.model })

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    // Set token counts from response
    if (response.usage) {
      setRequestContext(c, {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      })
    }
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      // Capture usage from final chunk if available
      if (chunk.usage) {
        setRequestContext(c, {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        })
      }
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
