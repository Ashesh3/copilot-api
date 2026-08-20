import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { routedFetch } from "~/lib/account-router"
import { HTTPError } from "~/lib/error"

import { hasVisionContent } from "./copilot-client"
import { detectAnthropicInitiator } from "./create-anthropic-messages"
import {
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "./messages-contract"

const ANTHROPIC_COUNT_TOKENS_ENDPOINT = "/v1/messages/count_tokens"
const COUNT_TOKENS_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
])

export interface CountAnthropicTokensOptions {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  signal?: AbortSignal
}

export interface AnthropicTokenCountResult {
  input_tokens: number
}

function selectCountTokensBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([field]) => COUNT_TOKENS_FIELDS.has(field)),
  )
}

function isAnthropicTokenCountResult(
  value: unknown,
): value is AnthropicTokenCountResult {
  if (typeof value !== "object" || value === null) return false
  const inputTokens = (value as { input_tokens?: unknown }).input_tokens
  return (
    typeof inputTokens === "number"
    && Number.isFinite(inputTokens)
    && Number.isInteger(inputTokens)
    && inputTokens >= 0
  )
}

function invalidTokenCountResponse(): HTTPError {
  return new HTTPError(
    "Invalid token count response from upstream",
    new Response(null, { status: 502 }),
  )
}

export async function countAnthropicTokens(
  payload: AnthropicMessagesPayload,
  options: CountAnthropicTokensOptions = {},
): Promise<AnthropicTokenCountResult> {
  const prepared = prepareAnthropicMessagesRequest({
    anthropicBeta: options.anthropicBeta,
    anthropicVersion: options.anthropicVersion,
    modelProviderPreference: options.modelProviderPreference,
    payload,
    requireMaxTokens: false,
  })
  const body = selectCountTokensBody(prepared.body)
  const snapshot = body as unknown as AnthropicMessagesPayload
  const { response } = await routedFetch(
    ANTHROPIC_COUNT_TOKENS_ENDPOINT,
    {
      method: "POST",
      body: serializeAnthropicMessagesRequest(body),
      signal: options.signal,
    },
    {
      modelId: snapshot.model,
      headerOptions: {
        initiator: detectAnthropicInitiator(snapshot.messages),
        vision: hasVisionContent(snapshot.messages),
        ...prepared.headers,
      },
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to count Anthropic tokens", response, body)
  }

  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw invalidTokenCountResponse()
  }
  if (!isAnthropicTokenCountResult(result)) {
    throw invalidTokenCountResponse()
  }
  return { input_tokens: result.input_tokens }
}
