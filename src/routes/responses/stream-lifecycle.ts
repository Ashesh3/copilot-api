import type { Context } from "hono"

import type { HttpErrorInspection } from "~/lib/error"
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponseUsage,
} from "~/services/copilot/create-responses"

import { isHTTPError, reportHttpError } from "~/lib/error"
import { createStreamTerminalLifecycle } from "~/lib/stream-terminal-lifecycle"
import {
  readContextOverflow,
  readContextOverflowText,
} from "~/services/copilot/context-overflow"

export type ResponsesTerminalKind =
  | "response.completed"
  | "response.incomplete"
  | "response.failed"
  | "error"

export type ResponsesTerminalSuccess =
  | "response.completed"
  | "response.incomplete"
  | "synthetic"

export interface ResponsesStreamChunk {
  readonly id?: string | number
  readonly event?: string
  readonly data?: string
}

export interface ResponsesStreamFailureState {
  responseId: string
  model: string
  createdAt: number
  sequenceNumber: number
  outputText: string
  output: Array<ResponseOutputItem>
  usage: ResponseUsage | null
}

export interface ResponsesStreamWriter {
  readonly aborted: boolean
  readonly closed: boolean
  writeSSE: (data: { event?: string; data: string }) => Promise<void>
}

export const RECEIVED_RESPONSES_FAILURE = Symbol("received-responses-failure")

export function classifyResponsesTerminal(
  event?: string,
): ResponsesTerminalKind | undefined {
  if (
    event === "response.completed"
    || event === "response.incomplete"
    || event === "response.failed"
    || event === "error"
  ) {
    return event
  }
  return undefined
}

export function createResponsesStreamFailureState(
  model: string,
): ResponsesStreamFailureState {
  return {
    responseId: "resp_failed",
    model,
    createdAt: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    outputText: "",
    output: [],
    usage: null,
  }
}

export function createResponsesTerminalLifecycle(options: {
  c: Context
  stream: ResponsesStreamWriter
  state: ResponsesStreamFailureState
}) {
  return createStreamTerminalLifecycle<ResponsesTerminalSuccess>({
    isDownstreamAborted: () => options.stream.aborted || options.stream.closed,
    onSuccess: () => undefined,
    onFailure: async (failure) => {
      if (
        failure.kind === "thrown"
        && failure.error === RECEIVED_RESPONSES_FAILURE
      ) {
        return
      }
      await emitResponsesFailureAsStream(options.stream, {
        responseId: options.state.responseId,
        model: options.state.model,
        createdAt: options.state.createdAt,
        sequenceNumber: options.state.sequenceNumber,
        inspection: failure.inspection,
        partial: {
          output: options.state.output,
          outputText: options.state.outputText,
          usage: options.state.usage,
        },
      })
      if (failure.inspection && isHTTPError(failure.error)) {
        reportHttpError(options.c, failure.inspection)
      }
    },
  })
}

export function updateResponsesFailureState(
  state: ResponsesStreamFailureState,
  chunk: ResponsesStreamChunk,
): void {
  const parsed = readResponsesStreamData(chunk.data ?? "")
  if (!parsed) return
  updateSequence(state, parsed.sequence_number)
  updateResponseSnapshot(state, parsed.response)
  updateTextDelta(state, chunk.event, parsed)
  updateOutputItem(state, chunk.event, parsed)
}

export function createPartialTextOutput(
  text: string,
  itemId: unknown,
): Array<ResponseOutputItem> {
  if (!text) return []
  return [
    {
      id: typeof itemId === "string" ? itemId : "msg_partial",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ]
}

export async function emitResponsesFailureAsStream(
  stream: ResponsesStreamWriter,
  options: {
    responseId: string
    model: string
    sequenceNumber?: number
    createdAt?: number
    inspection?: HttpErrorInspection
    partial?: {
      output?: Array<ResponseOutputItem>
      outputText?: string
      usage?: ResponsesResult["usage"]
    }
  },
): Promise<void> {
  const error = createResponsesStreamFailureError(options.inspection)
  let sequenceNumber = options.sequenceNumber ?? 0
  const result = createFailedResponsesResult(options, error)
  await stream.writeSSE({
    event: "error",
    data: JSON.stringify({
      type: "error",
      code: "server_error",
      param: null,
      sequence_number: sequenceNumber++,
      ...error,
    }),
  })
  await stream.writeSSE({
    event: "response.failed",
    data: JSON.stringify({
      type: "response.failed",
      response: result,
      sequence_number: sequenceNumber,
    }),
  })
}

function readResponsesStreamData(data: string): Record<string, unknown> | null {
  if (!data) return null
  try {
    const parsed = JSON.parse(data) as unknown
    return (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ) ?
        (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function updateSequence(
  state: ResponsesStreamFailureState,
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return
  state.sequenceNumber = Math.max(state.sequenceNumber, value + 1)
}

function updateResponseSnapshot(
  state: ResponsesStreamFailureState,
  value: unknown,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return
  const response = value as Record<string, unknown>
  if (typeof response.id === "string") state.responseId = response.id
  if (typeof response.model === "string") state.model = response.model
  if (typeof response.created_at === "number") {
    state.createdAt = response.created_at
  }
  if (typeof response.output_text === "string") {
    state.outputText = response.output_text
  }
  if (Array.isArray(response.output)) {
    state.output = response.output as Array<ResponseOutputItem>
  }
  if (response.usage === null || typeof response.usage === "object") {
    state.usage = response.usage as ResponseUsage | null
  }
}

function updateTextDelta(
  state: ResponsesStreamFailureState,
  event: string | undefined,
  parsed: Record<string, unknown>,
): void {
  if (
    event !== "response.output_text.delta"
    || typeof parsed.delta !== "string"
  ) {
    return
  }
  state.outputText += parsed.delta
  mergeTextOutputItem(state, parsed)
}

function mergeTextOutputItem(
  state: ResponsesStreamFailureState,
  parsed: Record<string, unknown>,
): void {
  const outputIndex =
    typeof parsed.output_index === "number" ? parsed.output_index : 0
  const current = state.output[outputIndex] as ResponseOutputItem | undefined
  let itemId = "msg_partial"
  if (typeof parsed.item_id === "string") {
    itemId = parsed.item_id
  } else if (typeof current?.id === "string") {
    itemId = current.id
  }
  state.output[outputIndex] = {
    ...(current?.type === "message" ? current : {}),
    id: itemId,
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [
      {
        type: "output_text",
        text: state.outputText,
        annotations: [],
      },
    ],
  }
}

function updateOutputItem(
  state: ResponsesStreamFailureState,
  event: string | undefined,
  parsed: Record<string, unknown>,
): void {
  if (
    event !== "response.output_item.added"
    && event !== "response.output_item.done"
  ) {
    return
  }
  if (
    typeof parsed.output_index !== "number"
    || typeof parsed.item !== "object"
    || parsed.item === null
  ) {
    return
  }
  state.output[parsed.output_index] = parsed.item as ResponseOutputItem
}

type ResponsesStreamFailureError = NonNullable<ResponsesResult["error"]> & {
  body_bytes?: Array<number>
  content_type?: string
  /** Read by Codex for the delay before it retries. */
  headers?: Record<string, string>
  status?: number
}

function createResponsesStreamFailureError(
  inspection?: HttpErrorInspection,
): ResponsesStreamFailureError {
  if (!inspection) return { message: "Upstream request failed" }
  const retryAfter = inspection.responseHeaders["retry-after"]
  const classified = {
    code: classifyResponsesFailure(inspection),
    ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
  }
  if (inspection.kind !== "upstream") {
    return { ...classified, message: "Upstream request failed" }
  }
  return {
    ...classified,
    ...(inspection.bodyText === undefined ?
      { body_bytes: Array.from(inspection.bodyBytes), message: "" }
    : { message: inspection.bodyText }),
    ...(inspection.contentType ? { content_type: inspection.contentType } : {}),
    status: inspection.status,
  }
}

// Rate limits, timeouts and conflicts may pass; other client errors repeat.
const TRANSIENT_CLIENT_STATUSES = new Set([408, 409, 425, 429])

/**
 * Once the stream has started, a failure reaches the client only as
 * `response.failed`, and its code decides what Codex does. Codex retries a
 * code it does not know up to five times, compacts on
 * `context_length_exceeded`, and stops on `invalid_prompt`. A request the
 * provider refused fails the same way every time, so only rate limits and
 * server errors stay retryable, with their `retry-after`.
 */
function classifyResponsesFailure(inspection: HttpErrorInspection): string {
  const { status } = inspection
  if (isContextOverflow(inspection)) return "context_length_exceeded"
  if (status === 429) return "rate_limit_exceeded"
  if (status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status)) {
    return "invalid_prompt"
  }
  return "server_error"
}

function isContextOverflow(inspection: HttpErrorInspection): boolean {
  if (inspection.kind === "upstream") {
    return (
      readContextOverflowText(inspection.status, inspection.bodyText)
      !== undefined
    )
  }
  if (inspection.kind === "custom-provider" && inspection.providerError) {
    return (
      readContextOverflow(inspection.status, {
        error: inspection.providerError,
      }) !== undefined
    )
  }
  return false
}

function createFailedResponsesResult(
  options: {
    responseId: string
    model: string
    createdAt?: number
    partial?: {
      output?: Array<ResponseOutputItem>
      outputText?: string
      usage?: ResponsesResult["usage"]
    }
  },
  error: ResponsesStreamFailureError,
): ResponsesResult {
  return {
    id: options.responseId,
    object: "response",
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    model: options.model,
    output: options.partial?.output ?? [],
    output_text: options.partial?.outputText ?? "",
    status: "failed",
    usage: options.partial?.usage ?? null,
    error,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}
