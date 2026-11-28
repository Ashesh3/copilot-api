import { randomUUID } from "node:crypto"

import {
  SSE_HEARTBEAT_COMMENT,
  SSE_HEARTBEAT_INTERVAL_MS,
} from "~/lib/sse-lifecycle"

import { runWithInterceptWait, type StreamProtocol } from "./wait-signal"

const RESPONDED = Symbol("responded")

const SSE_HEADERS = {
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-type": "text/event-stream",
}

const encoder = new TextEncoder()

/**
 * Answer one inbound request. When its client expects an SSE response and the
 * request starts waiting on Intercept before `respond` settles, return a 200
 * SSE response at once and send heartbeats until `respond` settles, then
 * stream its body, or its error as the protocol's in-stream error. `respond`
 * runs to the end first, model fallback retries included, so nothing but
 * heartbeats is committed while the operator decides. It wraps the whole app
 * so the app's own context never sees the early response.
 */
export async function respondWithInterceptKeepalive(
  respond: () => Promise<Response>,
): Promise<Response> {
  const { wait, result: response } = runWithInterceptWait(respond)
  const first = await Promise.race([
    response.then(
      () => RESPONDED,
      () => RESPONDED,
    ),
    wait.started,
  ])
  if (first === RESPONDED || !wait.protocol) return await response
  return keepAliveUntil(wait.protocol, response)
}

function keepAliveUntil(
  protocol: StreamProtocol,
  pending: Promise<Response>,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  // A client that left fails the write; its request signal ends the work.
  const beat = () => {
    writer.write(encoder.encode(SSE_HEARTBEAT_COMMENT)).catch(() => undefined)
  }
  beat()
  const timer = setInterval(beat, SSE_HEARTBEAT_INTERVAL_MS)
  void pending
    .catch(() => undefined)
    .then(async (response) => {
      clearInterval(timer)
      await deliver({ protocol, response, writer, writable })
    })
  return new Response(readable, { headers: SSE_HEADERS })
}

async function deliver(options: {
  protocol: StreamProtocol
  response: Response | undefined
  writer: WritableStreamDefaultWriter<Uint8Array>
  writable: WritableStream<Uint8Array>
}): Promise<void> {
  const { response, writer } = options
  if (response?.ok && isEventStream(response) && response.body) {
    writer.releaseLock()
    // Closes with the body; a client that leaves cancels the body too.
    await response.body.pipeTo(options.writable).catch(() => undefined)
    return
  }
  const failure = await readFailure(response)
  try {
    await writer.write(encoder.encode(errorEvent(options.protocol, failure)))
    await writer.close()
  } catch {
    // The client already left.
  }
}

/** What a non-stream answer says; a successful one is discarded. */
async function readFailure(
  response: Response | undefined,
): Promise<RouteFailure> {
  if (!response) {
    return { status: 500, text: "", fallback: "The request failed" }
  }
  if (response.ok) {
    void response.body?.cancel().catch(() => undefined)
    return {
      status: response.status,
      text: "",
      fallback: "The gateway did not return a stream",
    }
  }
  return {
    status: response.status,
    text: await response.text().catch(() => ""),
    fallback: `The request failed with status ${response.status}`,
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value ? value : undefined
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

interface RouteFailure {
  status: number
  /** The body the route answered with. */
  text: string
  /** The message when the body carries none. */
  fallback: string
}

/** The error a route answered with, framed as its protocol's stream error. */
function errorEvent(protocol: StreamProtocol, failure: RouteFailure): string {
  const body = parseJson(failure.text)
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
  const message =
    stringField(error, "message") ?? (failure.text.trim() || failure.fallback)
  if (protocol === "messages") {
    return sseEvent(
      "error",
      isRecord(body) && body.type === "error" && error ?
        body
      : { type: "error", error: { type: "api_error", message } },
    )
  }
  if (protocol === "chat") {
    const data = error ? body : { error: { message, type: "api_error" } }
    return `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`
  }
  if (protocol === "google") {
    const data =
      error ? body : (
        { error: { code: failure.status, message, status: "INTERNAL" } }
      )
    return `data: ${JSON.stringify(data)}\n\n`
  }
  return sseEvent("response.failed", {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_${randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code:
          stringField(error, "code")
          ?? stringField(error, "type")
          ?? "server_error",
        message,
      },
      incomplete_details: null,
    },
  })
}
