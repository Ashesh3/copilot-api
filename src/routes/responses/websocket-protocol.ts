import type { CopilotRequestAttribution } from "~/lib/copilot-request-context"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { resolveCopilotRequestAttribution } from "~/lib/copilot-request-context"
import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"

const FRAME_ENVELOPE_KEYS = new Set([
  "agent_task_id",
  "headers",
  "initiator",
  "parent_agent_id",
  "response",
  "type",
])

export interface ParsedResponseCreateFrame {
  attribution: CopilotRequestAttribution
  initiator?: "agent" | "user"
  payload: ResponsesPayload
  requestedModel?: string
}

export type WebSocketFrameParseResult =
  | { ok: true; value: ParsedResponseCreateFrame }
  | {
      ok: false
      error: {
        code: string
        message: string
        status: number
        type: "invalid_request_error"
      }
    }

export type ContinuationResolution =
  | { ok: true; payload: ResponsesPayload }
  | {
      ok: false
      code: "invalid_request_error" | "previous_response_not_found"
      message: string
      status: 400
    }

export function parseResponsesWebSocketFrame(
  message: string | Buffer | Uint8Array,
): WebSocketFrameParseResult {
  if (typeof message !== "string") {
    return parseError("bad_request", "Binary frames not supported")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(message) as unknown
  } catch {
    return parseError("bad_request", "Invalid JSON")
  }

  if (!isRecord(parsed)) {
    return parseError("bad_request", "JSON message must be an object")
  }

  if (parsed.type !== "response.create") {
    return parseError("bad_request", "Unsupported message type")
  }

  const nestedResponse = isRecord(parsed.response) ? parsed.response : undefined
  if (parsed.stream === false || nestedResponse?.stream === false) {
    return parseError(
      "invalid_request_error",
      "Responses WebSocket requests must stream.",
    )
  }
  const payload = extractResponsesPayload(parsed)

  const initiator = parseInitiator(parsed, resolveFrameHeaders(parsed.headers))
  if (initiator === null) {
    return parseError(
      "invalid_request_error",
      "Responses WebSocket initiator must be user or agent.",
    )
  }

  return {
    ok: true,
    value: {
      attribution: resolveFrameAttribution(parsed),
      ...(initiator ? { initiator } : {}),
      payload,
      requestedModel: getRequestedModel(parsed),
    },
  }
}

export function extractResponsesPayload(
  frame: Record<string, unknown>,
): ResponsesPayload {
  const topLevel = omitFrameEnvelope(frame)
  const nested =
    isRecord(frame.response) ? omitFrameEnvelope(frame.response) : {}
  return { ...topLevel, ...nested } as ResponsesPayload
}

export function resolveResponsesContinuation(
  snapshots: ReadonlyMap<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ContinuationResolution {
  const previousResponseId = (payload as Record<string, unknown>)
    .previous_response_id

  if (previousResponseId === undefined) {
    return { ok: true, payload }
  }
  if (typeof previousResponseId !== "string") {
    return continuationError(
      "invalid_request_error",
      "previous_response_id must be a string",
    )
  }
  if (previousResponseId === "") {
    return continuationError(
      "invalid_request_error",
      "previous_response_id must not be empty",
    )
  }

  const snapshotPayload = snapshots.get(previousResponseId)
  if (!snapshotPayload) {
    // External IDs require direct upstream response state or gateway storage;
    // this no-storage transport can resolve only this connection's snapshots.
    return continuationError(
      "previous_response_not_found",
      "The previous response is not available on this WebSocket connection.",
    )
  }

  return {
    ok: true,
    payload: rehydrateContinuationPayloadFromSnapshot(snapshotPayload, payload),
  }
}

export function rehydrateContinuationPayloadFromSnapshot(
  snapshotPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  const mergedInput = mergeContinuationInput(
    snapshotPayload.input,
    payload.input,
  )

  return {
    ...snapshotPayload,
    ...payload,
    ...(mergedInput !== undefined ? { input: mergedInput } : {}),
    previous_response_id: undefined,
    generate: undefined,
  }
}

export function rehydrateContinuationPayload(
  responseSnapshots: ReadonlyMap<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ResponsesPayload | undefined {
  const previousResponseId = payload.previous_response_id
  if (!previousResponseId) return undefined

  const snapshotPayload = responseSnapshots.get(previousResponseId)
  if (!snapshotPayload) return undefined

  return rehydrateContinuationPayloadFromSnapshot(snapshotPayload, payload)
}

export function mergeContinuationInput(
  snapshotInput: ResponsesPayload["input"],
  input: ResponsesPayload["input"],
): ResponsesPayload["input"] {
  if (Array.isArray(snapshotInput) && Array.isArray(input)) {
    return [...snapshotInput, ...input]
  }
  if (Array.isArray(snapshotInput) && input === undefined) {
    return [...snapshotInput]
  }
  if (Array.isArray(input)) {
    return [...input]
  }
  if (typeof input === "string") {
    return input.length > 0 ? input : snapshotInput
  }
  return snapshotInput
}

function omitFrameEnvelope(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !FRAME_ENVELOPE_KEYS.has(key)),
  )
}

function resolveFrameAttribution(
  frame: Record<string, unknown>,
): CopilotRequestAttribution {
  const headers = resolveFrameHeaders(frame.headers)
  const attribution = resolveCopilotRequestAttribution(headers)
  if ("agent_task_id" in frame) delete attribution.agentTaskId
  if ("parent_agent_id" in frame) delete attribution.parentAgentId
  const agentTaskId = sanitizeCopilotHeaderValue(
    typeof frame.agent_task_id === "string" ? frame.agent_task_id : undefined,
  )
  const parentAgentId = sanitizeCopilotHeaderValue(
    typeof frame.parent_agent_id === "string" ?
      frame.parent_agent_id
    : undefined,
  )
  return {
    ...attribution,
    ...(agentTaskId ? { agentTaskId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
  }
}

function parseInitiator(
  frame: Record<string, unknown>,
  headers: Headers,
): "agent" | "user" | null | undefined {
  if ("initiator" in frame) {
    if (frame.initiator === "agent" || frame.initiator === "user") {
      return frame.initiator
    }
    return null
  }

  const headerValue = headers.get("x-initiator")
  return headerValue === "agent" || headerValue === "user" ?
      headerValue
    : undefined
}

function resolveFrameHeaders(value: unknown): Headers {
  const headers = new Headers()
  if (!isRecord(value)) return headers

  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") continue
    try {
      headers.set(name, headerValue)
    } catch {
      // Malformed or forbidden envelope headers are ignored recoverably.
    }
  }
  return headers
}

function getRequestedModel(frame: Record<string, unknown>): string | undefined {
  if (isRecord(frame.response) && typeof frame.response.model === "string") {
    return frame.response.model
  }
  return typeof frame.model === "string" ? frame.model : undefined
}

function parseError(
  code: string,
  message: string,
): Extract<WebSocketFrameParseResult, { ok: false }> {
  return {
    ok: false,
    error: { code, message, status: 400, type: "invalid_request_error" },
  }
}

function continuationError(
  code: "invalid_request_error" | "previous_response_not_found",
  message: string,
): Extract<ContinuationResolution, { ok: false }> {
  return { ok: false, code, message, status: 400 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
