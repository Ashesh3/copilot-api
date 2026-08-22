import type { Context } from "hono"

import type {
  StreamTerminalFailure,
  StreamTerminalLifecycle,
} from "~/lib/stream-terminal-lifecycle"

import { reportHttpError } from "~/lib/error"
import { createStreamTerminalLifecycle } from "~/lib/stream-terminal-lifecycle"

export interface ChatSseWriter {
  readonly aborted: boolean
  readonly closed: boolean
  writeSSE: (data: { data: string; event?: string }) => Promise<void>
}

export interface ChatStreamTerminalState {
  doneWritten: boolean
  receivedFailure?: unknown
}

export interface ChatStreamTerminalAdapter {
  readonly lifecycle: StreamTerminalLifecycle<undefined>
  readonly state: Readonly<ChatStreamTerminalState>
  succeedAfterFinalChunk(): Promise<boolean>
  failAfterCommit(failure: StreamTerminalFailure): Promise<boolean>
  failReceived(receivedFailure: unknown): Promise<boolean>
  finishSource(): Promise<boolean>
  abort(): boolean
}

export function createChatStreamTerminalAdapter(options: {
  c: Context
  stream: ChatSseWriter
}): ChatStreamTerminalAdapter {
  const state: ChatStreamTerminalState = { doneWritten: false }
  const writeDoneOnce = async (): Promise<void> => {
    if (state.doneWritten) return
    state.doneWritten = true
    await options.stream.writeSSE({ data: "[DONE]" })
  }
  const lifecycle = createStreamTerminalLifecycle<undefined>({
    isDownstreamAborted: () => options.stream.aborted || options.stream.closed,
    onSuccess: writeDoneOnce,
    onFailure: async (failure) => {
      await options.stream.writeSSE({
        data: JSON.stringify(
          state.receivedFailure === undefined ?
            createChatStreamFailure(failure)
          : { error: state.receivedFailure },
        ),
      })
      await writeDoneOnce()
      if (failure.kind === "thrown" && failure.inspection) {
        reportHttpError(options.c, failure.inspection)
      }
    },
  })

  return {
    lifecycle,
    state,
    succeedAfterFinalChunk: async () => await lifecycle.succeed(undefined),
    failAfterCommit: async (failure) => await lifecycle.fail(failure),
    async failReceived(receivedFailure) {
      if (lifecycle.state !== "open") return false
      state.receivedFailure = receivedFailure
      return await lifecycle.fail({
        kind: "thrown",
        error: receivedFailure,
      })
    },
    finishSource: async () => await lifecycle.finishSource(),
    abort: () => lifecycle.abort(),
  }
}

function createChatStreamFailure(failure: StreamTerminalFailure): {
  error: {
    content_type?: string
    message: string | Array<number>
    status?: number
    type: "api_error"
  }
} {
  if (failure.kind === "thrown" && failure.inspection?.kind === "upstream") {
    const inspection = failure.inspection
    return {
      error: {
        message: inspection.bodyText ?? Array.from(inspection.bodyBytes),
        type: "api_error",
        ...(inspection.contentType ?
          { content_type: inspection.contentType }
        : {}),
        status: inspection.status,
      },
    }
  }
  return {
    error: {
      message: "An unexpected error occurred during streaming.",
      type: "api_error",
    },
  }
}
