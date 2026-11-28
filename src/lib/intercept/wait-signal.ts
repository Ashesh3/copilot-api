import { AsyncLocalStorage } from "node:async_hooks"

/** The client's wire protocol, which decides how a late error is framed. */
export type StreamProtocol = "chat" | "messages" | "responses" | "google"

/**
 * Per inbound request: whether its client expects an SSE response, and
 * whether the request has started waiting on Intercept (a held request, or a
 * response read for review). A streaming request that waits gets its SSE
 * response opened early and kept alive with heartbeats, instead of a silence
 * that clients and proxies in front of the gateway treat as a dead connection.
 */
export interface InterceptWait {
  readonly started: Promise<undefined>
  /** Set by the route once it parsed a request that expects an SSE response. */
  protocol?: StreamProtocol
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
    start: () => {
      resolve(undefined)
    },
  }
  return { wait, result: waitStorage.run(wait, work) }
}

/** The client of the current request expects an SSE response. */
export function markStreamingClient(protocol: StreamProtocol): void {
  const wait = waitStorage.getStore()
  if (wait) wait.protocol = protocol
}

/** The current request has started waiting on Intercept. */
export function signalInterceptWait(): void {
  waitStorage.getStore()?.start()
}
