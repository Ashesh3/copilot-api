import type { Context } from "hono"

import type {
  StreamTerminalFailure,
  StreamTerminalLifecycle,
} from "~/lib/stream-terminal-lifecycle"

import { reportHttpError } from "~/lib/error"
import { createStreamTerminalLifecycle } from "~/lib/stream-terminal-lifecycle"

import type {
  AnthropicErrorEvent,
  AnthropicStreamEventData,
} from "./anthropic-types"

import { createAnthropicStreamError } from "./error"

export interface AnthropicSseWriter {
  readonly aborted: boolean
  readonly closed: boolean
  writeSSE: (data: { data: string; event?: string }) => Promise<void>
}

export interface MessagesTerminalAdapter {
  readonly lifecycle: StreamTerminalLifecycle<undefined>
  succeed(writeNormalTerminal: () => Promise<void>): Promise<boolean>
  fail(failure: StreamTerminalFailure): Promise<boolean>
  failReceived(error: AnthropicErrorEvent): Promise<boolean>
  finishSource(): Promise<boolean>
  abort(): boolean
}

export function createMessagesTerminalAdapter(options: {
  c: Context
  stream: AnthropicSseWriter
  closeOpenBlocks: () => Array<AnthropicStreamEventData>
}): MessagesTerminalAdapter {
  let receivedError: AnthropicErrorEvent | undefined
  let normalTerminal: (() => Promise<void>) | undefined
  const lifecycle = createStreamTerminalLifecycle<undefined>({
    isDownstreamAborted: () => options.stream.aborted || options.stream.closed,
    onSuccess: async () => {
      await normalTerminal?.()
    },
    onFailure: async (failure) => {
      await writeEvents(options.stream, options.closeOpenBlocks())
      await writeEvent(
        options.stream,
        receivedError ?? createMessagesStreamFailure(failure),
      )
      if (failure.kind === "thrown" && failure.inspection) {
        reportHttpError(options.c, failure.inspection)
      }
    },
  })

  return {
    lifecycle,
    async succeed(writeNormalTerminal) {
      normalTerminal = writeNormalTerminal
      return await lifecycle.succeed(undefined)
    },
    fail: async (failure) => await lifecycle.fail(failure),
    async failReceived(error) {
      if (lifecycle.state !== "open") return false
      receivedError = error
      return await lifecycle.fail({ kind: "thrown", error })
    },
    finishSource: async () => await lifecycle.finishSource(),
    abort: () => lifecycle.abort(),
  }
}

export async function writeAnthropicEvents(
  stream: AnthropicSseWriter,
  events: Array<AnthropicStreamEventData>,
): Promise<void> {
  await writeEvents(stream, events)
}

function createMessagesStreamFailure(
  failure: StreamTerminalFailure,
): AnthropicErrorEvent {
  if (failure.kind === "thrown" && failure.inspection?.kind === "upstream") {
    const inspection = failure.inspection
    return {
      type: "error",
      error: {
        type: "api_error",
        message: inspection.bodyText ?? "The Copilot Messages request failed.",
        ...(inspection.bodyText === undefined ?
          { body_bytes: Array.from(inspection.bodyBytes) }
        : {}),
        ...(inspection.contentType ?
          { content_type: inspection.contentType }
        : {}),
        status: inspection.status,
      },
    }
  }
  return createAnthropicStreamError(
    failure.kind === "thrown" ? failure.error : undefined,
  )
}

async function writeEvents(
  stream: AnthropicSseWriter,
  events: Array<AnthropicStreamEventData>,
): Promise<void> {
  for (const event of events) await writeEvent(stream, event)
}

async function writeEvent(
  stream: AnthropicSseWriter,
  event: AnthropicStreamEventData,
): Promise<void> {
  await stream.writeSSE({
    event: event.type,
    data: JSON.stringify(event),
  })
}
