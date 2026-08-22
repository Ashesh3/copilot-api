import type { HttpErrorInspection } from "~/lib/error"

export type StreamTerminalState = "open" | "succeeded" | "failed" | "aborted"

export type StreamTerminalFailure =
  | {
      readonly kind: "source_ended"
      readonly error?: undefined
      readonly inspection?: undefined
    }
  | {
      readonly kind: "thrown"
      readonly error: unknown
      readonly inspection?: HttpErrorInspection
    }

export interface StreamTerminalLifecycleOptions<Success> {
  readonly onSuccess: (success: Success) => void | Promise<void>
  readonly onFailure: (failure: StreamTerminalFailure) => void | Promise<void>
  readonly isDownstreamAborted?: () => boolean
}

export interface StreamTerminalLifecycle<Success> {
  readonly state: StreamTerminalState
  succeed(success: Success): Promise<boolean>
  fail(failure: StreamTerminalFailure): Promise<boolean>
  abort(): boolean
  finishSource(): Promise<boolean>
}

export function createStreamTerminalLifecycle<Success>(
  options: StreamTerminalLifecycleOptions<Success>,
): StreamTerminalLifecycle<Success> {
  let state: StreamTerminalState = "open"

  const transition = (next: Exclude<StreamTerminalState, "open">): boolean => {
    if (state !== "open") return false
    if (options.isDownstreamAborted?.()) {
      state = "aborted"
      return false
    }
    state = next
    return true
  }

  return {
    get state() {
      return state
    },
    async succeed(success) {
      if (!transition("succeeded")) return false
      await options.onSuccess(success)
      return true
    },
    async fail(failure) {
      if (!transition("failed")) return false
      await options.onFailure(failure)
      return true
    },
    abort() {
      if (state !== "open") return false
      state = "aborted"
      return true
    },
    async finishSource() {
      return await this.fail({ kind: "source_ended" })
    },
  }
}
