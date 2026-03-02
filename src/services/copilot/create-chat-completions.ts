import consola from "consola"
import { events } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import {
  copilotFetch,
  copilotHeaders,
  hasVisionContent,
  detectInitiator,
  addPromptCaching,
} from "~/services/copilot/copilot-client"

interface StreamEvent {
  data?: string
  event?: string
  id?: string | number
  retry?: number
}

interface ToolCallMappings {
  nextSequenceNumber: number
  mappings: Map<number, { callId: string | undefined; sequenceNumber: number }>
}

export interface StreamNormalizationState {
  roleSetByChoiceIndex: Set<number>
  toolCallMappingsByChoiceIndex: Map<number, ToolCallMappings>
}

type StreamingChoice = ChatCompletionChunk["choices"][number]
type StreamingToolCall = NonNullable<Delta["tool_calls"]>[number]

const createStreamNormalizationState = (): StreamNormalizationState => ({
  roleSetByChoiceIndex: new Set<number>(),
  toolCallMappingsByChoiceIndex: new Map<number, ToolCallMappings>(),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

// Note: streaming normalization helpers mutate chunks in-place for performance.
// The caller (normalizeStreamingEvents) creates a new StreamEvent via spread,
// so only the transient parsed chunk is modified, not the original SSE data.
const ensureAssistantRole = (
  choice: StreamingChoice,
  state: StreamNormalizationState,
  hasContent: boolean,
): void => {
  const isFirstChunkForChoice = !state.roleSetByChoiceIndex.has(choice.index)
  if (!choice.delta.role && (hasContent || isFirstChunkForChoice)) {
    choice.delta.role = "assistant"
    state.roleSetByChoiceIndex.add(choice.index)
  }
}

const ensureToolCallMappings = (
  state: StreamNormalizationState,
  choiceIndex: number,
): ToolCallMappings => {
  const existingMappings = state.toolCallMappingsByChoiceIndex.get(choiceIndex)
  if (existingMappings) {
    return existingMappings
  }

  const createdMappings: ToolCallMappings = {
    nextSequenceNumber: 0,
    mappings: new Map<
      number,
      { callId: string | undefined; sequenceNumber: number }
    >(),
  }

  state.toolCallMappingsByChoiceIndex.set(choiceIndex, createdMappings)
  return createdMappings
}

const normalizeToolCallIndexes = (
  toolCalls: Array<StreamingToolCall>,
  toolCallMappings: ToolCallMappings,
): void => {
  for (const toolCall of toolCalls) {
    const sourceIndex = toolCall.index
    const existingMapping = toolCallMappings.mappings.get(sourceIndex)

    if (existingMapping !== undefined) {
      if (toolCall.id && existingMapping.callId !== toolCall.id) {
        existingMapping.sequenceNumber = toolCallMappings.nextSequenceNumber++
        existingMapping.callId = toolCall.id
      }

      toolCall.index = existingMapping.sequenceNumber
      continue
    }

    const newMapping = {
      callId: toolCall.id,
      sequenceNumber: toolCallMappings.nextSequenceNumber++,
    }
    toolCallMappings.mappings.set(sourceIndex, newMapping)
    toolCall.index = newMapping.sequenceNumber
  }
}

const normalizeToolCallChoice = (
  choice: StreamingChoice,
  state: StreamNormalizationState,
): void => {
  const toolCalls = choice.delta.tool_calls
  if (!toolCalls || toolCalls.length === 0) {
    return
  }

  if (!choice.delta.role) {
    choice.delta.role = "assistant"
    state.roleSetByChoiceIndex.add(choice.index)
  }

  // Only set finish_reason when it's truly missing (undefined), not when
  // it's intentionally null (OpenAI uses null on intermediate chunks)
  if (choice.finish_reason === undefined) {
    choice.finish_reason = "tool_calls"
  }

  const mappings = ensureToolCallMappings(state, choice.index)
  normalizeToolCallIndexes(toolCalls, mappings)
}

const normalizeFunctionTool = (tool: unknown): void => {
  if (!isRecord(tool) || tool.type !== "function") {
    return
  }

  const functionDefinition = tool.function
  if (!isRecord(functionDefinition)) {
    return
  }

  const parameters = functionDefinition.parameters
  if (!isRecord(parameters) || Array.isArray(parameters)) {
    functionDefinition.parameters = { type: "object", properties: {} }
    return
  }

  if (!parameters.type) {
    parameters.type = "object"
  }
  if (!isRecord(parameters.properties)) {
    parameters.properties = {}
  }
}

export const normalizeStreamingChunk = (
  chunk: ChatCompletionChunk,
  state: StreamNormalizationState,
): ChatCompletionChunk => {
  for (const choice of chunk.choices) {
    const delta = choice.delta
    const hasContent = Boolean(
      delta.content
      || Boolean(delta.tool_calls?.length)
      || (delta as { refusal?: unknown }).refusal,
    )
    ensureAssistantRole(choice, state, hasContent)
    normalizeToolCallChoice(choice, state)
  }

  return chunk
}

const normalizeStreamingEvents = async function* (
  stream: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  const normalizationState = createStreamNormalizationState()

  for await (const streamEvent of stream) {
    const data = streamEvent.data
    if (!data || data === "[DONE]") {
      yield streamEvent
      continue
    }

    try {
      const parsedChunk = JSON.parse(data) as {
        choices?: unknown
      }
      if (
        !Array.isArray(parsedChunk.choices)
        || !parsedChunk.choices.every(
          (choice) => isRecord(choice) && isRecord(choice.delta),
        )
      ) {
        yield streamEvent
        continue
      }

      const normalizedChunk = normalizeStreamingChunk(
        parsedChunk as ChatCompletionChunk,
        normalizationState,
      )
      yield {
        ...streamEvent,
        data: JSON.stringify(normalizedChunk),
      }
    } catch {
      yield streamEvent
    }
  }
}

/**
 * Normalize payload before sending to Copilot.
 * - Fix empty tool parameters (Copilot rejects {} without type/properties)
 * - Downgrade json_schema to json_object (Copilot returns empty content for json_schema)
 *   and stash the schema so injectJsonInstruction can reference it
 */
const normalizePayload = (payload: ChatCompletionsPayload): void => {
  if (payload.tools) {
    for (const tool of payload.tools) {
      normalizeFunctionTool(tool)
    }
  }

  if (
    payload.response_format
    && (payload.response_format as Record<string, unknown>).type
      === "json_schema"
  ) {
    const fmt = payload.response_format as Record<string, unknown>
    const schemaWrapper = fmt.json_schema as Record<string, unknown> | undefined
    const jsonSchema = schemaWrapper?.schema
    if (jsonSchema) {
      ;(payload as unknown as Record<string, unknown>)._json_schema = jsonSchema
    }
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
 *
 * If a json_schema was downgraded to json_object, include the schema in the
 * instruction so the model returns the correct structure.
 */
const injectJsonInstruction = (payload: ChatCompletionsPayload): void => {
  if (!isJsonResponseFormat(payload)) return

  const stashedSchema = (payload as unknown as Record<string, unknown>)
    ._json_schema
  let instruction =
    "IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation — just raw JSON."

  if (stashedSchema) {
    instruction += `\nYou MUST conform to this JSON schema:\n${JSON.stringify(stashedSchema)}`
    delete (payload as unknown as Record<string, unknown>)._json_schema
  }

  const systemMsg = payload.messages.find((m) => m.role === "system")
  if (systemMsg && typeof systemMsg.content === "string") {
    systemMsg.content = `${systemMsg.content}\n\n${instruction}`
  } else {
    payload.messages.unshift({ role: "system", content: instruction })
  }
}

const imageTypes = new Set(["image_url", "image", "input_image"])

function removeImages(payload: ChatCompletionsPayload): void {
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.filter((part) => !imageTypes.has(part.type))
      if (msg.content.length === 1) {
        const first = msg.content[0] as TextPart
        msg.content = first.text
      }
    }
  }
}

async function handleResponse(
  response: Response,
  payload: ChatCompletionsPayload,
) {
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
    return normalizeStreamingEvents(events(response))
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

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options?: {
    initiator?: "agent" | "user"
  },
) => {
  const vision = hasVisionContent(payload.messages)
  const initiator = detectInitiator(payload.messages, options?.initiator)
  const headers = copilotHeaders({ vision, initiator })

  normalizePayload(payload)
  injectJsonInstruction(payload)
  addPromptCaching(payload.messages, payload.tools ?? undefined)

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  // 413 image fallback: if request has images and response is 413, remove images and retry
  if (response.status === 413 && vision) {
    consola.warn("413 Payload Too Large with images, retrying without images")
    removeImages(payload)
    const retryHeaders = copilotHeaders({ vision: false, initiator })
    const retryResponse = await copilotFetch("/chat/completions", {
      method: "POST",
      headers: retryHeaders,
      body: JSON.stringify(payload),
    })
    return handleResponse(retryResponse, payload)
  }

  return handleResponse(response, payload)
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

export interface Delta {
  content?: string | null
  reasoning_text?: string | null // Claude thinking text from CAPI
  reasoning_opaque?: string | null // Encrypted signature from CAPI (streaming)
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

export interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null // Claude thinking text from CAPI
  reasoning_opaque?: string | null // Encrypted signature from CAPI
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
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null

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
