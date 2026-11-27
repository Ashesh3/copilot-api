/* eslint-disable complexity, default-case, max-params, no-nested-ternary -- switches are exhaustive over ConversationProtocol. */
import { isRecord } from "~/lib/native-passthrough"

import type {
  AssistantDiffOp,
  CanonicalItem,
  CanonicalProtocol,
  CanonicalView,
  InterceptPhase,
} from "./types"

import {
  emitAnthropicStream,
  parseAnthropicRequestView,
  parseAnthropicResponseView,
  parseAnthropicStream,
  patchAnthropicRequest,
  patchAnthropicResponse,
} from "./canonical-anthropic"
import {
  emitChatStream,
  parseChatRequestView,
  parseChatResponseView,
  parseChatStream,
  patchChatRequest,
  patchChatResponse,
} from "./canonical-chat"
import {
  emitResponsesStream,
  parseResponsesRequestView,
  parseResponsesResponseView,
  parseResponsesStream,
  patchResponsesRequest,
  patchResponsesResponse,
} from "./canonical-responses"
import {
  asString,
  CanonicalEditError,
  type JsonRecord,
  type SseEvent,
  stringifyLike,
} from "./canonical-shared"

export { CanonicalEditError } from "./canonical-shared"

type ConversationProtocol = Exclude<
  CanonicalProtocol,
  "generic_json" | "raw_text"
>

/** Endpoints whose payloads are not conversations: raw editing only. */
const NON_CONVERSATION_PATH =
  /\/(?:embeddings|decisions|models|count_tokens)$|\/images\//

function protocolForPath(path: string): CanonicalProtocol | undefined {
  const normalized = (path.split("?")[0] ?? "")
    .toLowerCase()
    .replace(/\/+$/, "")
  if (NON_CONVERSATION_PATH.test(normalized)) return "generic_json"
  if (normalized.endsWith("/chat/completions")) return "chat_completions"
  if (normalized.endsWith("/messages")) return "anthropic_messages"
  if (normalized.endsWith("/responses")) return "responses"
  return undefined
}

export function detectProtocol(
  path: string,
  parsed: unknown,
): CanonicalProtocol {
  const byPath = protocolForPath(path)
  if (byPath) return byPath
  if (!isRecord(parsed))
    return parsed === undefined ? "raw_text" : "generic_json"

  // Unknown endpoint: only unambiguous conversation shapes are structured.
  if (Array.isArray(parsed.messages)) {
    return "system" in parsed ? "anthropic_messages" : "chat_completions"
  }
  if (Array.isArray(parsed.choices)) return "chat_completions"
  if (parsed.type === "message" && Array.isArray(parsed.content)) {
    return "anthropic_messages"
  }
  if (parsed.object === "response") return "responses"
  if (
    Array.isArray(parsed.input)
    && parsed.input.length > 0
    && parsed.input.every(
      (entry) => isRecord(entry) && ("type" in entry || "role" in entry),
    )
  ) {
    return "responses"
  }
  return "generic_json"
}

export function isSseBody(body: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().includes("text/event-stream")) return true
  const trimmed = body.trimStart()
  return trimmed.startsWith("data:") || trimmed.startsWith("event:")
}

export function parseSseEvents(body: string): Array<SseEvent> {
  const events: Array<SseEvent> = []
  for (const block of body.replaceAll("\r\n", "\n").split("\n\n")) {
    if (!block.trim()) continue
    let eventName: string | undefined
    const dataLines: Array<string> = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length > 0 || eventName) {
      events.push({
        ...(eventName ? { event: eventName } : {}),
        data: dataLines.join("\n"),
      })
    }
  }
  return events
}

function streamProtocol(path: string, body: string): CanonicalProtocol {
  const byPath = protocolForPath(path)
  if (byPath) return byPath
  if (/"type"\s*:\s*"message_start"/.test(body)) return "anthropic_messages"
  if (/"type"\s*:\s*"response\./.test(body)) return "responses"
  if (/"choices"\s*:/.test(body)) return "chat_completions"
  return "generic_json"
}

function readOnlyView(
  protocol: "generic_json" | "raw_text",
  phase: InterceptPhase,
  readOnlyReason: string,
  model?: string,
): CanonicalView {
  return {
    protocol,
    phase,
    ...(model ? { model } : {}),
    items: [],
    editable: false,
    readOnlyReason,
  }
}

const STREAM_NOTE =
  "Buffered stream: structured edits re-emit the stream from the edited response, keeping upstream IDs, usage, and the terminal event."

interface ParsedStream {
  final: JsonRecord
  readOnlyReason?: string
  emit: (patched: JsonRecord) => string
}

function parseStream(
  protocol: ConversationProtocol,
  body: string,
): ParsedStream {
  const events = parseSseEvents(body)
  switch (protocol) {
    case "anthropic_messages": {
      const stream = parseAnthropicStream(events)
      return {
        final: stream.message,
        readOnlyReason: stream.readOnlyReason,
        emit: (patched) => emitAnthropicStream(stream, patched),
      }
    }
    case "responses": {
      const stream = parseResponsesStream(events)
      return {
        final: stream.final,
        readOnlyReason: stream.readOnlyReason,
        emit: (patched) => emitResponsesStream(stream, patched),
      }
    }
    case "chat_completions": {
      const stream = parseChatStream(events)
      return {
        final: stream.final,
        readOnlyReason: stream.readOnlyReason,
        emit: (patched) => emitChatStream(stream, patched),
      }
    }
  }
}

function responseView(
  protocol: ConversationProtocol,
  body: JsonRecord,
  stream: boolean,
): CanonicalView {
  switch (protocol) {
    case "anthropic_messages": {
      return parseAnthropicResponseView(body, stream)
    }
    case "responses": {
      return parseResponsesResponseView(body, stream)
    }
    case "chat_completions": {
      return parseChatResponseView(body, stream)
    }
  }
}

/** An upstream error body has nothing structured to edit. */
function isErrorPayload(body: JsonRecord): boolean {
  return (
    ((body.error !== undefined && body.error !== null) || body.type === "error")
    && !Array.isArray(body.choices)
    && !Array.isArray(body.content)
    && !Array.isArray(body.output)
  )
}

export function parseCanonicalView(options: {
  path: string
  phase: InterceptPhase
  body: string
  contentType?: string
}): CanonicalView {
  const { path, phase, body, contentType } = options

  if (phase === "response" && isSseBody(body, contentType)) {
    const protocol = streamProtocol(path, body)
    if (protocol === "generic_json" || protocol === "raw_text") {
      return readOnlyView(
        "generic_json",
        phase,
        "This stream is not a conversation; edit it in the raw editor.",
      )
    }
    const stream = parseStream(protocol, body)
    const view = responseView(protocol, stream.final, true)
    return stream.readOnlyReason ?
        { ...view, editable: false, readOnlyReason: stream.readOnlyReason }
      : { ...view, note: STREAM_NOTE }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return readOnlyView(
      "raw_text",
      phase,
      "The body is not JSON; edit it in the raw editor.",
    )
  }

  const protocol = detectProtocol(path, parsed)
  if (
    !isRecord(parsed)
    || protocol === "generic_json"
    || protocol === "raw_text"
  ) {
    return readOnlyView(
      "generic_json",
      phase,
      "Structured editing is not available for this endpoint; edit the raw body.",
      isRecord(parsed) ? asString(parsed.model) : undefined,
    )
  }
  if (phase === "request") {
    switch (protocol) {
      case "anthropic_messages": {
        return parseAnthropicRequestView(parsed)
      }
      case "responses": {
        return parseResponsesRequestView(parsed)
      }
      case "chat_completions": {
        return parseChatRequestView(parsed)
      }
    }
  }
  if (isErrorPayload(parsed)) {
    return readOnlyView(
      "generic_json",
      phase,
      "The upstream returned an error payload; edit it in the raw editor.",
      asString(parsed.model),
    )
  }
  return responseView(protocol, parsed, false)
}

function patchBody(
  protocol: ConversationProtocol,
  phase: InterceptPhase,
  body: JsonRecord,
  items: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  if (phase === "request") {
    switch (protocol) {
      case "anthropic_messages": {
        return patchAnthropicRequest(body, items)
      }
      case "responses": {
        return patchResponsesRequest(body, items)
      }
      case "chat_completions": {
        return patchChatRequest(body, items)
      }
    }
  }
  switch (protocol) {
    case "anthropic_messages": {
      return patchAnthropicResponse(body, items)
    }
    case "responses": {
      return patchResponsesResponse(body, items)
    }
    case "chat_completions": {
      return patchChatResponse(body, items)
    }
  }
}

function insertedItem(
  op: Extract<AssistantDiffOp, { op: "insert_after" }>,
  id: string,
): CanonicalItem {
  const role =
    op.kind === "tool_call" || op.kind === "thinking" ? "assistant"
    : op.kind === "tool_result" ? "tool"
    : op.kind
  const label =
    op.kind === "tool_call" ? `Tool Call: ${op.toolName ?? "tool"}`
    : op.kind === "tool_result" ? "Tool Result"
    : op.kind.charAt(0).toUpperCase() + op.kind.slice(1)
  const args =
    op.kind === "tool_call" ? (op.toolArguments ?? op.content) : undefined
  return {
    id,
    kind: op.kind,
    role,
    label,
    content: args ?? op.content,
    ...(op.toolName ? { toolName: op.toolName } : {}),
    ...(op.toolCallId ? { toolCallId: op.toolCallId } : {}),
    ...(args === undefined ? {} : { toolArguments: args }),
  }
}

/**
 * Applies diff operations to canonical items. Unknown target IDs and content
 * edits of read-only items throw `CanonicalEditError`.
 */
export function applyCanonicalDiffOps(
  items: ReadonlyArray<CanonicalItem>,
  operations: ReadonlyArray<AssistantDiffOp>,
): Array<CanonicalItem> {
  const next = items.map((item) => ({ ...item }))
  const indexOf = (id: string): number => {
    const index = next.findIndex((item) => item.id === id)
    if (index === -1) {
      throw new CanonicalEditError(
        `No item with ID "${id}" exists in this payload.`,
      )
    }
    return index
  }
  let insertCounter = 0

  for (const op of operations) {
    switch (op.op) {
      case "replace": {
        const index = indexOf(op.id)
        const current = next[index]
        if (
          current.opaque
          && (op.content !== undefined
            || op.toolName !== undefined
            || op.toolArguments !== undefined)
        ) {
          throw new CanonicalEditError(
            `"${current.label}" (${current.id}) is read-only; it can be removed but not edited.`,
          )
        }
        const updated: CanonicalItem = { ...current }
        if (op.toolName !== undefined) updated.toolName = op.toolName
        if (current.kind === "tool_call") {
          // Arguments and content are the same text for tool calls.
          const args = op.toolArguments ?? op.content
          if (args !== undefined) {
            updated.toolArguments = args
            updated.content = args
          }
          updated.label = `Tool Call: ${updated.toolName || "tool"}`
        } else {
          if (op.content !== undefined) updated.content = op.content
          if (op.toolArguments !== undefined)
            updated.toolArguments = op.toolArguments
        }
        next[index] = updated
        break
      }
      case "delete": {
        next.splice(indexOf(op.id), 1)
        break
      }
      case "insert_after": {
        let id: string
        do {
          insertCounter += 1
          id = `ins-${insertCounter}`
        } while (next.some((item) => item.id === id))
        const position = op.afterId === null ? 0 : indexOf(op.afterId) + 1
        next.splice(position, 0, insertedItem(op, id))
        break
      }
    }
  }
  return next
}

/**
 * Writes edited items back as a patch of `originalBody` (the body `canonical`
 * was parsed from). Untouched nodes are preserved; edited streams are
 * re-emitted from the patched final response. Throws `CanonicalEditError` for
 * edits that cannot be written faithfully.
 */
export function serializeCanonicalItemsToBody(options: {
  originalBody: string
  canonical: CanonicalView
  items: ReadonlyArray<CanonicalItem>
  contentType?: string
}): string {
  const { originalBody, canonical, items, contentType } = options
  const { protocol, phase } = canonical
  if (
    !canonical.editable
    || protocol === "generic_json"
    || protocol === "raw_text"
  ) {
    throw new CanonicalEditError(
      canonical.readOnlyReason
        ?? "Structured editing is not available for this payload; edit the raw body.",
    )
  }

  if (phase === "response" && isSseBody(originalBody, contentType)) {
    const stream = parseStream(protocol, originalBody)
    if (stream.readOnlyReason)
      throw new CanonicalEditError(stream.readOnlyReason)
    const patched = patchBody(protocol, phase, stream.final, items)
    return patched ? stream.emit(patched) : originalBody
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(originalBody)
  } catch {
    throw new CanonicalEditError(
      "The body is not JSON; edit it in the raw editor.",
    )
  }
  if (!isRecord(parsed)) {
    throw new CanonicalEditError(
      "The body is not a JSON object; edit it in the raw editor.",
    )
  }
  const patched = patchBody(protocol, phase, parsed, items)
  return patched ? stringifyLike(originalBody, patched) : originalBody
}

export function extractModelFromBody(body: string): string | undefined {
  if (!body) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && typeof parsed.model === "string") {
      return parsed.model
    }
  } catch {
    // Fallback for SSE: look for "model":"..."
    const match = /"model"\s*:\s*"([^"]+)"/.exec(body)
    if (match) return match[1]
  }
  return undefined
}
