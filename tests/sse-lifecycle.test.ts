import { describe, expect, test, beforeEach } from "bun:test"
import { events } from "fetch-event-stream"

import {
  getSseHeartbeatCount,
  resetSseHeartbeatCountForTest,
  SSE_HEARTBEAT_COMMENT,
  withHeartbeatWhilePending,
  withSseHeartbeat,
  type SseHeartbeatSink,
} from "~/lib/sse-lifecycle"

// These tests inject a small real `intervalMs` rather than faking the clock.
// `jest.useFakeTimers()` is available here via bun:test's jest-compat layer (see
// tests/llm-debug-log.test.ts), but hijacking the global clock alongside real
// async-iterator scheduling makes the race under test fragile — the helper's
// whole job is to interleave a timer with a genuinely pending promise.

const INTERVAL_MS = 10

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

interface RecordingSink extends SseHeartbeatSink {
  abort: () => void
  abortListeners: Set<() => void>
  writes: Array<string>
}

const createSink = (): RecordingSink => ({
  abortListeners: new Set(),
  writes: [],
  aborted: false,
  closed: false,
  abort() {
    this.aborted = true
    for (const listener of this.abortListeners) listener()
  },
  onAbort(listener: () => void) {
    this.abortListeners.add(listener)
  },
  write(input: string) {
    this.writes.push(input)
    return Promise.resolve()
  },
})

const heartbeatsIn = (sink: RecordingSink): Array<string> =>
  sink.writes.filter((entry) => entry === SSE_HEARTBEAT_COMMENT)

/** Yields `values`, pausing `gapMs` before each one. */
async function* pacedSource<T>(
  values: Array<T>,
  gapMs: number,
): AsyncGenerator<T> {
  for (const value of values) {
    await sleep(gapMs)
    yield value
  }
}

beforeEach(() => {
  resetSseHeartbeatCountForTest()
})

describe("withSseHeartbeat", () => {
  test("withSseHeartbeat writes nothing when chunks arrive faster than the interval", async () => {
    const sink = createSink()
    const received: Array<number> = []

    for await (const value of withSseHeartbeat(
      pacedSource([1, 2, 3, 4, 5], 1),
      sink,
      100,
    )) {
      received.push(value)
    }

    expect(received).toEqual([1, 2, 3, 4, 5])
    expect(heartbeatsIn(sink)).toEqual([])
    expect(getSseHeartbeatCount()).toBe(0)
  })

  test("withSseHeartbeat writes a keepalive comment when the source stalls past the interval", async () => {
    const sink = createSink()
    const received: Array<string> = []

    for await (const value of withSseHeartbeat(
      pacedSource(["only"], INTERVAL_MS * 6),
      sink,
      INTERVAL_MS,
    )) {
      received.push(value)
    }

    expect(received).toEqual(["only"])
    expect(heartbeatsIn(sink).length).toBeGreaterThanOrEqual(2)
    expect(sink.writes.every((entry) => entry === SSE_HEARTBEAT_COMMENT)).toBe(
      true,
    )
  })

  test("withSseHeartbeat stops heartbeating once the source completes", async () => {
    const sink = createSink()

    for await (const _ of withSseHeartbeat(
      pacedSource([1], INTERVAL_MS * 3),
      sink,
      INTERVAL_MS,
    )) {
      // drain
    }

    const afterCompletion = heartbeatsIn(sink).length
    await sleep(INTERVAL_MS * 4)

    expect(heartbeatsIn(sink).length).toBe(afterCompletion)
  })

  test("withSseHeartbeat writes no further heartbeats after completion", async () => {
    const sink = createSink()

    for await (const _ of withSseHeartbeat(
      pacedSource([1, 2], INTERVAL_MS * 2),
      sink,
      INTERVAL_MS,
    )) {
      // drain
    }

    const settled = sink.writes.length
    await sleep(INTERVAL_MS * 6)

    // A leaked timer would keep re-arming and writing into the closed sink.
    expect(sink.writes.length).toBe(settled)
  })

  test("withSseHeartbeat stops writing once the sink reports aborted", async () => {
    const sink = createSink()
    const iterable = withSseHeartbeat(
      pacedSource([1, 2, 3], INTERVAL_MS * 5),
      sink,
      INTERVAL_MS,
    )

    const first = await iterable.next()
    expect(first.value).toBe(1)

    sink.aborted = true
    const observed = heartbeatsIn(sink).length

    const next = await iterable.next()
    expect(next.done).toBe(true)
    expect(heartbeatsIn(sink).length).toBe(observed)
  })

  test("withSseHeartbeat propagates source errors unchanged", async () => {
    const sink = createSink()
    const boom = new Error("upstream exploded")

    async function* failing(): AsyncGenerator<number> {
      yield 1
      await sleep(1)
      throw boom
    }

    const received: Array<number> = []
    let caught: unknown

    try {
      for await (const value of withSseHeartbeat(
        failing(),
        sink,
        INTERVAL_MS,
      )) {
        received.push(value)
      }
    } catch (error) {
      caught = error
    }

    expect(received).toEqual([1])
    expect(caught).toBe(boom)
  })

  test("withSseHeartbeat calls iterator.return on early break", async () => {
    const sink = createSink()
    let returnCalls = 0

    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next: () => Promise.resolve({ done: false, value: (index += 1) }),
          return: () => {
            returnCalls += 1
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }

    for await (const _ of withSseHeartbeat(source, sink, INTERVAL_MS)) {
      break
    }

    expect(returnCalls).toBe(1)
  })

  test("withSseHeartbeat does not leave an unhandled rejection when the sink is already aborted", async () => {
    const sink = createSink()
    sink.aborted = true

    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    try {
      // The first `next()` is dispatched before the loop is entered, so an
      // already-aborted sink skips the loop and nothing ever races it.
      const source: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject(new Error("upstream died during teardown")),
        }),
      }

      const received: Array<number> = []
      for await (const value of withSseHeartbeat(source, sink, INTERVAL_MS)) {
        received.push(value)
      }

      expect(received).toEqual([])

      // Give the microtask queue and the rejection check a chance to run.
      await sleep(INTERVAL_MS * 2)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("withSseHeartbeat settles promptly when a stalled response body is aborted", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const sink = createSink()
    const iterator = withSseHeartbeat(events(response), sink, INTERVAL_MS)[
      Symbol.asyncIterator
    ]()
    const pending = iterator.next()

    setTimeout(() => sink.abort(), INTERVAL_MS * 2)
    const outcome = await Promise.race([
      pending.then(() => "settled"),
      sleep(INTERVAL_MS * 15).then(() => "timed-out"),
    ])

    bodyController?.close()
    await pending
    expect(outcome).toBe("settled")
  })
})

describe("withHeartbeatWhilePending", () => {
  test("withHeartbeatWhilePending resolves without heartbeating when the promise settles fast", async () => {
    const sink = createSink()

    const result = await withHeartbeatWhilePending(
      Promise.resolve("fast"),
      sink,
      100,
    )

    expect(result).toBe("fast")
    expect(heartbeatsIn(sink)).toEqual([])
  })

  test("withHeartbeatWhilePending writes heartbeats while pending and stops once settled", async () => {
    const sink = createSink()

    const result = await withHeartbeatWhilePending(
      sleep(INTERVAL_MS * 6).then(() => "slow"),
      sink,
      INTERVAL_MS,
    )

    expect(result).toBe("slow")
    const settled = heartbeatsIn(sink).length
    expect(settled).toBeGreaterThanOrEqual(2)

    await sleep(INTERVAL_MS * 4)
    expect(heartbeatsIn(sink).length).toBe(settled)
  })

  test("withHeartbeatWhilePending rejects with the original error and stops heartbeating", async () => {
    const sink = createSink()
    const boom = new Error("pending exploded")

    let caught: unknown
    try {
      await withHeartbeatWhilePending(
        sleep(INTERVAL_MS * 4).then(() => {
          throw boom
        }),
        sink,
        INTERVAL_MS,
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(boom)
    const settled = heartbeatsIn(sink).length

    await sleep(INTERVAL_MS * 4)
    expect(heartbeatsIn(sink).length).toBe(settled)
  })

  test("withHeartbeatWhilePending rejects promptly when the sink aborts", async () => {
    const sink = createSink()
    const never = new Promise<string>(() => {})
    const pending = withHeartbeatWhilePending(never, sink, INTERVAL_MS).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error && error.name === "AbortError" ?
          "aborted"
        : "wrong-error",
    )

    setTimeout(() => sink.abort(), INTERVAL_MS * 2)
    const outcome = await Promise.race([
      pending,
      sleep(INTERVAL_MS * 15).then(() => "timed-out"),
    ])

    expect(outcome).toBe("aborted")
  })
})
