/* eslint-disable max-lines -- Google protocol routing and stream lifecycle share request context */
/**
 * Handler for Google Generative AI API format.
 * Accepts requests at /v1/models/{model}:generateContent and
 * /v1/models/{model}:streamGenerateContent?alt=sse
 *
 * Translates Google ↔ OpenAI ChatCompletions format to proxy through Copilot.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import {
  type EndpointRouteDecision,
  type EndpointRouteFailure,
} from "~/lib/endpoint-routing"
import {
  createEndpointTranslationError,
  inspectHttpError,
  isAbortError,
  isHTTPError,
  reportHttpError,
} from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import { withSseHeartbeat } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import {
  type StreamTerminalFailure,
  type StreamTerminalLifecycle,
  createStreamTerminalLifecycle,
} from "~/lib/stream-terminal-lifecycle"
import { getTokenCount } from "~/lib/tokenizer"
import {
  addPromptCaching,
  detectInitiator,
  hasVisionContent,
} from "~/services/copilot/copilot-client"
import {
  createAnthropicMessages,
  detectAnthropicInitiator,
  type AnthropicStreamChunk,
} from "~/services/copilot/create-anthropic-messages"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import {
  isChatWebSearchFunctionTool,
  isResponsesWebSearchFunctionTool,
} from "~/services/copilot/mcp-web-search"
import { sanitizeAnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"

import type { AnthropicResponse } from "../messages/anthropic-types"
import type {
  GoogleAIRequest,
  GoogleAIResponse,
  GoogleStreamChunk,
  GoogleStreamFailure,
} from "./google-ai-types"

import {
  chatPayloadToAnthropic,
  streamAnthropicAsChatCompletions,
  anthropicResponseToChat,
} from "../chat-completions/anthropic-bridge"
import { chatCompletionsToResponses } from "../chat-completions/responses-fallback"
import { selectChatUpstreamEndpoint } from "../chat-completions/responses-fallback-executor"
import {
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "../messages/web-search-helpers"
import {
  inlineGoogleFileData,
  translateGoogleToOpenAI,
} from "./request-translation"
import {
  createGoogleStreamState,
  translateChunkToGoogle,
  translateOpenAIToGoogle,
  translateResponsesResultToGoogle,
  translateResponsesStreamEventToGoogle,
} from "./response-translation"

const logger = createHandlerLogger("google-ai-handler")

const GOOGLE_ACTIONS = new Set(["generateContent", "streamGenerateContent"])
const GOOGLE_STREAM_FAILURE_MESSAGE =
  "Upstream stream ended before a terminal response"

type GoogleStreamOutputMode = "json" | "sse"

interface GoogleStreamOutput {
  readonly aborted: boolean
  readonly closed: boolean
  writeChunk(chunk: GoogleStreamChunk): Promise<void>
  wrapSource<T>(source: AsyncIterable<T>): AsyncIterable<T>
  onAbort(callback: () => void): void
}

interface GoogleStreamTerminalAdapter {
  readonly lifecycle: StreamTerminalLifecycle<GoogleAIResponse>
  writePartial(chunk: GoogleAIResponse): Promise<void>
  succeed(chunk: GoogleAIResponse): Promise<boolean>
  failReceived(failure: GoogleStreamFailure): Promise<boolean>
  failAfterCommit(failure: StreamTerminalFailure): Promise<boolean>
  finishSource(): Promise<boolean>
  abort(): boolean
}

function createLocalGoogleStreamFailure(): GoogleStreamFailure {
  return {
    error: {
      code: 500,
      message: GOOGLE_STREAM_FAILURE_MESSAGE,
      status: "INTERNAL",
    },
  }
}

function createGoogleStreamFailure(
  failure: StreamTerminalFailure,
): GoogleStreamFailure {
  if (failure.kind === "thrown" && failure.inspection?.kind === "upstream") {
    const inspection = failure.inspection
    return {
      error: {
        code: inspection.status,
        message: inspection.bodyText ?? GOOGLE_STREAM_FAILURE_MESSAGE,
        status: "INTERNAL",
        ...(inspection.bodyText === undefined ?
          { body_bytes: Array.from(inspection.bodyBytes) }
        : {}),
        ...(inspection.contentType ?
          { content_type: inspection.contentType }
        : {}),
        upstream_status: inspection.status,
      },
    }
  }
  return createLocalGoogleStreamFailure()
}

function createGoogleStreamTerminalAdapter(options: {
  c: Context
  output: GoogleStreamOutput
}): GoogleStreamTerminalAdapter {
  let receivedFailure: GoogleStreamFailure | undefined
  const lifecycle = createStreamTerminalLifecycle<GoogleAIResponse>({
    isDownstreamAborted: () => options.output.aborted || options.output.closed,
    onSuccess: async (chunk) => await options.output.writeChunk(chunk),
    onFailure: async (failure) => {
      await options.output.writeChunk(
        receivedFailure ?? createGoogleStreamFailure(failure),
      )
      if (failure.kind === "thrown" && failure.inspection) {
        reportHttpError(options.c, failure.inspection)
      }
    },
  })
  options.output.onAbort(() => lifecycle.abort())

  return {
    lifecycle,
    writePartial: async (chunk) => {
      if (lifecycle.state === "open") await options.output.writeChunk(chunk)
    },
    succeed: async (chunk) => await lifecycle.succeed(chunk),
    async failReceived(failure) {
      if (lifecycle.state !== "open") return false
      receivedFailure = failure
      return await lifecycle.fail({ kind: "thrown", error: failure })
    },
    failAfterCommit: async (failure) => await lifecycle.fail(failure),
    finishSource: async () => await lifecycle.finishSource(),
    abort: () => lifecycle.abort(),
  }
}

async function failGoogleStreamAfterCommit(
  adapter: GoogleStreamTerminalAdapter,
  output: GoogleStreamOutput,
  error: unknown,
): Promise<void> {
  if (isAbortError(error) || output.aborted || output.closed) {
    adapter.abort()
    return
  }
  const inspection =
    isHTTPError(error) ? await inspectHttpError(error) : undefined
  if (inspection?.status === 499) {
    adapter.abort()
    return
  }
  await adapter.failAfterCommit({
    kind: "thrown",
    error,
    ...(inspection ? { inspection } : {}),
  })
}

async function renderGoogleStream(
  c: Context,
  outputMode: GoogleStreamOutputMode,
  consume: (output: GoogleStreamOutput) => Promise<void>,
): Promise<Response> {
  if (outputMode === "sse") {
    return streamSSE(c, async (stream) => {
      await consume({
        get aborted() {
          return stream.aborted
        },
        get closed() {
          return stream.closed
        },
        writeChunk: async (chunk) => {
          await stream.writeSSE({ data: JSON.stringify(chunk) })
        },
        wrapSource: <T>(source: AsyncIterable<T>) =>
          withSseHeartbeat(source, stream),
        onAbort: (callback) => stream.onAbort(callback),
      })
    })
  }

  const chunks: Array<GoogleStreamChunk> = []
  const signal = c.req.raw.signal
  await consume({
    get aborted() {
      return signal.aborted
    },
    closed: false,
    writeChunk: (chunk) => {
      chunks.push(chunk)
      return Promise.resolve()
    },
    wrapSource: <T>(source: AsyncIterable<T>) => source,
    onAbort: (callback) =>
      signal.addEventListener("abort", callback, { once: true }),
  })
  return c.json(chunks)
}

function receivedGoogleFailure(value: unknown): GoogleStreamFailure {
  if (typeof value !== "object" || value === null) {
    return createLocalGoogleStreamFailure()
  }
  const record = value as Record<string, unknown>
  const nested =
    typeof record.error === "object" && record.error !== null ?
      (record.error as Record<string, unknown>)
    : record
  let upstreamStatus: number | undefined
  if (typeof nested.upstream_status === "number") {
    upstreamStatus = nested.upstream_status
  } else if (typeof nested.status === "number") {
    upstreamStatus = nested.status
  }
  const bodyBytes =
    (
      Array.isArray(nested.body_bytes)
      && nested.body_bytes.every((item) => typeof item === "number")
    ) ?
      ([...nested.body_bytes] as Array<number>)
    : undefined
  return {
    error: {
      code: upstreamStatus ?? 500,
      message:
        typeof nested.message === "string" ?
          nested.message
        : GOOGLE_STREAM_FAILURE_MESSAGE,
      status: "INTERNAL",
      ...(bodyBytes ? { body_bytes: bodyBytes } : {}),
      ...(typeof nested.content_type === "string" ?
        { content_type: nested.content_type }
      : {}),
      ...(upstreamStatus === undefined ?
        {}
      : { upstream_status: upstreamStatus }),
    },
  }
}

function googleActionError(c: Context, message: string): Response {
  return c.json(
    {
      error: {
        code: 400,
        message,
        status: "INVALID_ARGUMENT",
      },
    },
    400,
  )
}

function missingGoogleModelAction(c: Context): Response {
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

function getUnsupportedGoogleRootFields(
  payload: GoogleAIRequest,
): Array<string> {
  const unsupported: Array<string> = []

  if (payload.cachedContent !== undefined) {
    unsupported.push("cachedContent")
  }
  if (payload.labels !== undefined) {
    unsupported.push("labels")
  }
  if (payload.safetySettings !== undefined) {
    unsupported.push("safetySettings")
  }

  return unsupported
}

function getUnsupportedGoogleToolTypes(
  payload: GoogleAIRequest,
): Array<string> {
  const unsupported = new Set<string>()

  for (const tool of payload.tools ?? []) {
    if (tool.codeExecution) {
      unsupported.add("codeExecution")
    }
  }

  return [...unsupported]
}

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
    return { model: modelAction, action: "" }
  }
  return {
    model: modelAction.slice(0, colonIdx),
    action: modelAction.slice(colonIdx + 1),
  }
}

async function resolveGoogleModelRedirect(
  c: Context,
  rawModel: string,
): Promise<{
  model: string
  reasoningEffort?: ReasoningEffort
}> {
  const { baseModel, reasoningEffort: suffixEffort } =
    parseModelSuffix(rawModel)
  const model = normalizeModelName(baseModel)
  const requestedEffort = normalizeReasoningEffortForModel(model, suffixEffort)
  if (suffixEffort && requestedEffort !== suffixEffort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested effort ${suffixEffort} for ${model} was clamped to ${requestedEffort}`,
      data: {
        model,
        requestedEffort: suffixEffort,
        effectiveEffort: requestedEffort,
      },
    })
  }
  const redirect = await applyModelRedirect({
    model,
    effort: requestedEffort,
  })
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: model,
        sourceEffort: requestedEffort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }
  const targetModel = normalizeModelName(redirect.model)
  const reasoningEffort = normalizeReasoningEffortForModel(
    targetModel,
    redirect.effort,
  )
  if (redirect.effort && reasoningEffort !== redirect.effort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested redirected effort ${redirect.effort} for ${targetModel} was clamped to ${reasoningEffort}`,
      data: {
        model: targetModel,
        requestedEffort: redirect.effort,
        effectiveEffort: reasoningEffort,
      },
    })
  }
  return {
    model: targetModel,
    reasoningEffort,
  }
}

export async function handleGoogleAI(c: Context) {
  setRequestContext(c, { suppressModelDiagnostics: true })
  // Extract model and action from URL path
  // URL path: /v1/models/{model}:{action} or /models/{model}:{action}
  const modelAction = c.req.param("modelAction")
  if (!modelAction) return missingGoogleModelAction(c)

  const { model: rawModel, action } = parseModelAction(modelAction)
  if (!action) {
    return googleActionError(c, "Missing Google AI action suffix")
  }
  if (!GOOGLE_ACTIONS.has(action)) {
    return googleActionError(c, "Unsupported Google AI action")
  }
  const isStream = action === "streamGenerateContent"
  const outputMode: GoogleStreamOutputMode =
    c.req.query("alt") === "sse" ? "sse" : "json"

  // Apply silent model redirect — google-ai response format does not include
  // a model field, so client-facing transparency is automatic.
  const { model, reasoningEffort } = await resolveGoogleModelRedirect(
    c,
    rawModel,
  )

  logger.debug("Google AI request")

  // Parse Google AI request body
  const googlePayload = await c.req.json<GoogleAIRequest>()
  logger.debug("Google AI request payload:", JSON.stringify(googlePayload))

  // Inline http(s) fileData attachments (upstream rejects external URLs)
  await inlineGoogleFileData(googlePayload, c.req.raw.signal)

  const unsupportedRootFields = getUnsupportedGoogleRootFields(googlePayload)
  if (unsupportedRootFields.length > 0) {
    return c.json(
      {
        error: {
          code: 400,
          message: `Unsupported Google AI request field(s): ${unsupportedRootFields.join(", ")}`,
          status: "INVALID_ARGUMENT",
        },
      },
      400,
    )
  }

  const unsupportedToolTypes = getUnsupportedGoogleToolTypes(googlePayload)
  if (unsupportedToolTypes.length > 0) {
    return c.json(
      {
        error: {
          code: 400,
          message: `Unsupported Google AI tool type(s): ${unsupportedToolTypes.join(", ")}`,
          status: "INVALID_ARGUMENT",
        },
      },
      400,
    )
  }

  // Translate Google → OpenAI ChatCompletions format
  const openAIPayload = translateGoogleToOpenAI(googlePayload, model, isStream)
  applyGoogleReasoningEffort(c, openAIPayload, reasoningEffort)

  // Apply auto-replacements
  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(openAIPayload)
  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  // Find the selected model for token counting and capability checks
  const selectedModel = state.models?.data.find(
    (m) => m.id === finalPayload.model,
  )

  const routeDecision = selectGoogleUpstreamEndpoint({
    payload: finalPayload,
    selectedModel,
  })
  if ("code" in routeDecision) {
    throw createEndpointTranslationError(routeDecision)
  }

  setRequestContext(c, {
    requestedModel: rawModel,
    model: finalPayload.model,
    provider: googleProviderName(routeDecision.target),
    replacements: appliedRules,
    reasoningEffort,
  })

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

  consola.debug(
    `[google-ai] Translated payload: max_tokens=${finalPayload.max_tokens}, stream=${finalPayload.stream}, tools=${finalPayload.tools?.length ?? 0}, messages=${finalPayload.messages.length}`,
  )
  logger.debug("Translated OpenAI payload:", JSON.stringify(finalPayload))

  return await dispatchGoogleRequest(c, {
    finalPayload,
    requestedModel: rawModel,
    routeDecision,
    selectedModel,
    isStream,
    outputMode,
    reasoningEffort,
  })
}

/** Route to the correct upstream API based on model capabilities. */
async function dispatchGoogleRequest(
  c: Context,
  options: {
    finalPayload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    routeDecision: EndpointRouteDecision
    selectedModel: Model | undefined
    isStream: boolean
    outputMode: GoogleStreamOutputMode
    reasoningEffort?: ReasoningEffort
  },
) {
  const { finalPayload, routeDecision, selectedModel, isStream, outputMode } =
    options

  if (routeDecision.target === "/responses") {
    consola.debug("[google-ai] Using Responses API")
    return await handleWithResponsesApi(c, finalPayload, {
      isStream,
      outputMode,
      effortOverride: options.reasoningEffort,
    })
  }

  if (routeDecision.target === "/v1/messages") {
    consola.debug("[google-ai] Using native /v1/messages")
    return await handleWithAnthropicMessages(c, finalPayload, {
      requestedModel: options.requestedModel,
      selectedModel,
      isStream,
      outputMode,
    })
  }

  consola.debug("[google-ai] Using ChatCompletions API")
  return await handleWithChatCompletions(c, finalPayload, outputMode)
}

export function selectGoogleUpstreamEndpoint(options: {
  payload: ChatCompletionsPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure {
  return selectChatUpstreamEndpoint(options)
}

function googleProviderName(endpoint: EndpointRouteDecision["target"]): string {
  switch (endpoint) {
    case "/responses": {
      return "GoogleAI→Responses"
    }
    case "/v1/messages": {
      return "GoogleAI→AnthropicMessages"
    }
    case "/chat/completions": {
      return "GoogleAI→ChatCompletions"
    }
    default: {
      return "GoogleAI"
    }
  }
}

function payloadHasFileParts(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === "file"),
  )
}

function applyGoogleReasoningEffort(
  c: Context,
  payload: ChatCompletionsPayload,
  effort: ReasoningEffort | undefined,
): void {
  const extra = payload as unknown as Record<string, unknown>
  if (!effort) {
    delete extra.reasoning_effort
    return
  }
  if (usesImplicitReasoningDefault(payload.model)) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_implicit_default",
      message: `${payload.model} is configured for implicit reasoning defaults; removing explicit reasoning_effort=${effort}`,
      data: {
        model: payload.model,
        requestedEffort: effort,
      },
    })
    delete extra.reasoning_effort
    return
  }
  extra.reasoning_effort = effort
}

// ─── ChatCompletions path ───

async function handleWithChatCompletions(
  c: Context,
  finalPayload: ChatCompletionsPayload,
  outputMode: GoogleStreamOutputMode,
) {
  const needsWebSearch =
    finalPayload.tools?.some((tool) => isChatWebSearchFunctionTool(tool))
    ?? false
  if (needsWebSearch) {
    return await handleChatCompletionsWithWebSearch(c, finalPayload, outputMode)
  }

  const response = await createChatCompletions(finalPayload, {
    signal: c.req.raw.signal,
  })

  // Track which account handled this request (multi-token mode)
  const ccAccountId = getLastUsedAccountId()
  if (ccAccountId !== undefined) {
    setRequestContext(c, { accountId: ccAccountId })
  }

  // ─── Non-Streaming Response ───
  if (isNonStreamingCC(response)) {
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

  return await renderGoogleStream(c, outputMode, async (output) => {
    const adapter = createGoogleStreamTerminalAdapter({ c, output })
    try {
      const streamState = createGoogleStreamState()

      for await (const rawEvent of output.wrapSource(response)) {
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
          const finishReason = googleChunk.candidates[0]?.finishReason
          if (finishReason !== null) {
            await adapter.succeed(googleChunk)
            break
          }
          await adapter.writePartial(googleChunk)
        }
      }
      if (adapter.lifecycle.state === "open") await adapter.finishSource()
    } catch (error) {
      await failGoogleStreamAfterCommit(adapter, output, error)
    }
  })
}

async function handleChatCompletionsWithWebSearch(
  c: Context,
  payload: ChatCompletionsPayload,
  outputMode: GoogleStreamOutputMode,
) {
  const requestedStream = Boolean(payload.stream)
  const bufferedPayload = { ...payload, stream: false }
  const initial = (await createChatCompletions(bufferedPayload, {
    signal: c.req.raw.signal,
  })) as ChatCompletionResponse
  const result = await resolveWebSearchCalls(initial, bufferedPayload, {
    abortSignal: c.req.raw.signal,
  })

  if (result.usage) {
    setRequestContext(c, {
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    })
  }

  if (!requestedStream) return c.json(translateOpenAIToGoogle(result))

  return await renderGoogleStream(c, outputMode, async (output) => {
    const adapter = createGoogleStreamTerminalAdapter({ c, output })
    await adapter.succeed(translateOpenAIToGoogle(result))
  })
}

// ─── Native /v1/messages path ───

async function handleWithAnthropicMessages(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: {
    selectedModel?: Model
    isStream: boolean
    outputMode: GoogleStreamOutputMode
    requestedModel: string
  },
) {
  const reason =
    payloadHasFileParts(payload) ? "PDF file attachment" : undefined
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message:
      reason ?
        `${reason} routed ${payload.model} to native /v1/messages`
      : `Model ${payload.model} routed to native /v1/messages`,
    data: {
      model: payload.model,
      sourceEndpoint: "GoogleAI",
      targetEndpoint: "AnthropicMessages",
      ...(reason ? { reason } : {}),
    },
  })
  setRequestContext(c, { provider: "GoogleAI→AnthropicMessages" })

  const anthropicPayload = await chatPayloadToAnthropic(
    payload,
    options.selectedModel,
    c.req.raw.signal,
  )
  const nativeOptions = sanitizeAnthropicRequestHeaderOptions({
    anthropicBeta: c.req.header("anthropic-beta"),
    anthropicVersion: c.req.header("anthropic-version"),
    modelProviderPreference: c.req.header("x-model-provider-preference"),
  })
  const response = await createAnthropicMessages(anthropicPayload, {
    ...nativeOptions,
    initiator: detectAnthropicInitiator(anthropicPayload.messages),
    signal: c.req.raw.signal,
  })

  const nativeAccountId = getLastUsedAccountId()
  if (nativeAccountId !== undefined) {
    setRequestContext(c, { accountId: nativeAccountId })
  }

  if (!options.isStream || !isAsyncIterable(response)) {
    const chatResponse = anthropicResponseToChat(
      response as AnthropicResponse,
      options.requestedModel,
    )
    if (chatResponse.usage) {
      setRequestContext(c, {
        inputTokens: chatResponse.usage.prompt_tokens,
        outputTokens: chatResponse.usage.completion_tokens,
      })
    }
    return c.json(translateOpenAIToGoogle(chatResponse))
  }

  // Anthropic SSE → ChatCompletions chunks → Google chunks
  return await renderGoogleStream(c, options.outputMode, async (output) => {
    const adapter = createGoogleStreamTerminalAdapter({ c, output })
    try {
      const googleState = createGoogleStreamState()
      const chunkShim = {
        writeSSE: async ({ data }: { data: string }) => {
          if (data === "[DONE]") return
          const chunk = JSON.parse(data) as ChatCompletionChunk
          if (!Array.isArray(chunk.choices)) return
          if (chunk.usage) {
            setRequestContext(c, {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            })
          }
          const googleChunk = translateChunkToGoogle(chunk, googleState)
          if (googleChunk) {
            const finishReason = googleChunk.candidates[0]?.finishReason
            if (finishReason !== null) {
              await adapter.succeed(googleChunk)
              return
            }
            await adapter.writePartial(googleChunk)
          }
        },
      }
      const usage = await streamAnthropicAsChatCompletions(
        chunkShim,
        output.wrapSource(response as AsyncIterable<AnthropicStreamChunk>),
        options.requestedModel,
      )
      if (usage.receivedFailure !== undefined) {
        await adapter.failReceived(receivedGoogleFailure(usage.receivedFailure))
      } else if (adapter.lifecycle.state === "open") {
        await adapter.finishSource()
      }
    } catch (error) {
      await failGoogleStreamAfterCommit(adapter, output, error)
    }
  })
}

// ─── Responses API path ───

async function handleWithResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: {
    isStream: boolean
    outputMode: GoogleStreamOutputMode
    effortOverride?: ReasoningEffort
  },
) {
  const { isStream, outputMode, effortOverride } = options
  addPromptCaching(payload.messages, payload.tools ?? undefined)
  // Shared converter carries image_url and file parts through to
  // input_image/input_file (the local converter used to drop them)
  const responsesPayload = chatCompletionsToResponses(payload, effortOverride)
  const vision = hasVisionContent(payload.messages)
  const initiator = detectInitiator(payload.messages)
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  if (
    responsesPayload.tools?.some((tool) =>
      isResponsesWebSearchFunctionTool(tool),
    )
  ) {
    return await handleResponsesMcpWebSearch(c, responsesPayload, {
      isStream,
      outputMode,
      vision,
      initiator,
    })
  }

  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    signal: c.req.raw.signal,
  })

  // Track which account handled this request (multi-token mode)
  const respAccountId = getLastUsedAccountId()
  if (respAccountId !== undefined) {
    setRequestContext(c, { accountId: respAccountId })
  }

  // ─── Non-streaming ───
  if (!isStream || !isAsyncIterable(response)) {
    const result = response as ResponsesResult
    logger.debug("Non-streaming Responses result:", JSON.stringify(result))

    if (result.usage) {
      setRequestContext(c, {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      })
    }

    const googleResponse = translateResponsesResultToGoogle(result)
    return c.json(googleResponse)
  }

  // ─── Streaming ───
  logger.debug("Streaming response from Copilot (Responses API)")

  return await renderGoogleStream(c, outputMode, async (output) => {
    const adapter = createGoogleStreamTerminalAdapter({ c, output })
    try {
      const streamState = createGoogleStreamState()

      for await (const chunk of output.wrapSource(response)) {
        const eventName = chunk.event
        if (eventName === "ping") continue

        const data = chunk.data
        if (!data) continue

        logger.debug("Responses raw stream event:", data)

        const parsed = JSON.parse(data) as ResponseStreamEvent
        const result = translateResponsesStreamEventToGoogle(
          parsed,
          streamState,
        )

        if (result.kind === "ignore") continue
        if (result.kind === "received_failure") {
          await adapter.failReceived(result.failure)
          break
        }
        if (result.kind === "partial") {
          await adapter.writePartial(result.chunk)
          continue
        }

        if (
          (parsed.type === "response.completed"
            || parsed.type === "response.incomplete")
          && parsed.response.usage
        ) {
          setRequestContext(c, {
            inputTokens: parsed.response.usage.input_tokens,
            outputTokens: parsed.response.usage.output_tokens,
          })
        }
        await adapter.succeed(result.chunk)
        break
      }
      if (adapter.lifecycle.state === "open") await adapter.finishSource()
    } catch (error) {
      await failGoogleStreamAfterCommit(adapter, output, error)
    }
  })
}

async function handleResponsesMcpWebSearch(
  c: Context,
  payload: ResponsesPayload,
  options: {
    isStream: boolean
    outputMode: GoogleStreamOutputMode
    vision: boolean
    initiator: "agent" | "user"
  },
) {
  payload.stream = false
  const requestOptions = {
    vision: options.vision,
    initiator: options.initiator,
    signal: c.req.raw.signal,
  }
  const initial = (await createResponses(
    payload,
    requestOptions,
  )) as ResponsesResult
  const result = await resolveResponsesWebSearchCalls(
    initial,
    payload,
    requestOptions,
  )

  const accountId = getLastUsedAccountId()
  if (accountId !== undefined) setRequestContext(c, { accountId })
  if (result.usage) {
    setRequestContext(c, {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    })
  }
  const googleResponse = translateResponsesResultToGoogle(result)
  if (!options.isStream) return c.json(googleResponse)

  return await renderGoogleStream(c, options.outputMode, async (output) => {
    const adapter = createGoogleStreamTerminalAdapter({ c, output })
    await adapter.succeed(googleResponse)
  })
}

const isNonStreamingCC = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
