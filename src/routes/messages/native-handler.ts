import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type { RoutedAccountPin } from "~/lib/account-router"
import type { AnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import { getLastUsedAccountId } from "~/lib/account-router"
import {
  HTTPError,
  inspectHttpError,
  isAbortError,
  isHTTPError,
  LocalHTTPError,
} from "~/lib/error"
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
  consumeExtraSend,
  createRetryBudget,
} from "~/services/copilot/transport-retry"

import {
  type AnthropicErrorEvent,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamEventData,
  type AnthropicToolUseBlock,
} from "./anthropic-types"
import {
  createMessagesTerminalAdapter,
  type MessagesTerminalAdapter,
} from "./stream-lifecycle"
import {
  isInvalidThinkingSignatureResponse,
  stripThinkingBlocks,
} from "./thinking-recovery"
import { emitAnthropicResponseAsStream } from "./web-search-helpers"

const logger = createHandlerLogger("messages-native-handler")
const MAX_NATIVE_WEB_SEARCH_USES = 8

export interface NativeMessagesRequestOptions
  extends AnthropicRequestHeaderOptions {
  copilotSessionToken?: string
  initiatorOverride?: "agent" | "user"
  originalStream?: boolean
  requestedModel?: string
  routedAccountPin?: RoutedAccountPin
  retryBudget?: RetryBudget
  webSearchMaxUses?: number
}

type NativeMessagesDispatchOptions = {
  compaction?: boolean
  preserveValidatedControls?: boolean
  routedAccountPin?: RoutedAccountPin
  retryBudget?: RetryBudget
  signal?: AbortSignal
}

export interface NativeMessageUsage {
  cached: number
  created: number
  input: number
  output: number
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
    copilotSessionToken: nativeOptions.copilotSessionToken,
    initiator: nativeOptions.initiatorOverride,
    modelProviderPreference: nativeOptions.modelProviderPreference,
    preserveValidatedControls: dispatchOptions?.preserveValidatedControls,
    routedAccountPin:
      dispatchOptions?.routedAccountPin ?? nativeOptions.routedAccountPin,
    retryBudget: dispatchOptions?.retryBudget ?? nativeOptions.retryBudget,
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
    adapter: MessagesTerminalAdapter
    lifecycle: NativeForwardingState
    requestedModel: string | undefined
    usage: NativeMessageUsage
  },
): Promise<string> {
  let responseText = ""
  for await (const chunk of withSseHeartbeat(response, stream)) {
    const result = await forwardNativeChunk(stream, chunk, state)
    responseText += result.text
    if (result.terminal) break
  }
  if (state.lifecycle.terminal === "succeeded") {
    await state.adapter.succeed(async () => {
      for (const event of closeNativeOpenBlocks(state.lifecycle)) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
      const pending = takePendingMessageStop(state.lifecycle)
      if (pending) await stream.writeSSE(pending)
    })
  } else if (state.lifecycle.terminal === "open") {
    await state.adapter.finishSource()
  }
  return responseText
}

async function forwardNativeChunk(
  stream: Parameters<typeof consumeNativeMessageStream>[0],
  chunk: AnthropicStreamChunk,
  state: Parameters<typeof consumeNativeMessageStream>[2],
): Promise<{ terminal: boolean; text: string }> {
  if (!chunk.data || (!chunk.event && chunk.data.trim() === "[DONE]")) {
    return { terminal: false, text: "" }
  }
  let data = chunk.data
  const parsed = parseNativeEvent(data)
  if (parsed === null) throw new SyntaxError("Malformed native Messages event")
  switch (chunk.event) {
    case "message_start": {
      data = rewriteMessageStart(data, state.requestedModel, state.usage)
      break
    }
    case "message_delta": {
      trackMessageDelta(data, state.usage)
      break
    }
    // No default
  }
  const eventType = chunk.event ?? parsed.type
  const terminal = await updateNativeLifecycle(state, eventType, parsed)
  if (!terminal) {
    await stream.writeSSE({
      ...(chunk.event ? { event: chunk.event } : {}),
      data,
    })
  } else if (eventType === "message_stop") {
    setPendingMessageStop(state.lifecycle, chunk.event, data)
  }
  return {
    terminal,
    text: eventType === "content_block_delta" ? extractTextDelta(data) : "",
  }
}

async function updateNativeLifecycle(
  state: Parameters<typeof consumeNativeMessageStream>[2],
  eventType: unknown,
  parsed: Record<string, unknown>,
): Promise<boolean> {
  switch (eventType) {
    case "content_block_start": {
      const index = readNativeBlockIndex(parsed)
      if (index !== undefined) state.lifecycle.openBlockIndices.add(index)
      return false
    }
    case "content_block_stop": {
      const index = readNativeBlockIndex(parsed)
      if (index !== undefined) state.lifecycle.openBlockIndices.delete(index)
      return false
    }
    case "message_start": {
      state.lifecycle.messageStarted = true
      return false
    }
    case "error": {
      await state.adapter.failReceived(parsed as AnthropicErrorEvent)
      // The adapter has committed the only failure terminal before this mark.
      // eslint-disable-next-line require-atomic-updates
      state.lifecycle.terminal = "failed"
      return true
    }
    case "message_stop": {
      state.lifecycle.terminal = "succeeded"
      return true
    }
    default: {
      return false
    }
  }
}

type NativeForwardingState = {
  terminal: "open" | "succeeded" | "failed"
  openBlockIndices: Set<number>
  messageStarted: boolean
  pendingMessageStop?: { data: string; event?: string }
}

function setPendingMessageStop(
  state: NativeForwardingState,
  event: string | undefined,
  data: string,
): void {
  state.pendingMessageStop = { ...(event ? { event } : {}), data }
}

function takePendingMessageStop(
  state: NativeForwardingState,
): NativeForwardingState["pendingMessageStop"] {
  const pending = state.pendingMessageStop
  state.pendingMessageStop = undefined
  return pending
}

function closeNativeOpenBlocks(
  state: NativeForwardingState,
): Array<AnthropicStreamEventData> {
  const events = Array.from(state.openBlockIndices)
    .sort((left, right) => left - right)
    .map(
      (index): AnthropicStreamEventData => ({
        type: "content_block_stop",
        index,
      }),
    )
  state.openBlockIndices.clear()
  return events
}

function parseNativeEvent(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data) as unknown
    return (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ) ?
        (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readNativeBlockIndex(
  parsed: Record<string, unknown> | null,
): number | undefined {
  return typeof parsed?.index === "number" && Number.isInteger(parsed.index) ?
      parsed.index
    : undefined
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

  const requestedStream = Boolean(anthropicPayload.stream)
  const { payload, usesWebSearch, webSearchMaxUses } =
    prepareNativeTools(anthropicPayload)

  if (usesWebSearch) {
    return await handleWithMcpWebSearch(c, payload, {
      options,
      requestedStream,
      webSearchMaxUses,
    })
  }

  if (!requestedStream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: payload.model,
      }),
      async (span) => {
        const response = (await createNativeMessages(payload, options, {
          preserveValidatedControls: true,
          signal: c.req.raw.signal,
        })) as AnthropicResponse

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
  return await streamNativeMessages(c, payload, {
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
            preserveValidatedControls: true,
            signal: upstreamSignal,
          }),
        )

        return streamSSE(c, async (stream) => {
          stream.onAbort(() => downstreamAbort.abort())
          const usage = { input: 0, output: 0, cached: 0, created: 0 }
          let responseText = ""
          const lifecycle: NativeForwardingState = {
            terminal: "open",
            openBlockIndices: new Set(),
            messageStarted: false,
          }
          const adapter = createMessagesTerminalAdapter({
            c,
            stream,
            closeOpenBlocks: () => closeNativeOpenBlocks(lifecycle),
          })
          stream.onAbort(() => {
            adapter.abort()
          })

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
              { adapter, lifecycle, requestedModel, usage },
            )
          } catch (error) {
            if (isAbortError(error)) {
              adapter.abort()
              return
            }
            await adapter.fail({
              kind: "thrown",
              error,
              ...(isHTTPError(error) ?
                { inspection: await inspectHttpError(error) }
              : {}),
            })
          } finally {
            recordNativeStreamUsage(c, streamSpan, usage)
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

function recordNativeStreamUsage(
  c: Context,
  streamSpan: Sentry.Span,
  usage: NativeMessageUsage,
): void {
  const inputTokens = usage.input + usage.cached + usage.created
  setRequestContext(c, { inputTokens, outputTokens: usage.output })
  streamSpan.setAttribute("gen_ai.usage.input_tokens", inputTokens)
  streamSpan.setAttribute("gen_ai.usage.output_tokens", usage.output)
  if (usage.cached > 0) {
    streamSpan.setAttribute("gen_ai.usage.input_tokens.cached", usage.cached)
  }
}

function prepareNativeTools(payload: AnthropicMessagesPayload): {
  payload: AnthropicMessagesPayload
  usesWebSearch: boolean
  webSearchMaxUses?: number
} {
  const prepared = structuredClone(payload)
  if (!prepared.tools) return { payload: prepared, usesWebSearch: false }
  const webSearchTool = prepared.tools.find((tool) => isWebSearchToolType(tool))
  const usesWebSearch = webSearchTool !== undefined
  const webSearchMaxUses =
    usesWebSearch ? getNativeWebSearchLimit(prepared.tools) : undefined
  prepared.tools = prepared.tools.map((tool) =>
    isWebSearchToolType(tool) ? createWebSearchAnthropicTool(tool) : tool,
  )
  if (usesWebSearch) {
    prepared.tool_choice = {
      ...(prepared.tool_choice ?? { type: "auto" }),
      disable_parallel_tool_use: true,
    }
  }
  return { payload: prepared, usesWebSearch, webSearchMaxUses }
}

async function handleWithMcpWebSearch(
  c: Context,
  payload: AnthropicMessagesPayload,
  request: {
    options: NativeMessagesRequestOptions
    requestedStream: boolean
    webSearchMaxUses: number | undefined
  },
) {
  const { options, requestedStream, webSearchMaxUses } = request
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
        webSearchMaxUses,
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
        const adapter = createMessagesTerminalAdapter({
          c,
          stream,
          closeOpenBlocks: () => [],
        })
        stream.onAbort(() => {
          adapter.abort()
        })
        try {
          await adapter.succeed(async () => {
            await emitAnthropicResponseAsStream(stream, result)
          })
        } catch (error) {
          if (isAbortError(error)) {
            adapter.abort()
            return
          }
          await adapter.fail({
            kind: "thrown",
            error,
            ...(isHTTPError(error) ?
              { inspection: await inspectHttpError(error) }
            : {}),
          })
        }
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
  const routedAccountPin = options.routedAccountPin ?? {}
  const retryBudget = options.retryBudget ?? createRetryBudget()
  const loopOptions = { ...options, retryBudget }
  const maxSearchUses =
    options.webSearchMaxUses ?? getNativeWebSearchLimit(initialPayload.tools)
  let searchUses = 0

  while (true) {
    iteration += 1
    let response: AnthropicResponse
    try {
      response = (await createNativeMessages(payload, loopOptions, {
        preserveValidatedControls: true,
        routedAccountPin,
        signal: options.signal,
      })) as AnthropicResponse
    } catch (error) {
      if (
        options.originalStream !== true
        || !(error instanceof HTTPError)
        || error.response.status !== 400
        || !(await isInvalidThinkingSignatureResponse(error.response))
      ) {
        throw error
      }
      if (!consumeExtraSend(retryBudget)) throw error
      const recovered = structuredClone(payload)
      if (!stripThinkingBlocks(recovered)) throw error
      response = (await createNativeMessages(recovered, loopOptions, {
        preserveValidatedControls: true,
        routedAccountPin,
        signal: options.signal,
      })) as AnthropicResponse
      payload = recovered
    }
    const calls = response.content.filter(
      (block): block is AnthropicToolUseBlock =>
        block.type === "tool_use" && block.name === "web_search",
    )
    if (calls.length === 0) return response
    if (searchUses + calls.length > maxSearchUses) {
      throw createNativeWebSearchLimitError(maxSearchUses)
    }
    searchUses += calls.length

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

    if (searchUses >= maxSearchUses) {
      throw createNativeWebSearchLimitError(maxSearchUses)
    }

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

function getNativeWebSearchLimit(
  tools: AnthropicMessagesPayload["tools"],
): number {
  const callerLimit = tools?.find((tool) => isWebSearchToolType(tool))?.max_uses
  return Number.isInteger(callerLimit) && Number(callerLimit) > 0 ?
      Math.min(Number(callerLimit), MAX_NATIVE_WEB_SEARCH_USES)
    : MAX_NATIVE_WEB_SEARCH_USES
}

function createNativeWebSearchLimitError(limit: number): LocalHTTPError {
  const clientBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "web_search_limit_exceeded",
      message: "The Copilot Messages request was rejected.",
      param: "web_search_limit",
    },
  }
  return new LocalHTTPError(
    `Native web search exceeded ${limit} uses.`,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

function recordUsage(
  c: Context,
  span: Sentry.Span,
  usage: AnthropicResponse["usage"] | undefined,
): void {
  if (!usage) return
  const cached = usage.cache_read_input_tokens ?? 0
  const created = usage.cache_creation_input_tokens ?? 0
  setRequestContext(c, {
    inputTokens: usage.input_tokens + cached + created,
    outputTokens: usage.output_tokens,
  })
  span.setAttribute(
    "gen_ai.usage.input_tokens",
    usage.input_tokens + cached + created,
  )
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
  usage: NativeMessageUsage,
): string {
  try {
    const parsed = JSON.parse(data) as {
      message?: {
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
    }
    if (parsed.message?.usage) {
      usage.input = parsed.message.usage.input_tokens ?? 0
      usage.output = parsed.message.usage.output_tokens ?? 0
      usage.cached = parsed.message.usage.cache_read_input_tokens ?? 0
      usage.created = parsed.message.usage.cache_creation_input_tokens ?? 0
    }
    if (requestedModel && parsed.message?.model) {
      return JSON.stringify({
        ...parsed,
        message: {
          ...parsed.message,
          model: requestedModel,
        },
      })
    }
  } catch {
    return data
  }
  return data
}

export function trackMessageDelta(
  data: string,
  usage: NativeMessageUsage,
): void {
  try {
    const parsed = JSON.parse(data) as {
      usage?: {
        output_tokens?: number
        input_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
    if (parsed.usage?.output_tokens !== undefined) {
      usage.output = parsed.usage.output_tokens
    }
    if (parsed.usage?.input_tokens !== undefined) {
      usage.input = parsed.usage.input_tokens
    }
    if (parsed.usage?.cache_read_input_tokens !== undefined) {
      usage.cached = parsed.usage.cache_read_input_tokens
    }
    if (parsed.usage?.cache_creation_input_tokens !== undefined) {
      usage.created = parsed.usage.cache_creation_input_tokens
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
