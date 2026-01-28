import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { normalizeModelName } from "~/lib/model-resolver"
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
  createFallbackMessageDeltaEvents,
  translateChunkToAnthropicEvents,
} from "./stream-translation"

interface UsageData {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
}

/** Collect all chunks and extract usage data */
async function collectChunksWithUsage(
  eventStream: AsyncIterable<{ event?: string; data?: string }>,
): Promise<{ chunks: Array<ChatCompletionChunk>; usage: UsageData | null }> {
  const chunks: Array<ChatCompletionChunk> = []
  let usage: UsageData | null = null

  for await (const event of eventStream) {
    if (!event.data || event.data === "[DONE]") continue
    try {
      const chunk = JSON.parse(event.data) as ChatCompletionChunk
      chunks.push(chunk)
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        }
      }
    } catch (error) {
      consola.error("Failed to parse chunk:", error, event.data)
    }
  }
  return { chunks, usage }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const translatedPayload = translateToOpenAI(anthropicPayload)
  let openAIPayload = await applyReplacementsToPayload(translatedPayload)
  openAIPayload = { ...openAIPayload, model: normalizeModelName(openAIPayload.model) }

  if (state.manualApprove) await awaitApproval()

  const isAzureModel = isAzureOpenAIModel(openAIPayload.model)

  if (isAzureModel) {
    if (!state.azureOpenAIConfig) {
      return c.json({ error: "Azure OpenAI not configured" }, 500)
    }
    setRequestContext(c, { provider: "Azure OpenAI", model: openAIPayload.model })
  } else {
    setRequestContext(c, { provider: "Copilot", model: openAIPayload.model })
  }

  if (anthropicPayload.stream) {
    const streamPayload = {
      ...openAIPayload,
      stream: true,
      stream_options: { include_usage: true },
    }

    const response = isAzureModel
      ? await createAzureOpenAIChatCompletions(state.azureOpenAIConfig!, streamPayload)
      : await createChatCompletions(streamPayload)

    const eventStream = response as AsyncIterable<{ event?: string; data?: string }>

    return streamSSE(c, async (stream) => {
      // Buffer all chunks first to get usage before emitting message_start
      const { chunks, usage } = await collectChunksWithUsage(eventStream)

      consola.debug(`[stream] Collected ${chunks.length} chunks, usage:`, usage)

      if (usage) {
        setRequestContext(c, {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        })
      }

      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockOpen: false,
        contentBlockIndex: 0,
        toolCalls: {},
        pendingUsage: usage ?? undefined,
      }

      // Emit all events with correct usage in message_start
      for (const chunk of chunks) {
        const events = translateChunkToAnthropicEvents(chunk, streamState, anthropicPayload.model)
        for (const evt of events) {
          consola.debug(`[stream] Emitting event: ${evt.type}`)
          await stream.writeSSE({ event: evt.type, data: JSON.stringify(evt) })
        }
      }

      const fallbackEvents = createFallbackMessageDeltaEvents(streamState)
      consola.debug(`[stream] Fallback events: ${fallbackEvents.length}, messageDeltaSent: ${streamState.messageDeltaSent}`)
      for (const evt of fallbackEvents) {
        consola.debug(`[stream] Emitting fallback event: ${evt.type}`)
        await stream.writeSSE({ event: evt.type, data: JSON.stringify(evt) })
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

  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }

  const anthropicResponse = translateToAnthropic(response, anthropicPayload.model)
  return c.json(anthropicResponse)
}
