import { randomUUID } from "node:crypto"

import { LocalHTTPError } from "~/lib/error"
import { getRequestId } from "~/lib/request-session"

import type {
  CanonicalView,
  InterceptAssistantConfig,
  InterceptConfig,
  InterceptFilterConfig,
  InterceptItemSummary,
  InterceptPendingItem,
  InterceptPhase,
} from "./types"

import { redactHeaders } from "./held-body"

/** 403: dropped by the operator. 504: no decision in time. 499: client gone. */
export type DropStatus = 403 | 499 | 504

export function cloneConfig(config: InterceptConfig): InterceptConfig {
  return {
    ...config,
    filters: {
      ...config.filters,
      conditions: config.filters.conditions.map((c) => ({ ...c })),
    },
    assistant: { ...config.assistant },
  }
}

export function normalizeFilters(
  filters: InterceptFilterConfig,
): InterceptFilterConfig {
  return {
    enabled: filters.enabled,
    matchMode: filters.matchMode === "any" ? "any" : "all",
    conditions: filters.conditions.map((c) => ({
      id: c.id || randomUUID(),
      enabled: c.enabled,
      field: c.field,
      ...(c.headerName ? { headerName: c.headerName } : {}),
      operator: c.operator,
      value: c.value,
      caseSensitive: Boolean(c.caseSensitive),
    })),
  }
}

export function normalizeAssistant(
  assistant: InterceptAssistantConfig,
): InterceptAssistantConfig {
  return {
    enabled: assistant.enabled,
    autoRun: assistant.autoRun,
    autopilot: assistant.autopilot,
    model: assistant.model.trim(),
    systemPrompt: assistant.systemPrompt,
    instructionMode:
      assistant.instructionMode === "separate" ? "separate" : "shared",
    sharedInstruction: assistant.sharedInstruction,
    requestInstruction: assistant.requestInstruction,
    responseInstruction: assistant.responseInstruction,
  }
}

export function summarizeItem(
  item: InterceptPendingItem,
): InterceptItemSummary {
  const firstMeaningful =
    item.canonical.items.find(
      (entry) => entry.kind !== "system" && !entry.opaque && entry.content,
    ) ?? item.canonical.items.at(0)
  const rawPreview =
    firstMeaningful ? firstMeaningful.content : item.currentBody
  const preview = rawPreview.replaceAll(/\s+/g, " ").trim().slice(0, 140)
  return {
    id: item.id,
    phase: item.phase,
    status: item.status,
    createdAt: item.createdAt,
    createdAtMs: item.createdAtMs,
    expiresAtMs: item.expiresAtMs,
    modified: item.modified,
    method: item.method,
    path: item.path,
    upstream: item.upstream,
    providerId: item.providerId,
    model: item.model,
    sessionId: item.sessionId,
    stream: item.stream,
    responseStatus: item.responseStatus,
    bodyBytes: Buffer.byteLength(item.currentBody, "utf8"),
    itemCount: item.canonical.items.length,
    preview,
    assistantStatus: item.assistantStatus,
    assistantOpCount: item.assistantSuggestion?.operations.length ?? 0,
    autopilot: item.autopilot === true,
  }
}

/**
 * A dropped request or response is a local error, never a fake upstream
 * response, so transport status handling (account rejection, provider
 * failure, retries) never sees it.
 */
export function droppedError(
  reason: string,
  status: DropStatus,
): LocalHTTPError {
  const body = {
    error: {
      code: "intercept_dropped",
      type: status === 403 ? "permission_error" : "api_error",
      message: `Dropped by Intercept: ${reason}`,
    },
  }
  return new LocalHTTPError(
    body.error.message,
    Response.json(body, { status }),
    body,
  )
}

/**
 * A retry of an approved request differs where the operator edited it, and
 * Intercept is off, so it cannot be reviewed again. Sending it would discard
 * the approved edits, so it is not sent.
 */
export function replayConflictError(): LocalHTTPError {
  const body = {
    error: {
      code: "intercept_replay_conflict",
      type: "api_error",
      message:
        "A retry changed the request approved in Intercept, and Intercept is off, so the retry was not sent.",
    },
  }
  return new LocalHTTPError(
    body.error.message,
    Response.json(body, { status: 409 }),
    body,
  )
}

/** The `stream` flag of a JSON request body, or undefined when it is not JSON. */
export function requestStreamFlag(body: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
        "stream" in parsed && parsed.stream === true
      : undefined
  } catch {
    return undefined
  }
}

export function buildItem(options: {
  phase: InterceptPhase
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  headers: Record<string, string>
  body: string
  model?: string
  sessionId?: string
  canonical: CanonicalView
  /** Absolute hold deadline; a response's began when its capture started. */
  expiresAtMs: number
}): InterceptPendingItem {
  const now = Date.now()
  return {
    id: randomUUID(),
    phase: options.phase,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    expiresAtMs: options.expiresAtMs,
    modified: false,
    revision: 0,
    method: options.method,
    path: options.path,
    url: options.url,
    upstream: options.upstream,
    providerId: options.providerId,
    model: options.model,
    sessionId: options.sessionId,
    requestId: getRequestId(),
    stream: options.canonical.stream,
    headers: redactHeaders(options.headers),
    originalBody: options.body,
    currentBody: options.body,
    canonical: options.canonical,
    assistantStatus: "idle",
  }
}
