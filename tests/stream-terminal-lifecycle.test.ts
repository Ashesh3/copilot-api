import { describe, expect, test } from "bun:test"

import {
  HTTPError,
  inspectHttpError,
  type HttpErrorInspection,
} from "~/lib/error"
import {
  createStreamTerminalLifecycle,
  type StreamTerminalFailure,
} from "~/lib/stream-terminal-lifecycle"

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      resolvePromise?.()
    },
  }
}

describe("createStreamTerminalLifecycle", () => {
  test("commits one normal success and ignores source completion", async () => {
    const successes: Array<{ id: string }> = []
    const failures: Array<StreamTerminalFailure> = []
    const lifecycle = createStreamTerminalLifecycle({
      onSuccess(success: { id: string }) {
        successes.push(success)
      },
      onFailure(failure) {
        failures.push(failure)
      },
    })

    expect(await lifecycle.succeed({ id: "terminal" })).toBe(true)
    expect(lifecycle.state).toBe("succeeded")
    expect(successes).toEqual([{ id: "terminal" }])
    expect(await lifecycle.finishSource()).toBe(false)
    expect(failures).toEqual([])
  })

  test("commits success before its callback settles so competing terminals lose", async () => {
    const deferred = createDeferred()
    const successes: Array<string> = []
    const failures: Array<StreamTerminalFailure> = []
    const lifecycle = createStreamTerminalLifecycle({
      async onSuccess(success: string) {
        successes.push(success)
        await deferred.promise
      },
      onFailure(failure) {
        failures.push(failure)
      },
    })

    const winning = lifecycle.succeed("success")
    expect(lifecycle.state).toBe("succeeded")
    expect(await lifecycle.succeed("second-success")).toBe(false)
    expect(
      await lifecycle.fail({ kind: "thrown", error: new Error("late") }),
    ).toBe(false)
    expect(await lifecycle.finishSource()).toBe(false)
    expect(successes).toEqual(["success"])
    expect(failures).toEqual([])

    deferred.resolve()
    expect(await winning).toBe(true)
  })

  test("commits failure before its callback settles so competing terminals lose", async () => {
    const deferred = createDeferred()
    const successes: Array<string> = []
    const failures: Array<StreamTerminalFailure> = []
    const lifecycle = createStreamTerminalLifecycle({
      onSuccess(success: string) {
        successes.push(success)
      },
      async onFailure(failure) {
        failures.push(failure)
        await deferred.promise
      },
    })
    const failure = { kind: "thrown" as const, error: new Error("first") }

    const winning = lifecycle.fail(failure)
    expect(lifecycle.state).toBe("failed")
    expect(await lifecycle.fail({ kind: "source_ended" })).toBe(false)
    expect(await lifecycle.succeed("late-success")).toBe(false)
    expect(await lifecycle.finishSource()).toBe(false)
    expect(successes).toEqual([])
    expect(failures).toEqual([failure])

    deferred.resolve()
    expect(await winning).toBe(true)
  })

  test("turns an open source EOF into the source-ended failure", async () => {
    const failures: Array<StreamTerminalFailure> = []
    const lifecycle = createStreamTerminalLifecycle({
      onSuccess() {},
      onFailure(failure) {
        failures.push(failure)
      },
    })

    expect(await lifecycle.finishSource()).toBe(true)
    expect(lifecycle.state).toBe("failed")
    expect(failures).toEqual([{ kind: "source_ended" }])
    expect(
      await lifecycle.fail({ kind: "thrown", error: new Error("late") }),
    ).toBe(false)
    expect(await lifecycle.succeed(undefined)).toBe(false)
  })

  test("aborts synchronously and suppresses every later terminal callback", async () => {
    const callbacks: Array<string> = []
    const lifecycle = createStreamTerminalLifecycle({
      onSuccess() {
        callbacks.push("success")
      },
      onFailure() {
        callbacks.push("failure")
      },
    })

    expect(lifecycle.abort()).toBe(true)
    expect(lifecycle.state).toBe("aborted")
    expect(lifecycle.abort()).toBe(false)
    expect(await lifecycle.succeed(undefined)).toBe(false)
    expect(await lifecycle.fail({ kind: "source_ended" })).toBe(false)
    expect(await lifecycle.finishSource()).toBe(false)
    expect(callbacks).toEqual([])
  })

  test("uses a downstream-aborted predicate to abort terminal attempts without writing", async () => {
    let downstreamAborted = false
    const callbacks: Array<string> = []
    const makeLifecycle = () =>
      createStreamTerminalLifecycle({
        isDownstreamAborted: () => downstreamAborted,
        onSuccess() {
          callbacks.push("success")
        },
        onFailure() {
          callbacks.push("failure")
        },
      })

    for (const attempt of [
      (lifecycle: ReturnType<typeof makeLifecycle>) =>
        lifecycle.succeed(undefined),
      (lifecycle: ReturnType<typeof makeLifecycle>) =>
        lifecycle.fail({ kind: "source_ended" }),
      (lifecycle: ReturnType<typeof makeLifecycle>) => lifecycle.finishSource(),
    ]) {
      const lifecycle = makeLifecycle()
      downstreamAborted = true
      expect(await attempt(lifecycle)).toBe(false)
      expect(lifecycle.state).toBe("aborted")
      downstreamAborted = false
    }

    expect(callbacks).toEqual([])
  })

  test("hands an existing raw HTTP inspection to the failure callback unchanged", async () => {
    const bodyText = `  upstream failure
`
    const error = new HTTPError(
      "Request rejected",
      new Response(bodyText, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    )
    const inspection = await inspectHttpError(error)
    let received: HttpErrorInspection | undefined
    const lifecycle = createStreamTerminalLifecycle({
      onSuccess() {},
      onFailure(failure) {
        received = failure.inspection
      },
    })

    expect(await lifecycle.fail({ kind: "thrown", error, inspection })).toBe(
      true,
    )
    expect(received).toBe(inspection)
    expect(received?.kind).toBe("upstream")
    if (received?.kind !== "upstream")
      throw new Error("Expected upstream inspection")
    expect(Array.from(received.bodyBytes)).toEqual(
      Array.from(new TextEncoder().encode(bodyText)),
    )
    expect(received.bodyText).toBe(bodyText)
    expect(received.contentType).toBe("text/plain; charset=utf-8")
  })

  test("preserves a rejected callback's committed failure without writing success", async () => {
    const rejection = new Error("sink closed")
    const successes: Array<string> = []
    const lifecycle = createStreamTerminalLifecycle({
      onSuccess(success: string) {
        successes.push(success)
      },
      onFailure() {
        return Promise.reject(rejection)
      },
    })

    let caught: unknown
    try {
      await lifecycle.fail({ kind: "source_ended" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(rejection)
    expect(lifecycle.state).toBe("failed")
    expect(await lifecycle.succeed("late")).toBe(false)
    expect(successes).toEqual([])
  })
})
