import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type { AnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"

import { getLastUsedAccountId } from "~/lib/account-router"
import { isAbortError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { setRequestContext } from "~/lib/request-logger"
import {
  createSentryChatSpanOptions,
  setSentryOutputMessages,
} from "~/lib/sentry"
import {
  raceSsePreflush,
  unwrapSsePreflushSettlement,
  type SseHeartbeatSink,
  withHeartbeatWhilePending,
  withSseHeartbeat,
  writeSseHeartbeat,
} from "~/lib/sse-lifecycle"
import {
  type AnthropicStreamChunk,
  createAnthropicMessages,
  type CreateAnthropicMessagesReturn,
} from "~/services/copilot/create-anthropic-messages"
import {
  buildWebSearchQuery,
  createWebSearchAnthropicTool,
  executeWebSearch,
  isWebSearchToolType,
} from "~/services/copilot/mcp-web-search"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicToolUseBlock,
} from "./anthropic-types"
import { emitAnthropicStreamError } from "./stream-translation"
import { emitAnthropicResponseAsStream } from "./web-search-helpers"

const logger = createHandlerLogger("messages-native-handler")

export interface NativeMessagesRequestOptions
  extends AnthropicRequestHeaderOptions {
  initiatorOverride?: "agent" | "user"
  requestedModel?: string
}

type NativeMessagesDispatchOptions = {
  compaction?: boolean
  preserveValidatedControls?: boolean
  signal?: AbortSignal
}

export async function createNativeMessages(
  payload: AnthropicMessagesPayload,
  nativeOptions: NativeMessagesRequestOptions,
  dispatchOptions?: NativeMessagesDispatchOptions,
): Promise<CreateAnthropicMessagesReturn> {
  return await createAnthropicMessages(payload, {
    anthropicBeta: nativeOptions.anthropicBeta,
    anthropicVersion: nativeOptions.anthropicVersion,
    compaction: dispatchOptions?.compaction,
    initiator: nativeOptions.initiatorOverride,
    modelProviderPreference: nativeOptions.modelProviderPreference,
    preserveValidatedControls: dispatchOptions?.preserveValidatedControls,
    signal: dispatchOptions?.signal,
  })
}

function asAnthropicStream(
  response: Awaited<ReturnType<typeof createAnthropicMessages>>,
): AsyncIterable<AnthropicStreamChunk> {
  if (Symbol.asyncIterator in response) return response
  throw new TypeError("Expected a streaming Anthropic response")
}

async function consumeNativeMessageStream(
  stream: SseHeartbeatSink & {
    writeSSE: (data: { data: string; event?: string }) => Promise<void>
  },
  response: AsyncIterable<AnthropicStreamChunk>,
  state: {
    requestedModel: string | undefined
    usage: { cached: number; input: number; output: number }
  },
): Promise<string> {
  const { requestedModel, usage } = state
  let responseText = ""
  for await (const chunk of withSseHeartbeat(response, stream)) {
    if (!chunk.data) continue
    // CAPI appends an OpenAI-style bare [DONE] sentinel after message_stop;
    // strict Anthropic SDK parsers do not expect it.
    if (!chunk.event && chunk.data.trim() === "[DONE]") continue

    let data = chunk.data
    switch (chunk.event) {
      case "message_start": {
        data = rewriteMessageStart(data, requestedModel, usage)
        break
      }
      case "message_delta": {
        trackMessageDelta(data, usage)
        break
      }
      case "content_block_delta": {
        responseText += extractTextDelta(data)
        break
      }
      // No default
    }

    await stream.writeSSE({
      ...(chunk.event ? { event: chunk.event } : {}),
      data,
    })
  }
  return responseText
}

/**
 * Forward an Anthropic Messages request to Copilot's native /v1/messages
 * endpoint (claude models). Both sides speak the same dialect, so this is a
 * near-passthrough — the only endpoint that can carry base64 PDF document
 * blocks to claude models losslessly.
 */
export async function handleWithNativeMessages(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: NativeMessagesRequestOptions = {},
) {
  const { requestedModel } = options

  const usesWebSearch = prepareNativeTools(anthropicPayload)

  if (usesWebSearch) {
    return await handleWithMcpWebSearch(c, anthropicPayload, {
      ...options,
    })
  }

  if (!anthropicPayload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: anthropicPayload.messages,
        model: anthropicPayload.model,
      }),
      async (span) => {
        const response = (await createNativeMessages(
          anthropicPayload,
          options,
          {
            signal: c.req.raw.signal,
          },
        )) as AnthropicResponse

        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        recordUsage(c, span, response.usage)
        setSentryOutputMessages(span, collectResponseText(response))

        const result: AnthropicResponse = {
          ...response,
          model: requestedModel ?? response.model,
        }
        logger.debug("Received native Messages response", {
          blockCount: result.content.length,
          model: result.model,
        })
        return c.json(result)
      },
    )
  }

  logger.debug("Streaming native /v1/messages response")
  return await streamNativeMessages(c, anthropicPayload, {
    ...options,
  })
}

async function streamNativeMessages(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: NativeMessagesRequestOptions,
) {
  const { requestedModel } = options

  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: anthropicPayload.messages,
      model: anthropicPayload.model,
      streaming: true,
    }),
    async (streamSpan, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const downstreamAbort = new AbortController()
        const upstreamSignal = AbortSignal.any([
          c.req.raw.signal,
          downstreamAbort.signal,
        ])
        const preflush = await raceSsePreflush(
          createNativeMessages(anthropicPayload, options, {
            signal: upstreamSignal,
          }),
        )

        return streamSSE(c, async (stream) => {
          stream.onAbort(() => downstreamAbort.abort())
          const usage = { input: 0, output: 0, cached: 0 }
          let responseText = ""

          try {
            if (preflush.kind === "pending") {
              await writeSseHeartbeat(stream)
            }
            const response =
              preflush.kind === "settled" ?
                preflush.value
              : unwrapSsePreflushSettlement(
                  await withHeartbeatWhilePending(preflush.pending, stream),
                )
            const accountId = getLastUsedAccountId()
            if (accountId !== undefined) {
              setRequestContext(c, { accountId })
            }

            responseText = await consumeNativeMessageStream(
              stream,
              asAnthropicStream(response),
              { requestedModel, usage },
            )
          } catch (error) {
            if (isAbortError(error)) return
            // Headers are already committed, so this must travel in-band.
            await emitAnthropicStreamError(stream, error)
          } finally {
            setRequestContext(c, {
              inputTokens: usage.input + usage.cached,
              outputTokens: usage.output,
            })
            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              usage.input + usage.cached,
            )
            streamSpan.setAttribute("gen_ai.usage.output_tokens", usage.output)
            if (usage.cached > 0) {
              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens.cached",
                usage.cached,
              )
            }
            setSentryOutputMessages(streamSpan, responseText)
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

function prepareNativeTools(payload: AnthropicMessagesPayload): boolean {
  if (!payload.tools) return false
  const usesWebSearch = payload.tools.some((tool) => isWebSearchToolType(tool))
  const kept = payload.tools.flatMap((tool) => {
    if (isWebSearchToolType(tool)) {
      return [createWebSearchAnthropicTool(tool)]
    }
    return tool.input_schema !== undefined || !tool.type ? [tool] : []
  })
  if (kept.length < payload.tools.length) {
    logger.debug(
      `Dropped ${payload.tools.length - kept.length} server-side tool(s) without input_schema on native /v1/messages path`,
    )
  }
  payload.tools = kept.length > 0 ? kept : undefined
  if (usesWebSearch) {
    payload.tool_choice = {
      ...(payload.tool_choice ?? { type: "auto" }),
      disable_parallel_tool_use: true,
    }
  }
  return usesWebSearch
}

async function handleWithMcpWebSearch(
  c: Context,
  payload: AnthropicMessagesPayload,
  options: NativeMessagesRequestOptions,
) {
  const requestedStream = Boolean(payload.stream)
  payload.stream = false

  return await Sentry.startSpan(
    createSentryChatSpanOptions({
      inputMessages: payload.messages,
      model: payload.model,
      streaming: requestedStream,
    }),
    async (span) => {
      const response = await resolveNativeWebSearch(payload, {
        ...options,
        signal: c.req.raw.signal,
      })

      const accountId = getLastUsedAccountId()
      if (accountId !== undefined) {
        setRequestContext(c, { accountId })
      }

      recordUsage(c, span, response.usage)
      setSentryOutputMessages(span, collectResponseText(response))
      const result = {
        ...response,
        model: options.requestedModel ?? response.model,
      }

      if (!requestedStream) return c.json(result)

      return streamSSE(c, async (stream) => {
        await emitAnthropicResponseAsStream(stream, result)
      })
    },
  )
}

export async function resolveNativeWebSearch(
  initialPayload: AnthropicMessagesPayload,
  options: NativeMessagesRequestOptions & { signal: AbortSignal },
): Promise<AnthropicResponse> {
  let payload = initialPayload
  let iteration = 0

  while (true) {
    iteration += 1
    const response = (await createNativeMessages(payload, options, {
      signal: options.signal,
    })) as AnthropicResponse
    const calls = response.content.filter(
      (block): block is AnthropicToolUseBlock =>
        block.type === "tool_use" && block.name === "web_search",
    )
    if (calls.length === 0) return response

    logger.info(
      `Executing ${calls.length} web search(es) from native Messages, iteration ${iteration}`,
    )
    const tool = payload.tools?.find(
      (candidate) => candidate.name === "web_search",
    )
    const results = await Promise.all(
      calls.map(async (call) => ({
        tool_use_id: call.id,
        type: "tool_result" as const,
        content: await executeWebSearch(
          buildWebSearchQuery(JSON.stringify(call.input), tool),
          options.signal,
        ),
      })),
    )

    payload = {
      ...payload,
      stream: false,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [
        ...payload.messages,
        {
          role: "assistant",
          content: response.content.filter(
            (block) => block.type !== "tool_use" || block.name === "web_search",
          ),
        },
        { role: "user", content: results },
      ],
    }
  }
}

function recordUsage(
  c: Context,
  span: Sentry.Span,
  usage: AnthropicResponse["usage"] | undefined,
): void {
  if (!usage) return
  const cached = usage.cache_read_input_tokens ?? 0
  setRequestContext(c, {
    inputTokens: usage.input_tokens + cached,
    outputTokens: usage.output_tokens,
  })
  span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens + cached)
  span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens)
  if (cached > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", cached)
  }
}

function collectResponseText(response: AnthropicResponse): string {
  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
}

function rewriteMessageStart(
  data: string,
  requestedModel: string | undefined,
  usage: { input: number; output: number; cached: number },
): string {
  try {
    const parsed = JSON.parse(data) as {
      message?: {
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
        }
      }
    }
    if (parsed.message?.usage) {
      usage.input = parsed.message.usage.input_tokens ?? 0
      usage.output = parsed.message.usage.output_tokens ?? 0
      usage.cached = parsed.message.usage.cache_read_input_tokens ?? 0
    }
    if (requestedModel && parsed.message?.model) {
      parsed.message.model = requestedModel
      return JSON.stringify(parsed)
    }
  } catch {
    return data
  }
  return data
}

function trackMessageDelta(
  data: string,
  usage: { input: number; output: number; cached: number },
): void {
  try {
    const parsed = JSON.parse(data) as {
      usage?: { output_tokens?: number; input_tokens?: number }
    }
    if (parsed.usage?.output_tokens !== undefined) {
      usage.output = parsed.usage.output_tokens
    }
    if (parsed.usage?.input_tokens !== undefined) {
      usage.input = parsed.usage.input_tokens
    }
  } catch {
    /* ignore */
  }
}

function extractTextDelta(data: string): string {
  try {
    const parsed = JSON.parse(data) as {
      delta?: { type?: string; text?: string }
    }
    return parsed.delta?.type === "text_delta" ? (parsed.delta.text ?? "") : ""
  } catch {
    return ""
  }
}
