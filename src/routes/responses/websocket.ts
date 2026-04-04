import consola from "consola"
import { randomUUID } from "node:crypto"

import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  convertWebSearchTool,
  normalizeResponsesReasoning,
  responsesToChatCompletions,
  streamChatCompletionsAsResponses,
  useFunctionApplyPatch,
} from "./handler"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"

const RESPONSES_ENDPOINT = "/responses"

// Paths that trigger WebSocket upgrade for responses
const WS_PATHS = new Set(["/v1/responses", "/responses"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

interface ResponsesWebSocketData {
  type: "responses"
  syntheticWarmups: Map<string, ResponsesPayload>
}

/**
 * Check if a request is a responses WebSocket upgrade and handle it.
 * Returns "upgraded" if the upgrade was handled, "auth_failed" if auth failed,
 * or "no_match" if the path didn't match.
 */
export function tryUpgradeResponsesWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): "upgraded" | "auth_failed" | "no_match" {
  const url = new URL(req.url)
  if (!WS_PATHS.has(url.pathname)) return "no_match"

  // Validate API key auth if enabled
  if (state.apiKeyAuth) {
    const apiKey = extractApiKeyFromRequest(req)
    if (apiKey !== state.apiKeyAuth) {
      consola.debug("[responses-ws] Rejected: invalid API key")
      return "auth_failed"
    }
  }

  server.upgrade(req, {
    data: {
      type: "responses" as const,
      syntheticWarmups: new Map<string, ResponsesPayload>(),
    } satisfies ResponsesWebSocketData,
  })
  return "upgraded"
}

function extractApiKeyFromRequest(req: Request): string | null {
  const xApiKey = req.headers.get("x-api-key")?.trim()
  if (xApiKey) return xApiKey

  const authorization = req.headers.get("authorization")
  if (!authorization) return null

  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") return null

  return rest.join(" ").trim() || null
}

// Bun WebSocket handler for responses
export const responsesWebSocket = {
  open(_ws: { data: ResponsesWebSocketData }) {
    consola.debug("[responses-ws] WebSocket connected")
  },

  async message(
    ws: {
      data: ResponsesWebSocketData
      send(data: string | ArrayBuffer | Uint8Array): void
      close(code?: number, reason?: string): void
    },
    message: string | Buffer | Uint8Array,
  ) {
    if (typeof message !== "string") {
      ws.send(
        JSON.stringify({
          type: "error",
          error: {
            message: "Binary frames not supported",
            code: "invalid_request",
          },
        }),
      )
      return
    }

    let parsed: { type?: string; [key: string]: unknown }
    try {
      parsed = JSON.parse(message) as { type?: string; [key: string]: unknown }
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          error: { message: "Invalid JSON", code: "invalid_request" },
        }),
      )
      return
    }

    if (parsed.type !== "response.create") {
      ws.send(
        JSON.stringify({
          type: "error",
          error: {
            message: `Unsupported message type: ${parsed.type}`,
            code: "invalid_request",
          },
        }),
      )
      return
    }

    try {
      await handleResponseCreate(ws, parsed)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error"
      consola.error("[responses-ws] Error:", errorMessage)
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            error: { message: errorMessage, code: "server_error" },
          }),
        )
      } catch {
        // Client already disconnected, nothing to do
      }
    }
  },

  close(ws: { data: ResponsesWebSocketData }) {
    ws.data.syntheticWarmups.clear()
    consola.debug("[responses-ws] WebSocket closed")
  },
}

async function handleResponseCreate(
  ws: { data: ResponsesWebSocketData; send(data: string): void },
  message: Record<string, unknown>,
): Promise<void> {
  await checkRateLimit(state)

  let payload = extractResponsesPayload(message)

  // Force streaming for WebSocket mode
  payload.stream = true

  // Apply same transformations as HTTP handler
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  payload.model = baseModel
  normalizeResponsesReasoning(payload, suffixEffort)

  useFunctionApplyPatch(payload)
  convertWebSearchTool(payload)
  expandCompactionItems(payload)

  payload =
    rehydrateSyntheticWarmupPayload(ws.data.syntheticWarmups, payload)
    ?? payload

  if (isSyntheticWarmupRequest(payload)) {
    handleSyntheticWarmupRequest(ws, payload)
    return
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (!supportsResponses) {
    consola.debug(
      `[responses-ws] Model ${payload.model} does not support /responses, falling back to ChatCompletions`,
    )
    await streamChatCompletionsOverWs(ws, payload)
    return
  }

  // Native responses streaming
  const response = await createResponses(payload, { vision, initiator })

  if (!isAsyncIterable(response)) {
    // Shouldn't happen since we forced stream: true, but handle gracefully
    ws.send(JSON.stringify({ type: "response.completed", response }))
    return
  }

  const idTracker = createStreamIdTracker()
  for await (const chunk of response) {
    const data = (chunk as { data?: string }).data
    if (!data) continue

    const event = (chunk as { event?: string }).event
    const processed = fixStreamIds(data, event, idTracker)
    ws.send(processed)
  }
}

export function extractResponsesPayload(
  message: Record<string, unknown>,
): ResponsesPayload {
  const { type: _type, response, ...topLevel } = message

  if (!isRecord(response)) {
    return topLevel as ResponsesPayload
  }

  // Some clients split fields between top-level and nested response payload.
  // Merge both so required continuation fields (e.g. previous_response_id)
  // are preserved regardless of where they're sent.
  return {
    ...topLevel,
    ...response,
  } as ResponsesPayload
}

export function isSyntheticWarmupRequest(payload: ResponsesPayload): boolean {
  return (payload as Record<string, unknown>).generate === false
}

export function rehydrateWarmupPayload(
  warmupPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  const mergedInput = mergeWarmupInput(warmupPayload.input, payload.input)

  return {
    ...payload,
    ...(mergedInput !== undefined ? { input: mergedInput } : {}),
    ...(payload.prompt === undefined && warmupPayload.prompt !== undefined ?
      { prompt: warmupPayload.prompt }
    : {}),
    ...((
      payload.conversation_id === undefined
      && warmupPayload.conversation_id !== undefined
    ) ?
      { conversation_id: warmupPayload.conversation_id }
    : {}),
    previous_response_id: undefined,
  }
}

function rehydrateSyntheticWarmupPayload(
  syntheticWarmups: Map<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ResponsesPayload | undefined {
  if (!payload.previous_response_id) {
    return undefined
  }

  const warmupPayload = syntheticWarmups.get(payload.previous_response_id)
  if (!warmupPayload) {
    return undefined
  }

  return rehydrateWarmupPayload(warmupPayload, payload)
}

function mergeWarmupInput(
  warmupInput: ResponsesPayload["input"],
  input: ResponsesPayload["input"],
): ResponsesPayload["input"] {
  if (Array.isArray(warmupInput) && Array.isArray(input)) {
    return [...warmupInput, ...input]
  }
  if (Array.isArray(warmupInput) && input === undefined) {
    return [...warmupInput]
  }
  if (Array.isArray(input)) {
    return [...input]
  }
  if (typeof input === "string") {
    return input.length > 0 ? input : warmupInput
  }
  return warmupInput
}

function handleSyntheticWarmupRequest(
  ws: { data: ResponsesWebSocketData; send(data: string): void },
  payload: ResponsesPayload,
): void {
  const responseId = `warmup_${randomUUID().replaceAll("-", "")}`
  ws.data.syntheticWarmups.set(responseId, payload)

  const createdAt = Math.floor(Date.now() / 1000)
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model: payload.model,
    output: [],
    output_text: "",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    metadata: payload.metadata ?? null,
    parallel_tool_calls: payload.parallel_tool_calls ?? false,
    temperature: payload.temperature ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: payload.tools ?? [],
    top_p: payload.top_p ?? null,
  }

  ws.send(
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: {
        ...baseResponse,
        status: "in_progress",
      },
    }),
  )

  ws.send(
    JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: {
        ...baseResponse,
        status: "completed",
      },
    }),
  )
}

async function streamChatCompletionsOverWs(
  ws: { send(data: string): void },
  payload: ResponsesPayload,
): Promise<void> {
  const ccPayload = responsesToChatCompletions(payload)
  ccPayload.stream = true
  ccPayload.stream_options = { include_usage: true }

  const response = await createChatCompletions(ccPayload)
  const ccStream = response as AsyncIterable<{ data?: string; event?: string }>

  // Reuse the CC→Responses streaming translator with a WebSocket-backed writer
  const wsStream = {
    // eslint-disable-next-line @typescript-eslint/require-await
    writeSSE: async (data: { event?: string; data: string }) => {
      ws.send(data.data)
    },
  }

  await streamChatCompletionsAsResponses(wsStream, ccStream, payload.model)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
