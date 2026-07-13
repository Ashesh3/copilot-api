import type { SpanAttributes } from "@sentry/core"
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { ReasoningEffort } from "~/lib/model-suffix"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { getLastUsedAccountId } from "~/lib/account-router"
import { isAbortError } from "~/lib/error"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import {
  createSentryChatSpanOptions,
  setSentryOutputMessages,
} from "~/lib/sentry"
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
  chatCompletionsToResponses,
  getResponsesResultOutputText,
  responsesResultToChatCompletion,
  streamResponsesAsChatCompletions,
} from "./responses-fallback"

interface ResponsesFallbackOptions {
  payload: ChatCompletionsPayload & { model: string }
  requestedModel: string
  reasoningEffort?: ReasoningEffort
  /** Override for the fallback log message (default: endpoint capability). */
  reason?: string
}

interface PreparedResponsesFallback {
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

export function shouldUseResponsesFallback(
  selectedModel: { supported_endpoints?: Array<string> } | undefined,
): boolean {
  const endpoints = selectedModel?.supported_endpoints
  if (!endpoints?.includes("/responses")) return false
  return !endpoints.includes("/chat/completions")
}

export async function executeResponsesFallback(
  c: Context,
  options: ResponsesFallbackOptions,
): Promise<Response> {
  reportEndpointFallback(c, options.payload.model, options.reason)
  setRequestContext(c, { provider: "ChatCompletions→Responses" })

  const prepared = prepareResponsesFallback(options)
  consola.debug("Responses fallback payload:", JSON.stringify(prepared.payload))

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

function reportEndpointFallback(
  c: Context,
  model: string,
  reason?: string,
): void {
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message:
      reason ?
        `${reason} routed ${model} to Responses`
      : `Model ${model} does not support /chat/completions; falling back to Responses`,
    data: {
      model,
      sourceEndpoint: "ChatCompletions",
      targetEndpoint: "Responses",
      ...(reason ? { reason } : {}),
    },
  })
}

async function executeNonStreamingResponsesFallback(
  c: Context,
  options: PreparedResponsesFallback,
): Promise<Response> {
  return await Sentry.startSpan(
    createSentrySpanOptions(options),
    async (span) => {
      const result = (await createResponses(options.payload, {
        vision: options.vision,
        initiator: options.initiator,
        signal: c.req.raw.signal,
      })) as ResponsesResult

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
  return Sentry.startSpanManual(
    createSentrySpanOptions(options),
    async (span, finish) => {
      const finishSpan = createSingleFinish(finish)

      try {
        const response = await createResponses(options.payload, {
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
          try {
            const usage = await streamResponsesAsChatCompletions(
              stream,
              response,
              options.requestedModel,
            )
            setStreamUsage(c, span, usage)
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
  )
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
