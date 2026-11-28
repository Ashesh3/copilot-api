import { randomUUID } from "node:crypto"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import type { ResponsesResult } from "~/services/copilot/create-responses"

import { HTTPError, inspectHttpError } from "~/lib/error"
import {
  isHeartbeatDisabled,
  SSE_HEARTBEAT_COMMENT,
  SSE_HEARTBEAT_INTERVAL_MS,
} from "~/lib/sse-lifecycle"
import {
  emitAnthropicResponseAsStream,
  emitChatCompletionResponseAsStream,
  emitResponsesResultAsStream,
} from "~/routes/messages/web-search-helpers"
import { emitResponsesFailureAsStream } from "~/routes/responses/stream-lifecycle"

import {
  type InterceptWait,
  runWithInterceptWait,
  type StreamingClient,
  type StreamProtocol,
} from "./wait-signal"

const RESPONDED = Symbol("responded")

const encoder = new TextEncoder()

interface SseEvent {
  event?: string
  data: string
}

interface SseWriter {
  readonly aborted: boolean
  readonly closed: boolean
  writeSSE: (message: SseEvent) => Promise<void>
}

/**
 * Answer one inbound request. When its client expects an SSE response and the
 * request starts waiting on Intercept before `respond` settles, return a 200
 * SSE response at once and send heartbeats until `respond` settles, then
 * stream its reply in the client's protocol. `respond` runs to the end first,
 * model fallback retries included, so nothing but heartbeats is committed
 * while the operator decides. It wraps the whole app so the app's own context
 * never sees the early response; `decorate` adds the headers the app would
 * have added to it. The heartbeat kill switch turns the early response off.
 */
export async function respondWithInterceptKeepalive(options: {
  respond: () => Promise<Response>
  decorate: (headers: Headers) => void
}): Promise<Response> {
  if (isHeartbeatDisabled()) return await options.respond()
  const { wait, result: response } = runWithInterceptWait(options.respond)
  const first = await Promise.race([
    response.then(
      () => RESPONDED,
      () => RESPONDED,
    ),
    wait.started,
  ])
  const { client } = wait
  if (first === RESPONDED || !client) return await response
  const headers = new Headers({
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })
  if (client.requestId) headers.set("x-request-id", client.requestId)
  options.decorate(headers)
  return new Response(keepAliveUntil({ wait, client, pending: response }), {
    headers,
  })
}

function keepAliveUntil(options: {
  wait: InterceptWait
  client: StreamingClient
  pending: Promise<Response>
}): ReadableStream<Uint8Array> {
  const { wait } = options
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  let delivering = false
  const beat = () => {
    writer.write(encoder.encode(SSE_HEARTBEAT_COMMENT)).catch(() => undefined)
  }
  beat()
  const timer = setInterval(beat, SSE_HEARTBEAT_INTERVAL_MS)
  // A cancelled response errors the writable side: release what the request
  // still waits on, so a held item drops instead of going upstream later.
  writer.closed.catch(() => {
    if (delivering) return
    clearInterval(timer)
    wait.cancel.abort()
  })
  void options.pending
    .catch(() => undefined)
    .then(async (response) => {
      clearInterval(timer)
      if (wait.cancel.signal.aborted) {
        void response?.body?.cancel().catch(() => undefined)
        return
      }
      delivering = true
      await deliver({ client: options.client, response, writer, writable })
    })
  return readable
}

async function deliver(options: {
  client: StreamingClient
  response: Response | undefined
  writer: WritableStreamDefaultWriter<Uint8Array>
  writable: WritableStream<Uint8Array>
}): Promise<void> {
  const { client, response, writer } = options
  if (response?.ok && isEventStream(response) && response.body) {
    writer.releaseLock()
    // Closes with the body; a client that leaves cancels the body too.
    await response.body.pipeTo(options.writable).catch(() => undefined)
    return
  }
  const sse: SseWriter = {
    aborted: false,
    closed: false,
    writeSSE: async ({ event, data }) => {
      const prefix = event ? `event: ${event}\n` : ""
      await writer.write(encoder.encode(`${prefix}data: ${data}\n\n`))
    },
  }
  try {
    await (response?.ok ?
      writeCompleted(client, response, sse)
    : writeFailure(client, response, sse))
    await writer.close()
  } catch {
    // The client already left.
  }
}

function isEventStream(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") ?? false
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A complete non-stream reply (a provider that ignored `stream`), as a stream. */
async function writeCompleted(
  client: StreamingClient,
  response: Response,
  sse: SseWriter,
): Promise<void> {
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body)) {
    await writeFailure(client, undefined, sse)
    return
  }
  switch (client.protocol) {
    case "chat": {
      await emitChatCompletionResponseAsStream(
        sse,
        body as unknown as ChatCompletionResponse,
        { writeDone: true },
      )

      break
    }
    case "messages": {
      await emitAnthropicResponseAsStream(sse, body as AnthropicResponse)

      break
    }
    case "responses": {
      await emitResponsesResultAsStream(sse, body as unknown as ResponsesResult)

      break
    }
    default: {
      // A Google stream chunk is a complete GenerateContentResponse.
      await sse.writeSSE({ data: JSON.stringify(body) })
    }
  }
}

/** The app's error reply as the protocol's in-stream failure. */
async function writeFailure(
  client: StreamingClient,
  response: Response | undefined,
  sse: SseWriter,
): Promise<void> {
  if (client.protocol === "responses") {
    // Classified like any other Responses stream failure, retry-after kept.
    await emitResponsesFailureAsStream(sse, {
      responseId: `resp_${randomUUID().replaceAll("-", "")}`,
      model: client.model ?? "unknown",
      inspection:
        response ?
          await inspectHttpError(new HTTPError("Request failed", response))
        : undefined,
    })
    return
  }
  const status = response?.status ?? 500
  const text = response ? await response.text().catch(() => "") : ""
  for (const event of errorEvents(client.protocol, status, text)) {
    await sse.writeSSE(event)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The error body a route answered with, framed as its stream error. */
function errorEvents(
  protocol: Exclude<StreamProtocol, "responses">,
  status: number,
  text: string,
): Array<SseEvent> {
  const body = parseJson(text)
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
  const message =
    (typeof error?.message === "string" && error.message)
    || text.trim()
    || `The request failed with status ${status}`
  if (protocol === "messages") {
    const data =
      isRecord(body) && body.type === "error" && error ?
        body
      : { type: "error", error: { type: "api_error", message } }
    return [{ event: "error", data: JSON.stringify(data) }]
  }
  if (protocol === "chat") {
    const data = error ? body : { error: { message, type: "api_error" } }
    return [{ data: JSON.stringify(data) }, { data: "[DONE]" }]
  }
  // Google's envelope: a numeric code and a status name, whatever the app sent.
  const googleShaped =
    typeof error?.code === "number" && typeof error.status === "string"
  const data =
    googleShaped ? body : (
      { error: { code: status, message, status: googleStatus(status) } }
    )
  return [{ data: JSON.stringify(data) }]
}

const GOOGLE_STATUSES: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
}

function googleStatus(status: number): string {
  return (
    GOOGLE_STATUSES[status]
    ?? (status < 500 ? "FAILED_PRECONDITION" : "INTERNAL")
  )
}
