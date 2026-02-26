import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/retry-fetch"
import { state } from "~/lib/state"

/**
 * Normalize payload before sending to Copilot.
 * - Fix empty tool parameters (Copilot rejects {} without type/properties)
 * - Downgrade json_schema to json_object (Copilot returns empty content for json_schema)
 */
const normalizePayload = (payload: ChatCompletionsPayload): void => {
  if (payload.tools) {
    for (const tool of payload.tools) {
      const params = tool.function.parameters
      if (!params.type) {
        params.type = "object"
      }
      if (!params.properties) {
        params.properties = {}
      }
    }
  }

  if (
    payload.response_format
    && (payload.response_format as Record<string, unknown>).type
      === "json_schema"
  ) {
    payload.response_format = { type: "json_object" }
  }
}

const isJsonResponseFormat = (payload: ChatCompletionsPayload): boolean => {
  const type = (payload.response_format as Record<string, unknown> | undefined)
    ?.type
  return type === "json_object" || type === "json_schema"
}

/**
 * Strip markdown code fences from content when json response_format is requested.
 * Claude wraps JSON output in ```json ... ``` fences, violating the OpenAI contract
 * that guarantees raw JSON in the content field.
 */
const stripJsonFences = (result: ChatCompletionResponse): void => {
  for (const choice of result.choices) {
    const content = choice.message.content
    if (typeof content !== "string") continue
    const stripped = content
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\n?```\s*$/, "")
    if (stripped !== content) {
      choice.message.content = stripped
    }
  }
}

/**
 * When response_format requests JSON output, inject a system-level instruction
 * as a fallback. Copilot may not pass response_format through for all models
 * (e.g. Claude), causing the model to return markdown instead of JSON.
 */
const injectJsonInstruction = (payload: ChatCompletionsPayload): void => {
  if (!isJsonResponseFormat(payload)) return

  const instruction =
    "IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation — just raw JSON."

  const systemMsg = payload.messages.find((m) => m.role === "system")
  if (systemMsg && typeof systemMsg.content === "string") {
    systemMsg.content = `${systemMsg.content}\n\n${instruction}`
  } else {
    payload.messages.unshift({ role: "system", content: instruction })
  }
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options?: {
    initiator?: "agent" | "user"
  },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Check only the last message to prevent false positives in multi-turn conversations
  let isAgentCall = false
  if (payload.messages.length > 0) {
    const lastMessage = payload.messages.at(-1)
    if (lastMessage) {
      isAgentCall = ["assistant", "tool"].includes(lastMessage.role)
    }
  }

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": options?.initiator ?? (isAgentCall ? "agent" : "user"),
  }

  normalizePayload(payload)
  injectJsonInstruction(payload)

  const response = await fetchWithRetry(
    `${copilotBaseUrl(state)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  )

  if (!response.ok) {
    const errorBody = await response.clone().text()
    consola.error(
      "Failed to create chat completions",
      `Status: ${response.status}`,
      errorBody,
    )
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  const text = await response.text()
  if (!text) {
    consola.error("Empty response body from Copilot (status 200)")
    throw new HTTPError(
      "Empty response body from upstream",
      new Response("", { status: 502 }),
    )
  }

  try {
    const result = JSON.parse(text) as ChatCompletionResponse
    if (isJsonResponseFormat(payload)) {
      stripJsonFences(result)
    }
    return result
  } catch {
    consola.error("Invalid JSON from Copilot:", text.slice(0, 200))
    throw new HTTPError(
      "Invalid JSON response from upstream",
      new Response(text, { status: 502 }),
    )
  }
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null
  stream_options?: { include_usage?: boolean } | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: string; [key: string]: unknown } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
