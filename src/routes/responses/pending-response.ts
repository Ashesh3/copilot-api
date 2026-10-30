import { randomUUID } from "node:crypto"

import type { SseHeartbeatSink } from "~/lib/sse-lifecycle"
import type { ResponsesResult } from "~/services/copilot/create-responses"

import {
  SSE_HEARTBEAT_INTERVAL_MS,
  withProgressWhilePending,
} from "~/lib/sse-lifecycle"
import { emitResponsesResultAsStream } from "~/routes/messages/web-search-helpers"

import type { ResponsesStreamFailureState } from "./stream-lifecycle"

interface ResponsesEventSink extends SseHeartbeatSink {
  writeSSE: (data: { event?: string; data: string }) => Promise<void>
}

/** `response.in_progress` with no response: a no-op that keeps a turn alive. */
export const RESPONSE_PROGRESS_FRAME = JSON.stringify({
  type: "response.in_progress",
})

let progressIntervalMs = SSE_HEARTBEAT_INTERVAL_MS

export function getResponseProgressIntervalMs(): number {
  return progressIntervalMs
}

export function setResponseProgressIntervalForTest(
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
): void {
  progressIntervalMs = intervalMs
}

/**
 * Keeps a Responses client waiting for a buffered upstream call.
 *
 * Codex abandons a stream after five minutes without an event and resends
 * the turn, which restarts the upstream call. SSE comment heartbeats keep
 * proxies open but do not count as events. Once the result is late, the
 * response is announced with `response.created` and `response.in_progress`
 * follows at each interval; the result then continues that response.
 */
export class PendingResponseProgress {
  private announced = false
  private readonly state: ResponsesStreamFailureState
  private readonly stream: ResponsesEventSink

  constructor(stream: ResponsesEventSink, state: ResponsesStreamFailureState) {
    this.stream = stream
    this.state = state
  }

  /** Send `response.created` for the response the result will complete. */
  async announce(): Promise<void> {
    if (this.announced) return
    this.announced = true
    this.state.responseId = `resp_${randomUUID().replaceAll("-", "")}`
    this.state.createdAt = Math.floor(Date.now() / 1000)
    await this.write("response.created")
  }

  /** Await the result, announcing the response and reporting progress. */
  async wait<T>(pending: Promise<T>): Promise<T> {
    return await withProgressWhilePending(pending, this.stream, {
      intervalMs: progressIntervalMs,
      beat: async () => {
        await (this.announced ?
          this.write("response.in_progress")
        : this.announce())
      },
    })
  }

  /** Send the result, as the announced response when there is one. */
  async emit(result: ResponsesResult): Promise<void> {
    if (!this.announced) {
      await emitResponsesResultAsStream(this.stream, result)
      return
    }
    await emitResponsesResultAsStream(
      this.stream,
      {
        ...result,
        id: this.state.responseId,
        created_at: this.state.createdAt,
      },
      { announced: true, sequenceNumber: this.state.sequenceNumber },
    )
  }

  private async write(
    type: "response.created" | "response.in_progress",
  ): Promise<void> {
    if (this.stream.aborted || this.stream.closed) return
    const data = JSON.stringify({
      type,
      sequence_number: this.state.sequenceNumber++,
      response: {
        id: this.state.responseId,
        object: "response",
        created_at: this.state.createdAt,
        model: this.state.model,
        status: "in_progress",
        output: [],
        error: null,
        incomplete_details: null,
        usage: null,
      },
    })
    try {
      await this.stream.writeSSE({ event: type, data })
    } catch {
      // Like a heartbeat, progress is best-effort on a socket that is closing.
    }
  }
}
