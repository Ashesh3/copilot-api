import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import { routedFetch } from "~/lib/account-router"
import { getModelEndpointSupport } from "~/lib/endpoint-routing"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { PRE_HEADER_MAX_DELAY_SECONDS } from "~/services/copilot/transport-retry"

import { fitAnthropicCompactionPayload } from "./compaction-payload"
import { hasVisionContent } from "./copilot-client"
import {
  normalizeAnthropicMessagesRequest,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "./messages-contract"

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
  return getModelEndpointSupport(model).messages
}

export interface AnthropicStreamChunk {
  event?: string
  data?: string
}

export type CreateAnthropicMessagesReturn =
  | AnthropicResponse
  | AsyncIterable<AnthropicStreamChunk>

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

function getPositiveModelOutputLimit(modelId: string): number | undefined {
  const limit = state.models?.data.find((model) => model.id === modelId)
    ?.capabilities.limits?.max_output_tokens
  return Number.isInteger(limit) && Number(limit) > 0 ? limit : undefined
}

export const createAnthropicMessages = async (
  payload: AnthropicMessagesPayload,
  options?: {
    anthropicBeta?: string
    anthropicVersion?: string
    compaction?: boolean
    initiator?: "agent" | "user"
    modelProviderPreference?: string
    preserveValidatedControls?: boolean
    retryBudget?: RetryBudget
    signal?: AbortSignal
  },
): Promise<CreateAnthropicMessagesReturn> => {
  const initialPrepared = prepareAnthropicMessagesRequest({
    anthropicBeta: options?.anthropicBeta,
    anthropicVersion: options?.anthropicVersion,
    modelProviderPreference: options?.modelProviderPreference,
    payload,
    requireMaxTokens: !options?.preserveValidatedControls,
  })
  const initialBody =
    initialPrepared.body as unknown as AnthropicMessagesPayload
  if (
    options?.preserveValidatedControls
    && initialBody.max_tokens === undefined
  ) {
    const maxTokens = getPositiveModelOutputLimit(initialBody.model)
    if (maxTokens !== undefined) initialBody.max_tokens = maxTokens
  }
  const prepared = prepareAnthropicMessagesRequest({
    ...initialPrepared.headers,
    payload: initialBody,
    requireMaxTokens: true,
  })
  const snapshot = prepared.body as unknown as AnthropicMessagesPayload
  const vision = hasVisionContent(snapshot.messages)
  const initiator =
    options?.initiator ?? detectAnthropicInitiator(snapshot.messages)

  return await dispatchAnthropicMessages({
    initiator,
    options,
    modelId: snapshot.model,
    preparedBody: normalizeAnthropicMessagesRequest(prepared.body),
    preparedHeaders: prepared.headers,
    stream: Boolean(snapshot.stream),
    vision,
  })
}

async function dispatchAnthropicMessages(options: {
  initiator: "agent" | "user"
  options:
    | {
        compaction?: boolean
        retryBudget?: RetryBudget
        signal?: AbortSignal
      }
    | undefined
  modelId: string
  preparedBody: Record<string, unknown>
  preparedHeaders: {
    anthropicBeta?: string
    anthropicVersion: string
    modelProviderPreference?: string
  }
  stream: boolean
  vision: boolean
}): Promise<CreateAnthropicMessagesReturn> {
  const { initiator, modelId, preparedBody, preparedHeaders, stream, vision } =
    options

  const fitted =
    options.options?.compaction ?
      fitAnthropicCompactionPayload(preparedBody)
    : null
  const body = fitted?.payload ?? preparedBody
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
      body: serializeAnthropicMessagesRequest(body),
      signal: options.options?.signal,
    },
    {
      modelId,
      headerOptions: { vision, initiator, ...preparedHeaders },
      maxHttpRetryDelaySeconds:
        stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
      retryBudget: options.options?.retryBudget,
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

  if (stream) {
    return events(response) as AsyncIterable<AnthropicStreamChunk>
  }

  return (await response.json()) as AnthropicResponse
}
