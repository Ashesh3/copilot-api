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
import {
  translateChunkToAnthropicEvents,
} from "./stream-translation"

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

    setRequestContext(c, {
      provider: "Azure OpenAI",
      model: openAIPayload.model,
    })
  } else {
    setRequestContext(c, { provider: "Copilot", model: openAIPayload.model })
  }

  // Handle streaming
  if (anthropicPayload.stream) {
    const streamPayload = {
      ...openAIPayload,
      stream: true,
      stream_options: { include_usage: true },
    }

    const response = isAzureModel
      ? await createAzureOpenAIChatCompletions(
          state.azureOpenAIConfig!,
          streamPayload,
        )
      : await createChatCompletions(streamPayload)

    // Response is an async iterable of SSE events
    const eventStream = response as AsyncIterable<{ event?: string; data?: string }>

    return streamSSE(c, async (stream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockOpen: false,
        contentBlockIndex: 0,
        toolCalls: {},
      }

      for await (const event of eventStream) {
        if (!event.data || event.data === "[DONE]") {
          continue
        }

        try {
          const chunk = JSON.parse(event.data) as ChatCompletionChunk
          consola.debug("OpenAI chunk:", JSON.stringify(chunk))

          const anthropicEvents = translateChunkToAnthropicEvents(
            chunk,
            streamState,
          )

          for (const anthropicEvent of anthropicEvents) {
            consola.debug("Anthropic event:", JSON.stringify(anthropicEvent))
            await stream.writeSSE({
              event: anthropicEvent.type,
              data: JSON.stringify(anthropicEvent),
            })
          }

          // Update token counts from final chunk if available
          if (chunk.usage) {
            setRequestContext(c, {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            })
          }
        } catch (error) {
          consola.error("Failed to parse chunk:", error, event.data)
        }
      }
    })
  }

  // Non-streaming response
  const nonStreamPayload = { ...openAIPayload, stream: false }

  const response = isAzureModel
    ? ((await createAzureOpenAIChatCompletions(
        state.azureOpenAIConfig!,
        nonStreamPayload,
      )) as ChatCompletionResponse)
    : ((await createChatCompletions(nonStreamPayload)) as ChatCompletionResponse)

  consola.debug("Response from upstream:", JSON.stringify(response).slice(-400))

  // Set token counts from response
  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }

  // Translate to Anthropic format
  const anthropicResponse = translateToAnthropic(response)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}
