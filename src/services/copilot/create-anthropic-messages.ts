import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { routedFetch } from "~/lib/account-router"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { PRE_HEADER_MAX_DELAY_SECONDS } from "~/services/copilot/transport-retry"

import { fitAnthropicCompactionPayload } from "./compaction-payload"
import { hasVisionContent } from "./copilot-client"

/**
 * Native Anthropic Messages endpoint on the Copilot API.
 *
 * Claude models advertise "/v1/messages" in supported_endpoints. This path
 * accepts the Anthropic dialect natively — including base64 `document`
 * (PDF) blocks, which /chat/completions cannot carry at all. Empirically
 * verified (2026-07-03): streaming, system blocks, tools, tool_choice,
 * thinking, cache_control, tool_result image blocks and document
 * title/context/citations all work. Not accepted: text/url document
 * sources, url image sources (inlined by the caller beforehand),
 * temperature+top_p together, output_config.effort on non-effort models.
 */

export const ANTHROPIC_MESSAGES_ENDPOINT = "/v1/messages"

export function modelSupportsNativeMessages(
  model: { supported_endpoints?: Array<string> } | undefined,
): boolean {
  return (
    model?.supported_endpoints?.includes(ANTHROPIC_MESSAGES_ENDPOINT) ?? false
  )
}

/**
 * Fields the Copilot /v1/messages endpoint is known to accept. Anything else
 * (client extensions like `betas`, `container`, proxy-internal fields) is
 * stripped to avoid 400s.
 */
const KNOWN_MESSAGES_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "system",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
])

export interface AnthropicStreamChunk {
  event?: string
  data?: string
}

export type CreateAnthropicMessagesReturn =
  | AnthropicResponse
  | AsyncIterable<AnthropicStreamChunk>

type NativeCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeMessagesPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (key, value: unknown) => {
    if (
      key !== "cache_control"
      || !isRecord(value)
      || value.type !== "ephemeral"
    ) {
      return value
    }

    const cacheControl: NativeCacheControl = { type: "ephemeral" }
    if (value.ttl === "5m" || value.ttl === "1h") {
      cacheControl.ttl = value.ttl
    }
    return cacheControl
  })
}

function sanitizeMessagesPayload(
  payload: AnthropicMessagesPayload,
): Record<string, unknown> {
  const source = payload as unknown as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of KNOWN_MESSAGES_FIELDS) {
    if (key in source && source[key] !== undefined) {
      result[key] = source[key]
    }
  }

  // Copilot's /v1/messages rejects temperature and top_p together, and the
  // Anthropic API requires temperature=1 (or unset) when thinking is enabled.
  if (payload.thinking) {
    delete result.temperature
    delete result.top_p
  } else if (result.temperature !== undefined && result.top_p !== undefined) {
    delete result.top_p
  }

  // Effort is model-gated upstream ("does not support reasoning effort").
  const outputConfig = result.output_config as
    | { effort?: string; [key: string]: unknown }
    | undefined
  if (outputConfig?.effort && !modelSupportsEffort(payload.model)) {
    consola.debug(
      `Removing output_config.effort for ${payload.model}: model does not support reasoning effort`,
    )
    const { effort: _effort, ...rest } = outputConfig
    if (Object.keys(rest).length > 0) {
      result.output_config = rest
    } else {
      delete result.output_config
    }
  }

  return result
}

function modelSupportsEffort(modelId: string): boolean {
  const supports = state.models?.data.find((entry) => entry.id === modelId)
    ?.capabilities.supports
  const efforts = (supports as { reasoning_effort?: Array<string> } | undefined)
    ?.reasoning_effort
  return Array.isArray(efforts) && efforts.length > 0
}

export function detectAnthropicInitiator(
  messages: Array<AnthropicMessage>,
): "agent" | "user" {
  const last = messages.at(-1)
  if (!last) return "user"
  if (last.role === "assistant") return "agent"
  if (
    Array.isArray(last.content)
    && last.content.some((block) => block.type === "tool_result")
  ) {
    return "agent"
  }
  return "user"
}

export const createAnthropicMessages = async (
  payload: AnthropicMessagesPayload,
  options?: {
    compaction?: boolean
    initiator?: "agent" | "user"
    signal?: AbortSignal
  },
): Promise<CreateAnthropicMessagesReturn> => {
  const vision = hasVisionContent(payload.messages)
  const initiator =
    options?.initiator ?? detectAnthropicInitiator(payload.messages)

  const sanitizedBody = sanitizeMessagesPayload(payload)
  const fitted =
    options?.compaction ? fitAnthropicCompactionPayload(sanitizedBody) : null
  const body = fitted?.payload ?? sanitizedBody
  if (fitted?.reduced) {
    consola.warn("Reduced oversized native Messages compaction payload", {
      originalBytes: fitted.originalBytes,
      finalBytes: fitted.finalBytes,
      omittedBinaryBlocks: fitted.omittedBinaryBlocks,
      truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
    })
  }

  const { response } = await routedFetch(
    ANTHROPIC_MESSAGES_ENDPOINT,
    {
      method: "POST",
      body: serializeMessagesPayload(body),
      signal: options?.signal,
    },
    {
      modelId: payload.model,
      headerOptions: { vision, initiator, anthropicVersion: "2023-06-01" },
      maxHttpRetryDelaySeconds:
        payload.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
    },
  )

  if (!response.ok) {
    consola.error(
      "Failed to create native Anthropic messages",
      `Status: ${response.status}`,
    )
    throw new HTTPError(
      "Failed to create native Anthropic messages",
      response,
      body,
    )
  }

  if (payload.stream) {
    return events(response) as AsyncIterable<AnthropicStreamChunk>
  }

  return (await response.json()) as AnthropicResponse
}
