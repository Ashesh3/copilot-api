import type { SpanAttributes } from "@sentry/core"
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { ReasoningEffort } from "~/lib/model-suffix"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import {
  type EndpointRouteDecision,
  type EndpointRouteFailure,
  getModelEndpointSupport,
  selectCopilotEndpoint,
} from "~/lib/endpoint-routing"
import { inspectHttpError, isAbortError, isHTTPError } from "~/lib/error"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import {
  createSentryChatSpanOptions,
  setSentryOutputMessages,
} from "~/lib/sentry"
import {
  raceSsePreflush,
  unwrapSsePreflushSettlement,
  withHeartbeatWhilePending,
  withSseHeartbeat,
  writeSseHeartbeat,
} from "~/lib/sse-lifecycle"
import {
  emitChatCompletionResponseAsStream,
  resolveResponsesWebSearchCalls,
} from "~/routes/messages/web-search-helpers"
import {
  addPromptCaching,
  detectInitiator,
  hasVisionContent,
} from "~/services/copilot/copilot-client"
import {
  createResponses,
  type ResponseUsage,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"
import {
  isResponsesWebSearchFunctionTool,
  isWebSearchToolType,
} from "~/services/copilot/mcp-web-search"

import {
  chatCompletionsToResponses,
  getResponsesResultOutputText,
  responsesResultToChatCompletion,
  streamResponsesAsChatCompletions,
} from "./responses-fallback"
import { createChatStreamTerminalAdapter } from "./stream-lifecycle"
import {
  checkChatNativeRequirements,
  checkChatToMessagesTranslation,
  checkChatToResponsesTranslation,
} from "./translation-fidelity"

interface ResponsesFallbackOptions {
  copilotSessionToken?: string
  payload: ChatCompletionsPayload & { model: string }
  requestedModel: string
  reasoningEffort?: ReasoningEffort
}

interface PreparedResponsesFallback {
  copilotSessionToken?: string
  initiator: "agent" | "user"
  originalPayload: ChatCompletionsPayload & { model: string }
  payload: ResponsesPayload
  requestedModel: string
  vision: boolean
}

interface UnexpectedNonStreamOptions {
  c: Context
  finishSpan: () => void
  options: PreparedResponsesFallback
  response: ResponsesResult
  span: Sentry.Span
}

export function selectChatUpstreamEndpoint(options: {
  payload: ChatCompletionsPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure {
  const { payload, selectedModel } = options
  const support = getModelEndpointSupport(selectedModel)
  const chatCheck = checkChatNativeRequirements(payload)
  const messagesCheck = checkChatToMessagesTranslation(payload)
  const responsesCheck = checkChatToResponsesTranslation(payload)
  const hasFileParts = payloadHasFileParts(payload)
  const hasDocumentParts = payloadHasDocumentParts(payload)
  const messagesPreserveFiles = !messagesCheck.blockers.some((blocker) =>
    blocker.startsWith("file_source:"),
  )
  const anthropicModel = modelIsAnthropic(selectedModel)
  const prefersMessages = payloadPrefersMessages({
    hasDocumentParts,
    hasFileParts,
    messagesPreserveFiles,
    payload,
  })
  const prefersResponses =
    payloadHasResponsesNativeTool(payload)
    || payloadHasOpenAiReasoningState(payload)
    || (hasFileParts && !messagesPreserveFiles)
  const chatCandidate = {
    endpoint: "/chat/completions" as const,
    reason: "endpoint_unavailable" as const,
    check: chatCheck,
  }
  const payloadRequirementReason = "payload_requirement" as const
  const messagesCandidate = {
    endpoint: "/v1/messages" as const,
    reason:
      prefersMessages ?
        payloadRequirementReason
      : ("endpoint_unavailable" as const),
    check: messagesCheck,
  }
  const responsesCandidate = {
    endpoint: "/responses" as const,
    reason:
      prefersResponses || prefersMessages ?
        payloadRequirementReason
      : ("endpoint_unavailable" as const),
    check: responsesCheck,
  }

  let candidates =
    anthropicModel ?
      [chatCandidate, messagesCandidate, responsesCandidate]
    : [chatCandidate, responsesCandidate, messagesCandidate]
  if (prefersMessages && anthropicModel) {
    candidates = [messagesCandidate, responsesCandidate, chatCandidate]
  } else if (prefersResponses || prefersMessages) {
    candidates = [responsesCandidate, messagesCandidate, chatCandidate]
  }

  return selectCopilotEndpoint({ source: "chat", support, candidates })
}

function payloadPrefersMessages(options: {
  hasDocumentParts: boolean
  hasFileParts: boolean
  messagesPreserveFiles: boolean
  payload: ChatCompletionsPayload
}): boolean {
  return (
    (options.hasFileParts && options.messagesPreserveFiles)
    || options.hasDocumentParts
    || payloadHasAnthropicSignedReasoning(options.payload)
    || (options.payload.thinking_budget !== undefined
      && options.payload.thinking_budget !== null)
  )
}

function modelIsAnthropic(selectedModel: Model | undefined): boolean {
  const vendor =
    typeof selectedModel?.vendor === "string" ?
      selectedModel.vendor.trim().toLowerCase()
    : ""
  if (vendor) return vendor === "anthropic"

  const family = selectedModel?.capabilities.family.trim().toLowerCase()
  if (family) return family.startsWith("claude")
  return selectedModel?.id.toLowerCase().startsWith("claude-") ?? false
}

export function recordChatEndpointFallback(
  c: Context,
  payload: ChatCompletionsPayload,
  decision: EndpointRouteDecision,
): void {
  const targetName =
    decision.target === "/responses" ? "Responses" : "native /v1/messages"
  let reason: string | undefined
  if (payloadHasFileParts(payload)) {
    reason = "PDF file attachment"
  } else if (payloadHasHostedWebSearch(payload)) {
    reason = "Hosted web search"
  } else if (decision.reason === "payload_requirement") {
    reason = "Payload requirements"
  }
  const targetEndpoint =
    decision.target === "/responses" ? "Responses" : "AnthropicMessages"
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message:
      reason ?
        `${reason} routed ${payload.model} to ${targetName}`
      : `Model ${payload.model} does not support /chat/completions; falling back to ${targetName}`,
    data: {
      model: payload.model,
      sourceEndpoint: "ChatCompletions",
      targetEndpoint,
      ...(reason ? { reason } : {}),
    },
  })
}

function payloadHasFileParts(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === "file"),
  )
}

function payloadHasDocumentParts(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && (message.content as Array<{ type?: string }>).some(
        (part) => part.type === "document",
      ),
  )
}

function payloadHasHostedWebSearch(payload: ChatCompletionsPayload): boolean {
  return payload.tools?.some((tool) => isWebSearchToolType(tool)) ?? false
}

function payloadHasResponsesNativeTool(
  payload: ChatCompletionsPayload,
): boolean {
  return (
    Array.isArray(payload.tools)
    && payload.tools.some(
      (tool) => (tool as { type?: string }).type !== "function",
    )
  )
}

function payloadHasAnthropicSignedReasoning(
  payload: ChatCompletionsPayload,
): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "assistant"
      && typeof message.reasoning_text === "string"
      && message.reasoning_text.trim().length > 0
      && typeof message.reasoning_opaque === "string"
      && message.reasoning_opaque.trim().length > 0
      && !message.reasoning_opaque.includes("@")
      && !message.encrypted_content,
  )
}

function payloadHasOpenAiReasoningState(
  payload: ChatCompletionsPayload,
): boolean {
  return payload.messages.some(
    (message) =>
      Boolean(message.encrypted_content)
      || (typeof message.reasoning_opaque === "string"
        && message.reasoning_opaque.includes("@")),
  )
}

export async function executeResponsesFallback(
  c: Context,
  options: ResponsesFallbackOptions,
): Promise<Response> {
  setRequestContext(c, { provider: "ChatCompletions→Responses" })

  const prepared = prepareResponsesFallback(options)
  consola.debug("Prepared Responses fallback request", {
    inputKind: Array.isArray(prepared.payload.input) ? "items" : "text",
    model: prepared.payload.model,
    stream: Boolean(prepared.payload.stream),
    toolCount: prepared.payload.tools?.length ?? 0,
  })

  if (!prepared.payload.stream) {
    return await executeNonStreamingResponsesFallback(c, prepared)
  }

  return executeStreamingResponsesFallback(c, prepared)
}

function prepareResponsesFallback(
  options: ResponsesFallbackOptions,
): PreparedResponsesFallback {
  addPromptCaching(options.payload.messages, options.payload.tools ?? undefined)

  return {
    copilotSessionToken: options.copilotSessionToken,
    payload: chatCompletionsToResponses(
      options.payload,
      options.reasoningEffort,
    ),
    originalPayload: options.payload,
    requestedModel: options.requestedModel,
    vision: hasVisionContent(options.payload.messages),
    initiator: detectInitiator(options.payload.messages),
  }
}

async function executeNonStreamingResponsesFallback(
  c: Context,
  options: PreparedResponsesFallback,
): Promise<Response> {
  return await Sentry.startSpan(
    createSentrySpanOptions(options),
    async (span) => {
      const requestOptions = {
        copilotSessionToken: options.copilotSessionToken,
        vision: options.vision,
        initiator: options.initiator,
        signal: c.req.raw.signal,
      }
      const initial = (await createResponses(
        options.payload,
        requestOptions,
      )) as ResponsesResult
      const result =
        hasMcpWebSearch(options.payload) ?
          await resolveResponsesWebSearchCalls(
            initial,
            options.payload,
            requestOptions,
          )
        : initial

      recordAccountContext(c)
      setResponsesUsageContext(c, result.usage)
      setResponsesUsageSpanAttributes(span, result.usage)
      setSentryOutputMessages(span, getResponsesResultOutputText(result))

      return c.json(
        responsesResultToChatCompletion(result, options.requestedModel),
      )
    },
  )
}

function executeStreamingResponsesFallback(
  c: Context,
  options: PreparedResponsesFallback,
): Promise<Response> {
  if (hasMcpWebSearch(options.payload)) {
    return executeStreamingMcpWebSearchFallback(c, options)
  }

  return Sentry.startSpanManual(
    createSentrySpanOptions(options),
    async (span, finish) => {
      const finishSpan = createSingleFinish(finish)

      try {
        const response = await createResponses(options.payload, {
          copilotSessionToken: options.copilotSessionToken,
          vision: options.vision,
          initiator: options.initiator,
          signal: c.req.raw.signal,
        })

        recordAccountContext(c)

        if (!isAsyncIterable(response)) {
          return handleUnexpectedNonStream({
            c,
            options,
            response,
            span,
            finishSpan,
          })
        }

        return streamSSE(c, async (stream) => {
          const adapter = createChatStreamTerminalAdapter({ c, stream })
          stream.onAbort(() => {
            adapter.abort()
          })
          try {
            const result = await streamResponsesAsChatCompletions(
              stream,
              withSseHeartbeat(response, stream),
              options.requestedModel,
            )
            setStreamUsage(c, span, result)
            if (
              result.terminal === "completed"
              || result.terminal === "incomplete"
            ) {
              await adapter.succeedAfterFinalChunk()
            } else if (result.receivedFailure) {
              await adapter.failReceived(result.receivedFailure)
            } else {
              await adapter.finishSource()
            }
          } catch (error) {
            if (isAbortError(error)) {
              adapter.abort()
              return
            }
            await adapter.failAfterCommit({
              kind: "thrown",
              error,
              ...(isHTTPError(error) ?
                { inspection: await inspectHttpError(error) }
              : {}),
            })
          } finally {
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

function hasMcpWebSearch(payload: ResponsesPayload): boolean {
  return (
    payload.tools?.some((tool) => isResponsesWebSearchFunctionTool(tool))
    ?? false
  )
}

async function executeStreamingMcpWebSearchFallback(
  c: Context,
  options: PreparedResponsesFallback,
): Promise<Response> {
  const payload = { ...options.payload, stream: false }
  const downstreamAbort = new AbortController()
  const upstreamSignal = AbortSignal.any([
    c.req.raw.signal,
    downstreamAbort.signal,
  ])
  const requestOptions = {
    copilotSessionToken: options.copilotSessionToken,
    vision: options.vision,
    initiator: options.initiator,
    signal: upstreamSignal,
  }
  const preflush = await raceSsePreflush(
    createResponses(payload, requestOptions).then(async (initial) =>
      resolveResponsesWebSearchCalls(
        initial as ResponsesResult,
        payload,
        requestOptions,
      ),
    ),
  )

  return streamSSE(c, async (stream) => {
    const adapter = createChatStreamTerminalAdapter({ c, stream })
    stream.onAbort(() => {
      downstreamAbort.abort()
      adapter.abort()
    })
    try {
      if (preflush.kind === "pending") await writeSseHeartbeat(stream)
      const response =
        preflush.kind === "settled" ?
          preflush.value
        : unwrapSsePreflushSettlement(
            await withHeartbeatWhilePending(preflush.pending, stream),
          )
      recordAccountContext(c)
      setResponsesUsageContext(c, response.usage)
      const result = responsesResultToChatCompletion(
        response,
        options.requestedModel,
      )
      await emitChatCompletionResponseAsStream(stream, result, {
        writeDone: false,
      })
      await adapter.succeedAfterFinalChunk()
    } catch (error) {
      if (isAbortError(error)) {
        adapter.abort()
        return
      }
      await adapter.failAfterCommit({
        kind: "thrown",
        error,
        ...(isHTTPError(error) ?
          { inspection: await inspectHttpError(error) }
        : {}),
      })
    }
  })
}

function createSentrySpanOptions(options: PreparedResponsesFallback): {
  attributes: SpanAttributes
  name: string
  op: string
} {
  return {
    ...createSentryChatSpanOptions({
      inputMessages: options.originalPayload.messages,
      model: options.payload.model,
      streaming: options.payload.stream === true,
    }),
  }
}

function createSingleFinish(finish: () => void): () => void {
  let spanFinished = false
  return () => {
    if (spanFinished) return
    spanFinished = true
    finish()
  }
}

function handleUnexpectedNonStream({
  c,
  finishSpan,
  options,
  response,
  span,
}: UnexpectedNonStreamOptions): Response {
  const result = responsesResultToChatCompletion(
    response,
    options.requestedModel,
  )
  setResponsesUsageContext(c, response.usage)
  setResponsesUsageSpanAttributes(span, response.usage)
  setSentryOutputMessages(span, getResponsesResultOutputText(response))
  finishSpan()
  return c.json(result)
}

function recordAccountContext(c: Context): void {
  const accountId = getLastUsedAccountId()
  if (accountId !== undefined) {
    setRequestContext(c, { accountId })
  }
}

function setResponsesUsageContext(
  c: Context,
  usage: ResponseUsage | null | undefined,
): void {
  if (!usage) return
  setRequestContext(c, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  })
}

function setResponsesUsageSpanAttributes(
  span: Sentry.Span,
  usage: ResponseUsage | null | undefined,
): void {
  span.setAttribute("gen_ai.usage.input_tokens", usage?.input_tokens ?? 0)
  span.setAttribute("gen_ai.usage.output_tokens", usage?.output_tokens ?? 0)
  setOptionalTokenDetails(span, {
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  })
}

function setStreamUsage(
  c: Context,
  span: Sentry.Span,
  usage: {
    cachedTokens: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    responseText: string
  },
): void {
  setRequestContext(c, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })
  span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens)
  span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens)
  setOptionalTokenDetails(span, usage)
  setSentryOutputMessages(span, usage.responseText)
}

function setOptionalTokenDetails(
  span: Sentry.Span,
  options: { cachedTokens: number; reasoningTokens: number },
): void {
  if (options.cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", options.cachedTokens)
  }
  if (options.reasoningTokens > 0) {
    span.setAttribute(
      "gen_ai.usage.output_tokens.reasoning",
      options.reasoningTokens,
    )
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    Boolean(value)
    && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  )
}
