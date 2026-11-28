import { AsyncLocalStorage } from "node:async_hooks"

import { getRequestId } from "~/lib/request-session"

/** The client's wire protocol, which decides how a late reply is framed. */
export type StreamProtocol = "chat" | "messages" | "responses" | "google"

/** What the route reported about its client once it parsed the request. */
export interface StreamingClient {
  protocol: StreamProtocol
  /** The requested model, which a Responses failure envelope names. */
  model?: string
  requestId?: string
}

/**
 * Per inbound request: whether its client expects an SSE response, and
 * whether the request has started waiting on Intercept (a held request, or a
 * response read for review). A streaming request that waits gets its SSE
 * response opened early and kept alive with heartbeats, instead of a silence
 * that clients and proxies in front of the gateway treat as a dead connection.
 */
export interface InterceptWait {
  readonly started: Promise<undefined>
  /** Aborted when the client cancels the early response. */
  readonly cancel: AbortController
  client?: StreamingClient
}

interface InterceptWaitState extends InterceptWait {
  readonly start: () => void
}

const waitStorage = new AsyncLocalStorage<InterceptWaitState>()

/** Run one inbound request with its own wait signal. */
export function runWithInterceptWait<T>(work: () => T): {
  wait: InterceptWait
  result: T
} {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  const wait: InterceptWaitState = {
    started: promise,
    cancel: new AbortController(),
    start: () => {
      resolve(undefined)
    },
  }
  return { wait, result: waitStorage.run(wait, work) }
}

/** The client of the current request expects an SSE response. */
export function markStreamingClient(
  protocol: StreamProtocol,
  model?: string,
): void {
  const wait = waitStorage.getStore()
  if (wait) wait.client = { protocol, model, requestId: getRequestId() }
}

/** The current request has started waiting on Intercept. */
export function signalInterceptWait(): void {
  waitStorage.getStore()?.start()
}

/** Aborted once the client of the current request cancels its early stream. */
export function interceptWaitCancelSignal(): AbortSignal | undefined {
  return waitStorage.getStore()?.cancel.signal
}
