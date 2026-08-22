/* eslint-disable no-nested-ternary -- prepared and compatibility transport branches remain explicit */
import consola from "consola"
import { events } from "fetch-event-stream"

import type { RoutedAccountPin } from "~/lib/account-router"
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
import {
  claimCompatibilityRetry,
  createRetryBudget,
  PRE_HEADER_MAX_DELAY_SECONDS,
} from "~/services/copilot/transport-retry"

import { fitAnthropicCompactionPayload } from "./compaction-payload"
import { classifyCompatibilityRetry } from "./compatibility-retry"
import { hasVisionContent } from "./copilot-client"
import {
  createMissingAnthropicMessagesMaxTokensError,
  normalizeAnthropicMessagesRequest,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
  validateAnthropicRequestHeaderOptions,
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
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"

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
    allowCompatibilityRetry?: boolean
    anthropicBeta?: string
    anthropicVersion?: string
    compaction?: boolean
    copilotSessionToken?: string
    initiator?: "agent" | "user"
    modelProviderPreference?: string
    alreadyAdapted?: boolean
    preserveValidatedControls?: boolean
    routedAccountPin?: RoutedAccountPin
    retryBudget?: RetryBudget
    signal?: AbortSignal
  },
): Promise<CreateAnthropicMessagesReturn> => {
  const prepared =
    options?.alreadyAdapted ?
      (() => {
        const sanitizedHeaders = validateAnthropicRequestHeaderOptions({
          anthropicBeta: options.anthropicBeta,
          anthropicVersion: options.anthropicVersion,
          modelProviderPreference: options.modelProviderPreference,
        })
        return {
          body: structuredClone(payload),
          headers: {
            ...sanitizedHeaders,
            anthropicVersion:
              sanitizedHeaders.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
          },
        }
      })()
    : options?.preserveValidatedControls ?
      (() => {
        const preservedOptions = options
        const sanitizedHeaders = validateAnthropicRequestHeaderOptions({
          anthropicBeta: preservedOptions.anthropicBeta,
          anthropicVersion: preservedOptions.anthropicVersion,
          modelProviderPreference: preservedOptions.modelProviderPreference,
        })
        return {
          body: normalizeAnthropicMessagesRequest(
            payload,
          ) as AnthropicMessagesPayload,
          headers: {
            ...sanitizedHeaders,
            anthropicVersion:
              sanitizedHeaders.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
          },
        }
      })()
    : prepareAnthropicMessagesRequest({
        anthropicBeta: options?.anthropicBeta,
        anthropicVersion: options?.anthropicVersion,
        modelProviderPreference: options?.modelProviderPreference,
        payload,
      })
  const snapshot = ensureTransportMaxTokens(prepared.body)
  const vision = hasVisionContent(snapshot.messages)
  const initiator =
    options?.initiator ?? detectAnthropicInitiator(snapshot.messages)
  const operationOptions = {
    ...options,
    routedAccountPin: options?.routedAccountPin ?? {},
    retryBudget: options?.retryBudget ?? createRetryBudget(),
  }

  return await dispatchAnthropicMessages({
    initiator,
    options: operationOptions,
    modelId: snapshot.model,
    preparedBody:
      options?.alreadyAdapted ?
        structuredClone(prepared.body)
      : normalizeAnthropicMessagesRequest(prepared.body),
    preparedHeaders: prepared.headers,
    stream: Boolean(snapshot.stream),
    vision,
  })
}

function ensureTransportMaxTokens(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload {
  if (payload.max_tokens !== undefined && payload.max_tokens !== null) {
    return payload
  }
  const maxTokens = getPositiveModelOutputLimit(payload.model)
  if (maxTokens === undefined) {
    throw createMissingAnthropicMessagesMaxTokensError()
  }
  payload.max_tokens = maxTokens
  return payload
}

interface AnthropicDispatchOptions {
  initiator: "agent" | "user"
  options:
    | {
        allowCompatibilityRetry?: boolean
        compaction?: boolean
        copilotSessionToken?: string
        routedAccountPin?: RoutedAccountPin
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
}

interface AnthropicAttempt {
  body: Record<string, unknown>
  response: Response
}

async function dispatchAnthropicAttempt(
  options: AnthropicDispatchOptions,
  body: Record<string, unknown>,
  retry: boolean,
): Promise<Response> {
  return (
    await routedFetch(
      ANTHROPIC_MESSAGES_ENDPOINT,
      {
        method: "POST",
        body: serializeAnthropicMessagesRequest(body),
        signal: options.options?.signal,
      },
      {
        modelId: options.modelId,
        headerOptions: {
          copilotSessionToken: options.options?.copilotSessionToken,
          vision: options.vision,
          initiator: options.initiator,
          ...options.preparedHeaders,
        },
        maxHttpRetryDelaySeconds:
          options.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
        ...(retry ? { reason: "compatibility_retry" as const } : {}),
        ...(retry ? { recordSelection: false } : {}),
        routedAccountPin: options.options?.routedAccountPin,
        retryBudget: options.options?.retryBudget,
      },
    )
  ).response
}

async function retryAnthropicCompatibility(
  options: AnthropicDispatchOptions,
  attempt: AnthropicAttempt,
): Promise<AnthropicAttempt> {
  if (options.options?.allowCompatibilityRetry === false) return attempt
  const decision = await classifyCompatibilityRetry({
    body: attempt.body,
    endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
    response: attempt.response,
  })
  if (decision.kind === "none") return attempt
  const retryBody = structuredClone(attempt.body)
  if (
    !decision.normalize(retryBody)
    || !options.options?.retryBudget
    || !claimCompatibilityRetry(options.options.retryBudget)
  ) {
    return attempt
  }
  return {
    body: retryBody,
    response: await dispatchAnthropicAttempt(options, retryBody, true),
  }
}

async function dispatchAnthropicMessages(
  options: AnthropicDispatchOptions,
): Promise<CreateAnthropicMessagesReturn> {
  const { preparedBody, stream } = options

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

  const attempt = await retryAnthropicCompatibility(options, {
    body,
    response: await dispatchAnthropicAttempt(options, body, false),
  })
  const { body: activeBody, response } = attempt

  if (!response.ok) {
    consola.error(
      "Failed to create native Anthropic messages",
      `Status: ${response.status}`,
    )
    throw new HTTPError(
      "Failed to create native Anthropic messages",
      response,
      activeBody,
    )
  }

  if (stream) {
    return events(response) as AsyncIterable<AnthropicStreamChunk>
  }

  return (await response.json()) as AnthropicResponse
}
