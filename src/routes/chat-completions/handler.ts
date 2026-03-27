import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { calculateCost } from "~/lib/pricing-cache"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { traceRecorder } from "~/lib/trace-recorder"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

// ─── Trace helpers ───

function traceSpanId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16)
}
function newTraceId(): string {
  return crypto.randomUUID().replaceAll("-", "")
}
function traceNow(): string {
  return new Date().toISOString()
}

/** Safe wrapper - tracing never breaks the proxy */
const safeTrace = (fn: () => void): void => {
  try {
    fn()
  } catch {
    // Tracing is best-effort
  }
}

interface TraceCtx {
  traceId: string
  rootSpanId: string
  model: string
}

const recordLlmSpan = (
  ctx: TraceCtx,
  startTime: string,
  opts: { inputTokens: number; outputTokens: number; output?: string },
): void => {
  const cost = calculateCost(ctx.model, opts.inputTokens, opts.outputTokens)
  traceRecorder.recordSpan({
    id: traceSpanId(),
    traceId: ctx.traceId,
    parentSpanId: ctx.rootSpanId,
    name: "copilot-api-call",
    type: "llm",
    startTime,
    endTime: traceNow(),
    provider: "ChatCompletions",
    model: ctx.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    inputCostUsd: cost.inputCostUsd,
    outputCostUsd: cost.outputCostUsd,
    output: opts.output,
  })
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const currentTraceId = newTraceId()
  const rootSpanId = traceSpanId()

  const rawPayload = await c.req.json<ChatCompletionsPayload>()

  safeTrace(() =>
    traceRecorder.startTrace({
      id: currentTraceId,
      name: `POST ${c.req.path}`,
      input: JSON.stringify(rawPayload).slice(0, 10000),
      meta: { environment: process.env.NODE_ENV },
    }),
  )

  // Record parse-request span
  const parseStart = traceNow()

  // Capture the originally requested model before any manipulation
  const requestedModel = rawPayload.model

  // Parse model suffix to strip reasoning effort suffix (e.g. "gpt-5.3-codex:high" -> "gpt-5.3-codex")
  const { baseModel, reasoningEffort } = parseModelSuffix(rawPayload.model)
  rawPayload.model = baseModel

  // Apply auto-replacements to the payload
  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(rawPayload)

  // Normalize model name (e.g., claude-opus-4-5 -> claude-opus-4.5)
  let payload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  safeTrace(() =>
    traceRecorder.recordSpan({
      id: traceSpanId(),
      traceId: currentTraceId,
      parentSpanId: rootSpanId,
      name: "parse-request",
      type: "step",
      startTime: parseStart,
      endTime: traceNow(),
      input: JSON.stringify({ model: requestedModel }).slice(0, 5000),
      output: JSON.stringify({ model: payload.model }).slice(0, 5000),
    }),
  )

  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  setRequestContext(c, {
    requestedModel,
    provider: "ChatCompletions",
    model: payload.model,
    replacements: appliedRules,
    reasoningEffort,
  })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  try {
    return await executeRequest(c, payload, {
      traceId: currentTraceId,
      rootSpanId,
    })
  } catch (error) {
    safeTrace(() =>
      traceRecorder.endTrace({
        id: currentTraceId,
        status: "error",
        statusMessage: error instanceof Error ? error.message : String(error),
      }),
    )
    throw error
  }
}

const executeRequest = async (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  traceCtx: { traceId: string; rootSpanId: string },
) => {
  const { traceId, rootSpanId } = traceCtx

  // Record select-token span
  const selectTokenStart = traceNow()
  const response = await createChatCompletions(payload)

  // Track which account handled this request (multi-token mode)
  const accountId = getLastUsedAccountId()
  if (accountId !== undefined) {
    setRequestContext(c, { accountId })
  }

  safeTrace(() =>
    traceRecorder.recordSpan({
      id: traceSpanId(),
      traceId,
      parentSpanId: rootSpanId,
      name: "select-token",
      type: "step",
      startTime: selectTokenStart,
      endTime: traceNow(),
      output: JSON.stringify({ accountId }),
    }),
  )

  const ctx: TraceCtx = { traceId, rootSpanId, model: payload.model }

  if (isNonStreaming(response)) {
    return handleNonStreamingResponse(c, response, ctx)
  }

  return handleStreamingResponse(c, response, ctx)
}

const handleNonStreamingResponse = (
  c: Context,
  response: ChatCompletionResponse,
  ctx: TraceCtx,
) => {
  const llmSpanStart = traceNow()

  consola.debug("Non-streaming response:", JSON.stringify(response))
  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }

  safeTrace(() =>
    recordLlmSpan(ctx, llmSpanStart, {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      output: JSON.stringify(response).slice(0, 10000),
    }),
  )

  safeTrace(() => traceRecorder.endTrace({ id: ctx.traceId, status: "ok" }))
  return c.json(response)
}

const handleStreamingResponse = (
  c: Context,
  response: AsyncIterable<{ data?: string; event?: string }>,
  ctx: TraceCtx,
) => {
  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    const llmSpanStart = traceNow()
    let streamInputTokens = 0
    let streamOutputTokens = 0

    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      // Capture usage from final chunk if available
      if (chunk.data && chunk.data !== "[DONE]") {
        const parsed = JSON.parse(chunk.data) as ChatCompletionChunk
        if (parsed.usage) {
          streamInputTokens = parsed.usage.prompt_tokens
          streamOutputTokens = parsed.usage.completion_tokens
          setRequestContext(c, {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          })
        }
      }
      await stream.writeSSE(chunk as SSEMessage)
    }

    // Record copilot-api-call span after streaming completes
    safeTrace(() =>
      recordLlmSpan(ctx, llmSpanStart, {
        inputTokens: streamInputTokens,
        outputTokens: streamOutputTokens,
      }),
    )

    safeTrace(() => traceRecorder.endTrace({ id: ctx.traceId, status: "ok" }))
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
