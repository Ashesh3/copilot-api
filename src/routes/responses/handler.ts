/* eslint-disable max-lines, max-lines-per-function */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import { isAbortError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseReasoningEffort,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import {
  recordNonDefaultBehavior,
  sanitizeRequestBodyForLog,
  setRequestContext,
} from "~/lib/request-logger"
import {
  installRoutingAffinityFallback,
  resolveResponsesRoutingAffinity,
} from "~/lib/routing-affinity"
import {
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  setSentryOutputMessages,
  setSentryConversationIdFromRequest,
} from "~/lib/sentry"
import {
  withHeartbeatWhilePending,
  withSseHeartbeat,
} from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { emitResponsesToolSpans } from "~/lib/tool-spans"
import {
  createAnthropicMessages,
  modelSupportsNativeMessages,
} from "~/services/copilot/create-anthropic-messages"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type FunctionTool,
  type ResponseOutputFunctionCall,
  type ResponseOutputItem,
  type ResponseOutputMessage,
  type ResponseOutputText,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseUsage,
} from "~/services/copilot/create-responses"
import {
  createWebSearchResponsesTool,
  isResponsesWebSearchFunctionTool,
} from "~/services/copilot/mcp-web-search"

import {
  anthropicResponseToChat,
  chatPayloadToAnthropic,
} from "../chat-completions/anthropic-bridge"
import {
  emitResponsesResultAsStream,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "../messages/web-search-helpers"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

/**
 * Extracts detailed token counts from a Responses API usage object,
 * avoiding optional-chain branches in the caller.
 */
const extractDetailedUsage = (
  usage: ResponseUsage | null | undefined,
): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
} => ({
  inputTokens: usage?.input_tokens ?? 0,
  outputTokens: usage?.output_tokens ?? 0,
  cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
})

/**
 * Extracts usage from a ChatCompletionChunk usage object into the CCStreamState
 * format, keeping optional-chain branches out of the caller.
 */
const extractCCUsage = (usage: {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
}): { inputTokens: number; outputTokens: number; cachedTokens: number } => ({
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
})

/**
 * Sets optional cached input tokens and reasoning output tokens attributes on a
 * Sentry span.  Extracting this avoids adding `if`-branches to already-complex
 * handler functions.
 */
const setDetailedTokenAttributes = (
  span: Sentry.Span,
  opts: { cachedTokens?: number; reasoningTokens?: number },
): void => {
  if (opts.cachedTokens && opts.cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", opts.cachedTokens)
  }
  if (opts.reasoningTokens && opts.reasoningTokens > 0) {
    span.setAttribute(
      "gen_ai.usage.output_tokens.reasoning",
      opts.reasoningTokens,
    )
  }
}

const hasBufferedWebSearchCall = (chunkData: {
  event?: string
  data?: string
}): boolean => {
  if (!chunkData.data || chunkData.event !== "response.output_item.done") {
    return false
  }

  try {
    const parsed = JSON.parse(chunkData.data) as {
      item?: { type?: string; name?: string }
    }
    return (
      parsed.item?.type === "function_call" && parsed.item.name === "web_search"
    )
  } catch {
    return false
  }
}

const getCompletedBufferedResponse = (chunkData: {
  event?: string
  data?: string
}): ResponsesResult | null => {
  if (
    !chunkData.data
    || (chunkData.event !== "response.completed"
      && chunkData.event !== "response.incomplete")
  ) {
    return null
  }

  try {
    const parsed = JSON.parse(chunkData.data) as {
      response?: ResponsesResult
    }
    return parsed.response ?? null
  } catch {
    return null
  }
}

type ResponsesReasoningEffort = NonNullable<
  NonNullable<ResponsesPayload["reasoning"]>["effort"]
>

function isResponsesReasoningEffort(
  value: unknown,
): value is ResponsesReasoningEffort {
  return (
    value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  )
}

export function normalizeResponsesReasoning(
  payload: ResponsesPayload,
  suffixEffort?: ReasoningEffort,
): ResponsesReasoningEffort | undefined {
  // Accept OpenAI-compatible top-level aliases and normalize to reasoning.effort
  const topLevelEffortRaw = payload.reasoningEffort ?? payload.reasoning_effort
  const topLevelEffort =
    isResponsesReasoningEffort(topLevelEffortRaw) ? topLevelEffortRaw : (
      undefined
    )

  if (topLevelEffort) {
    payload.reasoning =
      payload.reasoning ?
        {
          ...payload.reasoning,
          effort: payload.reasoning.effort ?? topLevelEffort,
        }
      : { effort: topLevelEffort }
  }
  delete payload.reasoningEffort
  delete payload.reasoning_effort

  if (suffixEffort) {
    payload.reasoning =
      payload.reasoning ?
        {
          ...payload.reasoning,
          effort: suffixEffort,
        }
      : { effort: suffixEffort }
  }

  return payload.reasoning?.effort ?? undefined
}

function getRedirectReasoningEffort(
  effort: ResponsesReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return parseReasoningEffort(effort)
}

function applyRedirectedResponsesEffort(options: {
  c: Context
  payload: ResponsesPayload
  model: string
  effort: ReasoningEffort | undefined
}): void {
  if (!options.effort) {
    if (
      usesImplicitReasoningDefault(options.model)
      && options.payload.reasoning
    ) {
      recordNonDefaultBehavior(options.c, {
        kind: "reasoning_effort_implicit_default",
        message: `${options.model} is configured for implicit reasoning defaults; removing explicit reasoning config`,
        data: {
          model: options.model,
        },
      })
      delete options.payload.reasoning
    }
    return
  }
  if (usesImplicitReasoningDefault(options.model)) {
    recordNonDefaultBehavior(options.c, {
      kind: "reasoning_effort_implicit_default",
      message: `${options.model} is configured for implicit reasoning defaults; removing explicit reasoning.effort=${options.effort}`,
      data: {
        model: options.model,
        requestedEffort: options.effort,
      },
    })
    delete options.payload.reasoning
    return
  }
  options.payload.reasoning =
    options.payload.reasoning ?
      { ...options.payload.reasoning, effort: options.effort }
    : { effort: options.effort }
}

async function resolveResponsesRedirect(
  c: Context,
  request: { model: string; effectiveEffort?: ResponsesReasoningEffort },
): Promise<Awaited<ReturnType<typeof applyModelRedirect>>> {
  const redirectRawEffort = getRedirectReasoningEffort(request.effectiveEffort)
  const requestedEffort = normalizeReasoningEffortForModel(
    request.model,
    redirectRawEffort,
  )
  reportClampedResponsesEffort(c, {
    model: request.model,
    requestedEffort: redirectRawEffort,
    effectiveEffort: requestedEffort,
  })

  const redirect = await applyModelRedirect({
    model: request.model,
    effort: requestedEffort,
  })
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: request.model,
        sourceEffort: requestedEffort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }
  return redirect
}

function reportClampedResponsesEffort(
  c: Context,
  options: {
    model: string
    requestedEffort?: ReasoningEffort
    effectiveEffort?: ReasoningEffort
    redirected?: boolean
  },
): void {
  if (
    !options.requestedEffort
    || options.effectiveEffort === options.requestedEffort
  ) {
    return
  }
  const prefix = options.redirected ? "Requested redirected" : "Requested"
  recordNonDefaultBehavior(c, {
    kind: "reasoning_effort_clamped",
    message: `${prefix} effort ${options.requestedEffort} for ${options.model} was clamped to ${options.effectiveEffort}`,
    data: {
      model: options.model,
      requestedEffort: options.requestedEffort,
      effectiveEffort: options.effectiveEffort,
    },
  })
}

function applyResponsesModelFallback(
  c: Context,
  payload: ResponsesPayload,
): void {
  if (
    payload.model.endsWith("-1m")
    || tokenPool.hasEnabledAccountForKnownModel(payload.model) !== undefined
  ) {
    return
  }

  const candidate = `${payload.model}-1m`
  if (!state.models?.data.some((m) => m.id === candidate)) return

  recordNonDefaultBehavior(c, {
    kind: "model_fallback",
    message: `No enabled account can serve ${payload.model}; falling back to ${candidate}`,
    data: {
      sourceModel: payload.model,
      targetModel: candidate,
      reason: "no routable account for known model",
    },
  })
  payload.model = candidate
}

function reportResponsesEndpointFallback(c: Context, model: string): void {
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message: `Model ${model} does not support /responses; falling back to ChatCompletions`,
    data: {
      model,
      sourceEndpoint: "Responses",
      targetEndpoint: "ChatCompletions",
    },
  })
}

function withRequestedResponseModel(
  result: ResponsesResult,
  requestedModel: string,
): ResponsesResult {
  return { ...result, model: requestedModel }
}

function rewriteResponseModelInEvent(
  data: string,
  requestedModel: string,
): string {
  try {
    const parsed = JSON.parse(data) as { response?: { model?: string } }
    if (parsed.response?.model) {
      parsed.response.model = requestedModel
      return JSON.stringify(parsed)
    }
  } catch {
    return data
  }
  return data
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  installRoutingAffinityFallback(
    resolveResponsesRoutingAffinity(
      (payload as Record<string, unknown>).client_metadata,
    ),
  )
  const conversationId = setSentryConversationIdFromRequest(c, payload)

  const model = parseModelSuffix(payload.model).baseModel

  return await Sentry.startSpan(
    createSentryInvokeAgentSpanOptions(model, conversationId),
    async () => {
      return await handleResponsesInner(c, payload)
    },
  )
}

const handleResponsesInner = async (c: Context, payload: ResponsesPayload) => {
  // Emit synthetic tool execution spans from tool results in input history
  emitResponsesToolSpans(payload.input)

  // Capture the originally requested model before any manipulation
  const requestedModel = payload.model

  // Parse model suffix and apply reasoning effort override (e.g. "gpt-5.3-codex:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )

  payload.model = normalizeModelName(baseModel)
  const effectiveEffort = normalizeResponsesReasoning(payload, suffixEffort)
  const redirect = await resolveResponsesRedirect(c, {
    model: payload.model,
    effectiveEffort,
  })
  // eslint-disable-next-line require-atomic-updates
  payload.model = normalizeModelName(redirect.model)
  const redirectedEffort = normalizeReasoningEffortForModel(
    payload.model,
    redirect.effort,
  )
  reportClampedResponsesEffort(c, {
    model: payload.model,
    requestedEffort: redirect.effort,
    effectiveEffort: redirectedEffort,
    redirected: true,
  })
  applyRedirectedResponsesEffort({
    c,
    payload,
    model: payload.model,
    effort: redirectedEffort,
  })
  const finalEffort = redirectedEffort ?? effectiveEffort

  applyResponsesModelFallback(c, payload)

  setRequestContext(c, {
    requestedModel,
    provider: "Responses",
    model: payload.model,
    reasoningEffort: finalEffort,
  })
  logger.debug(
    "Responses request payload:",
    sanitizeRequestBodyForLog(payload as Record<string, unknown>),
  )

  // Expand compaction items back into regular messages
  expandCompactionItems(payload)
  disableParallelWebSearch(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    // ChatCompletions has no hosted web-search tool. Downgrade it to the
    // shared MCP-backed function loop only on this fallback path.
    convertWebSearchTool(payload)
    // ChatCompletions can't accept custom (freeform) tools, so rewrite
    // apply_patch into a function tool only on this fallback path. The
    // native /responses path supports custom tools and must pass them
    // through unchanged (Codex Desktop aborts otherwise).
    useFunctionApplyPatch(payload)
    reportResponsesEndpointFallback(c, payload.model)
    setRequestContext(c, { provider: "Responses→ChatCompletions" })
    return await handleWithChatCompletions(c, payload, requestedModel)
  }

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Extract messages for Sentry span attribute
  const inputMessages =
    typeof payload.input === "string" ?
      payload.input
    : JSON.stringify(payload.input)

  if (isStreamingRequested(payload)) {
    logger.debug("Forwarding native Responses stream")
    return await Sentry.startSpanManual(
      createSentryChatSpanOptions({
        inputMessages,
        model: payload.model,
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
          const response = await createResponses(payload, {
            vision,
            initiator,
            signal: c.req.raw.signal,
          })

          const accountId = getLastUsedAccountId()
          if (accountId !== undefined) {
            setRequestContext(c, { accountId })
          }

          if (!isAsyncIterable(response)) {
            const hadWebSearch = response.output.some(
              (item: ResponseOutputItem) =>
                item.type === "function_call" && item.name === "web_search",
            )
            const du = extractDetailedUsage(response.usage)
            streamSpan.setAttribute("gen_ai.usage.input_tokens", du.inputTokens)
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              du.outputTokens,
            )
            setDetailedTokenAttributes(streamSpan, {
              cachedTokens: du.cachedTokens,
              reasoningTokens: du.reasoningTokens,
            })
            setSentryOutputMessages(streamSpan, response.output_text)
            finishSpan()

            const resolved =
              hadWebSearch ?
                await resolveResponsesWebSearchCalls(response, payload, {
                  vision,
                  initiator,
                  signal: c.req.raw.signal,
                })
              : response

            logger.debug(
              "Forwarding native Responses result:",
              JSON.stringify(resolved),
            )
            return c.json(withRequestedResponseModel(resolved, requestedModel))
          }

          return streamSSE(c, async (stream) => {
            try {
              const bufferedChunks: Array<{
                id?: string
                event?: string
                data?: string
              }> = []
              let hasWebSearchCall = false
              let completedResult: ResponsesResult | null = null
              let detailedUsage = extractDetailedUsage(null)
              let responseText = ""

              for await (const chunk of withSseHeartbeat(response, stream)) {
                const chunkData = {
                  id: (chunk as { id?: string }).id,
                  event: (chunk as { event?: string }).event,
                  data: (chunk as { data?: string }).data ?? "",
                }
                bufferedChunks.push(chunkData)

                if (hasBufferedWebSearchCall(chunkData)) {
                  hasWebSearchCall = true
                }

                const parsedResponse = getCompletedBufferedResponse(chunkData)
                if (parsedResponse) {
                  completedResult = parsedResponse
                  detailedUsage = extractDetailedUsage(parsedResponse.usage)
                  responseText = parsedResponse.output_text
                }
              }

              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens",
                detailedUsage.inputTokens,
              )
              streamSpan.setAttribute(
                "gen_ai.usage.output_tokens",
                detailedUsage.outputTokens,
              )
              setDetailedTokenAttributes(streamSpan, {
                cachedTokens: detailedUsage.cachedTokens,
                reasoningTokens: detailedUsage.reasoningTokens,
              })
              setSentryOutputMessages(streamSpan, responseText)

              if (hasWebSearchCall && completedResult) {
                finishSpan()
                // Inside the already-open stream: the resolver loops full
                // generations plus live web fetches, so it needs keep-alives.
                const resolved = await withHeartbeatWhilePending(
                  Sentry.withActiveSpan(null, () =>
                    resolveResponsesWebSearchCalls(completedResult, payload, {
                      vision,
                      initiator,
                      signal: c.req.raw.signal,
                    }),
                  ),
                  stream,
                )
                await emitResponsesResultAsStream(
                  stream,
                  withRequestedResponseModel(resolved, requestedModel),
                )
                return
              }

              const idTracker = createStreamIdTracker()
              for (const chunk of bufferedChunks) {
                const restoredData = rewriteResponseModelInEvent(
                  chunk.data ?? "",
                  requestedModel,
                )
                const processedData = fixStreamIds(
                  restoredData,
                  chunk.event,
                  idTracker,
                )
                await stream.writeSSE({
                  id: chunk.id,
                  event: chunk.event,
                  data: processedData,
                })
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
    )
  }

  const { initialResult, hadWebSearch } = await Sentry.startSpan(
    createSentryChatSpanOptions({
      inputMessages,
      model: payload.model,
    }),
    async (span) => {
      const result = (await createResponses(payload, {
        vision,
        initiator,
        signal: c.req.raw.signal,
      })) as ResponsesResult

      const accountId = getLastUsedAccountId()
      if (accountId !== undefined) {
        setRequestContext(c, { accountId })
      }

      const hadWebSearch = result.output.some(
        (item: ResponseOutputItem) =>
          item.type === "function_call" && item.name === "web_search",
      )
      const inputTokens = result.usage?.input_tokens ?? 0
      const outputTokens = result.usage?.output_tokens ?? 0
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
      span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
      const cachedTokens =
        result.usage?.input_tokens_details?.cached_tokens ?? 0
      const reasoningTokens =
        result.usage?.output_tokens_details?.reasoning_tokens ?? 0
      setDetailedTokenAttributes(span, { cachedTokens, reasoningTokens })
      setSentryOutputMessages(span, result.output_text)

      return { initialResult: result, hadWebSearch }
    },
  )

  const resolved =
    hadWebSearch ?
      await resolveResponsesWebSearchCalls(initialResult, payload, {
        vision,
        initiator,
        signal: c.req.raw.signal,
      })
    : initialResult

  logger.debug("Forwarding native Responses result:", JSON.stringify(resolved))

  return c.json(withRequestedResponseModel(resolved, requestedModel))
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

export const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type !== "custom" || typeof t.name !== "string") {
          continue
        }

        if (t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

export const convertWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.map((t) => {
    const type = (t as { type?: string }).type
    if (
      typeof type === "string"
      && (type === "web_search" || type.startsWith("web_search_"))
    ) {
      return createWebSearchResponsesTool(t)
    }
    return t
  })
  payload.parallel_tool_calls = false

  const choice = payload.tool_choice as { type?: string } | undefined
  if (
    choice
    && typeof choice.type === "string"
    && (choice.type === "web_search" || choice.type.startsWith("web_search_"))
  ) {
    payload.tool_choice = { type: "function", name: "web_search" }
  }
}

export const disableParallelWebSearch = (payload: ResponsesPayload): void => {
  if (payload.tools?.some((tool) => isResponsesWebSearchFunctionTool(tool))) {
    payload.parallel_tool_calls = false
  }
}

// ─── ChatCompletions fallback for models without /responses support ───

interface CCFunctionCallState {
  itemId: string
  callId: string
  name: string
  arguments: string
  outputIndex: number
}

interface CCStreamState {
  seqNum: number
  responseId: string
  createdAt: number
  resolvedModel: string
  accumulatedText: string
  textItemAdded: boolean
  messageItemId: string
  functionCalls: Map<number, CCFunctionCallState>
  nextOutputIndex: number
  usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  responseCreated: boolean
}

type WriteEventFn = (event: string, data: unknown) => Promise<void>

const createCCStreamState = (model: string): CCStreamState => ({
  seqNum: 0,
  responseId: "resp_cc",
  createdAt: Math.floor(Date.now() / 1000),
  resolvedModel: model,
  accumulatedText: "",
  textItemAdded: false,
  messageItemId: "msg_cc_001",
  functionCalls: new Map(),
  nextOutputIndex: 0,
  usage: {},
  responseCreated: false,
})

const convertInputToMessages = (
  input: ResponsesPayload["input"],
): ChatCompletionsPayload["messages"] => {
  const messages: ChatCompletionsPayload["messages"] = []

  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
    return messages
  }

  if (!Array.isArray(input)) return messages

  let pendingToolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [...pendingToolCalls],
      })
      pendingToolCalls = []
    }
  }

  for (const item of input) {
    const itemType = (item as { type?: string }).type
    if (itemType === "reasoning") continue
    if (itemType === "function_call") {
      const fc = item as { call_id: string; name: string; arguments: string }
      pendingToolCalls.push({
        id: fc.call_id,
        type: "function",
        function: { name: fc.name, arguments: fc.arguments },
      })
      continue
    }
    flushToolCalls()
    if (itemType === "function_call_output") {
      const fco = item as { call_id: string; output: unknown }
      messages.push({
        role: "tool",
        content: convertFunctionCallOutputToCC(fco.output),
        tool_call_id: fco.call_id,
      })
      continue
    }
    if (!itemType || itemType === "message") {
      convertMessageItem(item, messages)
    }
  }

  flushToolCalls()
  return messages
}

const convertResponsesContentToCC = (
  content: Array<Record<string, unknown>>,
): Array<ContentPart> => {
  const parts: Array<ContentPart> = []
  for (const part of content) {
    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } })
      continue
    }
    if (part.type === "input_file") {
      parts.push({
        type: "file",
        file: {
          ...(typeof part.filename === "string" ?
            { filename: part.filename }
          : {}),
          ...(typeof part.file_data === "string" ?
            { file_data: part.file_data }
          : {}),
          ...(typeof part.file_id === "string" ?
            { file_id: part.file_id }
          : {}),
        },
      })
      continue
    }
    if (typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
    }
  }
  return parts
}

const flattenTextParts = (
  parts: Array<ContentPart>,
): string | Array<ContentPart> =>
  parts.every((part) => part.type === "text") ?
    parts.map((part) => (part as { text: string }).text).join("")
  : parts

const convertFunctionCallOutputToCC = (
  output: unknown,
): string | Array<ContentPart> => {
  if (typeof output === "string") return output
  if (Array.isArray(output)) {
    const parts = convertResponsesContentToCC(
      output as Array<Record<string, unknown>>,
    )
    if (parts.length > 0) return flattenTextParts(parts)
  }
  return JSON.stringify(output)
}

const convertMessageItem = (
  item: unknown,
  messages: ChatCompletionsPayload["messages"],
): void => {
  const msg = item as {
    role: "user" | "assistant" | "system" | "developer"
    content?: string | Array<Record<string, unknown>>
  }
  const role = msg.role === "developer" ? "developer" : msg.role
  let content: string | Array<ContentPart>

  if (typeof msg.content === "string") {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    content = flattenTextParts(convertResponsesContentToCC(msg.content))
  } else {
    content = ""
  }

  messages.push({ role, content })
}

const convertToolsForCC = (
  tools: ResponsesPayload["tools"],
): ChatCompletionsPayload["tools"] => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const converted = tools
    .filter((t): t is FunctionTool => "name" in t && "parameters" in t)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters ?? {},
      },
    }))

  return converted.length > 0 ? converted : undefined
}

const convertToolChoiceForCC = (
  toolChoice: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] => {
  if (!toolChoice) return undefined

  if (typeof toolChoice === "string") {
    return toolChoice as "none" | "auto" | "required"
  }

  if (typeof toolChoice === "object" && "name" in toolChoice) {
    return {
      type: "function",
      function: { name: (toolChoice as { name: string }).name },
    }
  }

  return undefined
}

export const responsesToChatCompletions = (
  payload: ResponsesPayload,
): ChatCompletionsPayload => {
  const messages = convertInputToMessages(payload.input)

  if (payload.instructions) {
    messages.unshift({ role: "system", content: payload.instructions })
  }

  const tools = convertToolsForCC(payload.tools)
  const toolChoice = convertToolChoiceForCC(payload.tool_choice)

  // Map structured output (text.format) to response_format
  // Preserve json_schema details so normalizePayload can stash the schema
  // before downgrading to json_object
  const textFormat = (payload as Record<string, unknown>).text as
    | { format?: { type: string; schema?: unknown; [key: string]: unknown } }
    | undefined
  let responseFormat:
    | {
        type: string
        json_schema?: { schema: unknown }
        [key: string]: unknown
      }
    | undefined
  if (textFormat?.format?.type === "json_schema") {
    responseFormat = {
      type: "json_schema",
      json_schema: { schema: textFormat.format.schema },
    }
  } else if (textFormat?.format?.type === "json_object") {
    responseFormat = { type: "json_object" }
  }

  return {
    model: payload.model,
    messages,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens,
    stream: payload.stream ?? false,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  }
}

const chatCompletionToResponsesResult = (
  response: ChatCompletionResponse,
  model: string,
): ResponsesResult => {
  const choice = response.choices[0]
  const output: Array<ResponseOutputItem> = []
  let outputText = ""

  // Map text content
  if (choice.message.content) {
    outputText = choice.message.content
    output.push({
      id: `msg_${response.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage)
  }

  // Map tool calls
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        id: `fc_${tc.id}`,
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      } satisfies ResponseOutputFunctionCall)
    }
  }

  // Map finish_reason to status
  let status = "completed"
  let incompleteDetails: ResponsesResult["incomplete_details"] = null
  if (choice.finish_reason === "length") {
    status = "incomplete"
    incompleteDetails = { reason: "max_output_tokens" }
  }

  return {
    id: `resp_${response.id}`,
    object: "response",
    created_at: response.created,
    model,
    output,
    output_text: outputText,
    status,
    usage: mapCCUsage(response.usage),
    error: null,
    incomplete_details: incompleteDetails,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}

const mapCCUsage = (
  usage: ChatCompletionResponse["usage"],
): ResponseUsage | null => {
  if (!usage) return null
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details ?
      {
        input_tokens_details: {
          cached_tokens: usage.prompt_tokens_details.cached_tokens,
        },
      }
    : {}),
  }
}

const buildCCResponseResult = (
  state: CCStreamState,
  outputItems: Array<ResponseOutputItem>,
  resultOpts: { status: string; outputText: string },
): ResponsesResult => ({
  id: state.responseId,
  object: "response",
  created_at: state.createdAt,
  model: state.resolvedModel,
  output: outputItems,
  output_text: resultOpts.outputText,
  status: resultOpts.status,
  usage: {
    input_tokens: state.usage.inputTokens ?? 0,
    output_tokens: state.usage.outputTokens ?? 0,
    total_tokens:
      (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0),
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

const emitTextDelta = async (
  s: CCStreamState,
  content: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  if (!s.textItemAdded) {
    s.textItemAdded = true
    const textOutputIndex = s.nextOutputIndex++
    await writeEvent("response.output_item.added", {
      item: {
        id: s.messageItemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
      output_index: textOutputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
  }

  s.accumulatedText += content
  await writeEvent("response.output_text.delta", {
    content_index: 0,
    delta: content,
    item_id: s.messageItemId,
    output_index: 0,
    sequence_number: s.seqNum++,
    type: "response.output_text.delta",
  })
}

const emitToolCallDelta = async (
  s: CCStreamState,
  tc: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>[0],
  writeEvent: WriteEventFn,
): Promise<void> => {
  const tcIndex = tc.index
  let fcState = s.functionCalls.get(tcIndex)

  if (!fcState) {
    const callId = tc.id ?? `call_cc_${tcIndex}`
    const name = tc.function?.name ?? ""
    fcState = {
      itemId: `fc_${callId}`,
      callId,
      name,
      arguments: "",
      outputIndex: s.nextOutputIndex++,
    }
    s.functionCalls.set(tcIndex, fcState)

    await writeEvent("response.output_item.added", {
      item: {
        id: fcState.itemId,
        type: "function_call",
        call_id: fcState.callId,
        name: fcState.name,
        arguments: "",
        status: "in_progress",
      },
      output_index: fcState.outputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
  }

  if (tc.function?.name && !fcState.name) {
    fcState.name = tc.function.name
  }

  if (tc.function?.arguments) {
    fcState.arguments += tc.function.arguments
    await writeEvent("response.function_call_arguments.delta", {
      delta: tc.function.arguments,
      item_id: fcState.itemId,
      output_index: fcState.outputIndex,
      sequence_number: s.seqNum++,
      type: "response.function_call_arguments.delta",
    })
  }
}

const emitDoneEvents = async (
  s: CCStreamState,
  finishReason: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  if (s.accumulatedText) {
    await emitTextDoneEvents(s, writeEvent)
  }

  for (const [, fcState] of s.functionCalls) {
    await emitFunctionCallDoneEvents(s, fcState, writeEvent)
  }

  await emitResponseCompleted(s, finishReason, writeEvent)
}

const emitTextDoneEvents = async (
  s: CCStreamState,
  writeEvent: WriteEventFn,
): Promise<void> => {
  await writeEvent("response.output_text.done", {
    content_index: 0,
    item_id: s.messageItemId,
    output_index: 0,
    sequence_number: s.seqNum++,
    text: s.accumulatedText,
    type: "response.output_text.done",
  })

  await writeEvent("response.output_item.done", {
    item: {
      id: s.messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: s.accumulatedText,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage,
    output_index: 0,
    sequence_number: s.seqNum++,
    type: "response.output_item.done",
  })
}

const emitFunctionCallDoneEvents = async (
  s: CCStreamState,
  fcState: CCFunctionCallState,
  writeEvent: WriteEventFn,
): Promise<void> => {
  await writeEvent("response.function_call_arguments.done", {
    arguments: fcState.arguments,
    item_id: fcState.itemId,
    name: fcState.name,
    output_index: fcState.outputIndex,
    sequence_number: s.seqNum++,
    type: "response.function_call_arguments.done",
  })

  await writeEvent("response.output_item.done", {
    item: {
      id: fcState.itemId,
      type: "function_call",
      call_id: fcState.callId,
      name: fcState.name,
      arguments: fcState.arguments,
      status: "completed",
    } satisfies ResponseOutputFunctionCall,
    output_index: fcState.outputIndex,
    sequence_number: s.seqNum++,
    type: "response.output_item.done",
  })
}

const emitResponseCompleted = async (
  s: CCStreamState,
  finishReason: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  const finalOutput: Array<ResponseOutputItem> = []

  if (s.accumulatedText) {
    finalOutput.push({
      id: s.messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: s.accumulatedText,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage)
  }

  for (const [, fcState] of s.functionCalls) {
    finalOutput.push({
      id: fcState.itemId,
      type: "function_call",
      call_id: fcState.callId,
      name: fcState.name,
      arguments: fcState.arguments,
      status: "completed",
    } satisfies ResponseOutputFunctionCall)
  }

  let finalStatus = "completed"
  let incompleteDetails: ResponsesResult["incomplete_details"] = null
  if (finishReason === "length") {
    finalStatus = "incomplete"
    incompleteDetails = { reason: "max_output_tokens" }
  }

  const finalResult = buildCCResponseResult(s, finalOutput, {
    status: finalStatus,
    outputText: s.accumulatedText,
  })
  finalResult.incomplete_details = incompleteDetails

  await writeEvent("response.completed", {
    response: finalResult,
    sequence_number: s.seqNum++,
    type: "response.completed",
  })
}

export const streamChatCompletionsAsResponses = async (
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  ccStream: AsyncIterable<{ data?: string; event?: string }>,
  model: string,
): Promise<{
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  responseText: string
}> => {
  const s = createCCStreamState(model)

  const writeEvent: WriteEventFn = async (event, data) => {
    await stream.writeSSE({ event, data: JSON.stringify(data) })
  }

  for await (const rawEvent of ccStream) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    if (chunk.id) s.responseId = `resp_${chunk.id}`
    if (chunk.created) s.createdAt = chunk.created
    if (chunk.model) s.resolvedModel = chunk.model

    if (chunk.usage) {
      s.usage = extractCCUsage(chunk.usage)
    }

    if (!s.responseCreated) {
      const skeleton = buildCCResponseResult(s, [], {
        status: "in_progress",
        outputText: "",
      })
      await writeEvent("response.created", {
        response: skeleton,
        sequence_number: s.seqNum++,
        type: "response.created",
      })
      s.responseCreated = true
    }

    const delta = chunk.choices.at(0)?.delta
    if (!delta) continue

    const content = delta.content as string | undefined
    if (content) {
      await emitTextDelta(s, content, writeEvent)
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        await emitToolCallDelta(s, tc, writeEvent)
      }
    }

    const finishReason = chunk.choices.at(0)?.finish_reason
    if (finishReason) {
      await emitDoneEvents(s, finishReason, writeEvent)
    }
  }

  return { ...s.usage, responseText: s.accumulatedText }
}

const ccPayloadHasFileParts = (payload: ChatCompletionsPayload): boolean =>
  payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === "file"),
  )

/**
 * Bridge the ChatCompletions fallback to native /v1/messages for claude
 * models when the payload carries PDF attachments. The response is buffered
 * and re-emitted as a Responses stream when streaming was requested (same
 * pattern as web-search resolution).
 */
const handleFallbackViaNativeMessages = async (
  c: Context,
  options: {
    ccPayload: ChatCompletionsPayload & { model: string }
    isStream: boolean
    responseModel: string
    selectedModel?: Model
  },
) => {
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message: `PDF file attachment routed ${options.ccPayload.model} to native /v1/messages`,
    data: {
      model: options.ccPayload.model,
      sourceEndpoint: "Responses",
      targetEndpoint: "AnthropicMessages",
    },
  })
  setRequestContext(c, { provider: "Responses→AnthropicMessages" })

  const anthropicPayload = await chatPayloadToAnthropic(
    options.ccPayload,
    options.selectedModel,
    c.req.raw.signal,
  )
  anthropicPayload.stream = false

  const response = (await createAnthropicMessages(anthropicPayload, {
    signal: c.req.raw.signal,
  })) as AnthropicResponse

  const nativeAccountId = getLastUsedAccountId()
  if (nativeAccountId !== undefined) {
    setRequestContext(c, { accountId: nativeAccountId })
  }

  const ccResponse = anthropicResponseToChat(response, options.responseModel)
  if (ccResponse.usage) {
    setRequestContext(c, {
      inputTokens: ccResponse.usage.prompt_tokens,
      outputTokens: ccResponse.usage.completion_tokens,
    })
  }

  const result = chatCompletionToResponsesResult(
    ccResponse,
    options.responseModel,
  )

  if (!options.isStream) {
    return c.json(result)
  }

  return streamSSE(c, async (stream) => {
    try {
      await emitResponsesResultAsStream(stream, result)
    } catch (error) {
      if (isAbortError(error)) return
      throw error
    }
  })
}

const handleWithChatCompletions = async (
  c: Context,
  payload: ResponsesPayload,
  requestedModel?: string,
) => {
  const ccPayload = responsesToChatCompletions(payload)
  const responseModel = requestedModel ?? payload.model
  const needsWebSearch =
    ccPayload.tools?.some((tool) => tool.function.name === "web_search")
    ?? false
  logger.debug("ChatCompletions fallback payload:", JSON.stringify(ccPayload))

  // PDF file parts cannot ride /chat/completions upstream; claude models
  // accept them natively via /v1/messages
  if (ccPayloadHasFileParts(ccPayload)) {
    const selectedModel = state.models?.data.find(
      (model) => model.id === payload.model,
    )
    if (modelSupportsNativeMessages(selectedModel)) {
      return await handleFallbackViaNativeMessages(c, {
        ccPayload: { ...ccPayload, model: payload.model },
        isStream: Boolean(payload.stream),
        responseModel,
        selectedModel,
      })
    }
  }

  // Non-streaming: span wraps the entire call + response processing
  if (!payload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: ccPayload.messages,
        model: payload.model,
      }),
      async (span) => {
        const response = await createChatCompletions(ccPayload, {
          signal: c.req.raw.signal,
        })

        // Track which account handled this request (multi-token mode)
        const fallbackAccountId = getLastUsedAccountId()
        if (fallbackAccountId !== undefined) {
          setRequestContext(c, { accountId: fallbackAccountId })
        }

        const initialResponse = response as ChatCompletionResponse
        const ccResponse =
          needsWebSearch ?
            await resolveWebSearchCalls(initialResponse, ccPayload, {
              abortSignal: c.req.raw.signal,
            })
          : initialResponse
        logger.debug(
          "ChatCompletions fallback response:",
          JSON.stringify(ccResponse),
        )

        if (ccResponse.usage) {
          setRequestContext(c, {
            inputTokens: ccResponse.usage.prompt_tokens,
            outputTokens: ccResponse.usage.completion_tokens,
          })
        }

        const inputTokens = ccResponse.usage?.prompt_tokens ?? 0
        const outputTokens = ccResponse.usage?.completion_tokens ?? 0
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
        span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
        const cachedTokens =
          ccResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0
        setDetailedTokenAttributes(span, { cachedTokens })
        setSentryOutputMessages(
          span,
          ccResponse.choices[0]?.message?.content ?? "",
        )

        const result = chatCompletionToResponsesResult(
          ccResponse,
          responseModel,
        )
        return c.json(result)
      },
    )
  }

  logger.debug("ChatCompletions fallback streaming")

  if (needsWebSearch) {
    return await handleStreamingChatFallbackWebSearch(c, {
      ccPayload,
      responseModel,
    })
  }

  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: ccPayload.messages,
      model: payload.model,
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
        const response = await createChatCompletions(ccPayload, {
          signal: c.req.raw.signal,
        })

        const fallbackAccountId = getLastUsedAccountId()
        if (fallbackAccountId !== undefined) {
          setRequestContext(c, { accountId: fallbackAccountId })
        }

        if (isNonStreaming(response)) {
          if (response.usage) {
            setRequestContext(c, {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
            })
          }

          streamSpan.setAttribute(
            "gen_ai.usage.input_tokens",
            response.usage?.prompt_tokens ?? 0,
          )
          streamSpan.setAttribute(
            "gen_ai.usage.output_tokens",
            response.usage?.completion_tokens ?? 0,
          )
          const cachedTokens =
            response.usage?.prompt_tokens_details?.cached_tokens ?? 0
          setDetailedTokenAttributes(streamSpan, { cachedTokens })
          setSentryOutputMessages(
            streamSpan,
            response.choices[0]?.message?.content ?? "",
          )
          finishSpan()

          const result = chatCompletionToResponsesResult(
            response,
            responseModel,
          )
          return c.json(result)
        }

        return streamSSE(c, async (sseStream) => {
          try {
            const ccStream = response as AsyncIterable<{
              data?: string
              event?: string
            }>
            const streamUsage = await streamChatCompletionsAsResponses(
              sseStream,
              withSseHeartbeat(ccStream, sseStream),
              responseModel,
            )

            setRequestContext(c, {
              inputTokens: streamUsage.inputTokens,
              outputTokens: streamUsage.outputTokens,
            })

            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              streamUsage.inputTokens ?? 0,
            )
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              streamUsage.outputTokens ?? 0,
            )
            const cachedTokens = streamUsage.cachedTokens ?? 0
            setDetailedTokenAttributes(streamSpan, { cachedTokens })
            setSentryOutputMessages(streamSpan, streamUsage.responseText)
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

async function handleStreamingChatFallbackWebSearch(
  c: Context,
  options: {
    ccPayload: ChatCompletionsPayload
    responseModel: string
  },
): Promise<Response> {
  const payload = { ...options.ccPayload, stream: false, stream_options: null }
  const initial = (await createChatCompletions(payload, {
    signal: c.req.raw.signal,
  })) as ChatCompletionResponse
  const response = await resolveWebSearchCalls(initial, payload, {
    abortSignal: c.req.raw.signal,
  })
  const result = chatCompletionToResponsesResult(
    response,
    options.responseModel,
  )

  return streamSSE(c, async (stream) => {
    await emitResponsesResultAsStream(stream, result)
  })
}
