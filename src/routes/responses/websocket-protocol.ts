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
    return parseError(
      "bad_request",
      `Unsupported message type: ${String(parsed.type)}`,
    )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
