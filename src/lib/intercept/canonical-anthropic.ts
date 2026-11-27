/* eslint-disable complexity, max-lines-per-function, max-params, no-nested-ternary */
import { isRecord } from "~/lib/native-passthrough"

import type { CanonicalItem, CanonicalView } from "./types"

import {
  asArray,
  asString,
  CanonicalEditError,
  capitalize,
  classifyEdits,
  type Entry,
  generatedId,
  groupSegments,
  type JsonRecord,
  type NodeRef,
  type ParsedItem,
  placeholderFor,
  reconcileStopReason,
  requireToolCallId,
  requireToolName,
  type Segment,
  type SseEvent,
  sseEvent,
  validatedToolArguments,
} from "./canonical-shared"

const TOOL_INPUT_BLOCKS = new Set([
  "tool_use",
  "server_tool_use",
  "mcp_tool_use",
])

const THINKING_INSERT_ERROR =
  "Thinking blocks cannot be inserted: Anthropic requires a signature for each one."

function isTextBlock(block: unknown): block is JsonRecord & { text: string } {
  return (
    isRecord(block) && block.type === "text" && typeof block.text === "string"
  )
}

/** Text of a tool_result's content, and whether it maps to one editable field. */
function toolResultText(content: unknown): { text: string; editable: boolean } {
  if (content === undefined || typeof content === "string") {
    return { text: content ?? "", editable: true }
  }
  const blocks = asArray(content)
  if (blocks.length === 1 && isTextBlock(blocks[0])) {
    return { text: blocks[0].text, editable: true }
  }
  return {
    text: blocks
      .map((b) => (isTextBlock(b) ? b.text : placeholderFor(b)))
      .join("\n"),
    editable: false,
  }
}

function parseBlock(block: unknown, id: string, role: string): CanonicalItem {
  const kind =
    role === "system" ? "system"
    : role === "assistant" ? "assistant"
    : "user"
  const roleLabel = capitalize(role)
  if (!isRecord(block)) {
    return {
      id,
      kind: "other",
      role,
      label: "Block",
      content: placeholderFor(block),
      opaque: true,
    }
  }
  const type = asString(block.type)
  switch (type) {
    case "text": {
      if (typeof block.text !== "string") break
      return { id, kind, role, label: roleLabel, content: block.text }
    }
    case "thinking": {
      const signed =
        typeof block.signature === "string" && block.signature !== ""
      return {
        id,
        kind: "thinking",
        role: "assistant",
        label: signed ? "Thinking (signed)" : "Thinking",
        content: asString(block.thinking) ?? "",
        ...(signed ? { opaque: true } : {}),
      }
    }
    case "redacted_thinking": {
      return {
        id,
        kind: "thinking",
        role: "assistant",
        label: "Redacted Thinking",
        content: placeholderFor(block),
        opaque: true,
      }
    }
    case "tool_use": {
      const name = asString(block.name) ?? ""
      const args = JSON.stringify(block.input ?? {}, null, 2)
      return {
        id,
        kind: "tool_call",
        role: "assistant",
        label: `Tool Call: ${name || "tool"}`,
        content: args,
        toolName: name,
        toolCallId: asString(block.id),
        toolArguments: args,
      }
    }
    case "server_tool_use":
    case "mcp_tool_use": {
      const name = asString(block.name)
      return {
        id,
        kind: "tool_call",
        role: "assistant",
        label: `Server Tool Call: ${name ?? type}`,
        content: JSON.stringify(block.input ?? {}, null, 2),
        toolName: name,
        toolCallId: asString(block.id),
        opaque: true,
      }
    }
    case "tool_result": {
      const { text, editable } = toolResultText(block.content)
      return {
        id,
        kind: "tool_result",
        role: "user",
        label: "Tool Result",
        content: text,
        toolCallId: asString(block.tool_use_id),
        ...(editable ? {} : { opaque: true }),
      }
    }
    case "image":
    case "document": {
      return {
        id,
        kind,
        role,
        label: roleLabel,
        content: placeholderFor(block),
        opaque: true,
      }
    }
    default: {
      break
    }
  }
  return {
    id,
    kind: "other",
    role,
    label: `Block: ${type ?? "unknown"}`,
    content: placeholderFor(block),
    opaque: true,
  }
}

function parseContainer(
  content: unknown,
  prefix: string,
  container: string,
  role: string,
  partPrefix: string,
): Array<ParsedItem> {
  if (typeof content === "string") {
    return [
      {
        item: { ...parseBlock({ type: "text", text: content }, prefix, role) },
        container,
        containerRole: role,
        partsContainer: false,
        ref: { t: "whole" },
      },
    ]
  }
  return asArray(content).map((block, j) => ({
    item: parseBlock(block, `${partPrefix}${j}`, role),
    container,
    containerRole: role,
    partsContainer: true,
    ref: { t: "part", j } satisfies NodeRef,
  }))
}

/** The block an entry writes; untouched blocks are returned as-is. */
function blockFor(entry: Entry, blocks: ReadonlyArray<unknown>): unknown {
  const { item } = entry
  if (entry.orig) {
    if (entry.orig.ref.t !== "part") return { type: "text", text: item.content }
    const block = blocks[entry.orig.ref.j]
    if (!entry.changed || !isRecord(block)) return block
    switch (block.type) {
      case "text": {
        return { ...block, text: item.content }
      }
      case "thinking": {
        return { ...block, thinking: item.content }
      }
      case "tool_use": {
        return {
          ...block,
          id: item.toolCallId ?? block.id,
          name: requireToolName(entry),
          input: validatedToolArguments(entry, true).value,
        }
      }
      case "tool_result": {
        const content = asArray(block.content)
        return {
          ...block,
          tool_use_id: item.toolCallId ?? block.tool_use_id,
          content:
            Array.isArray(block.content) ?
              [{ ...(content[0] as JsonRecord), text: item.content }]
            : item.content,
        }
      }
      default: {
        return block
      }
    }
  }
  switch (item.kind) {
    case "tool_call": {
      return {
        type: "tool_use",
        id: item.toolCallId?.trim() || generatedId("toolu_"),
        name: requireToolName(entry),
        input: validatedToolArguments(entry, true).value,
      }
    }
    case "tool_result": {
      return {
        type: "tool_result",
        tool_use_id: requireToolCallId(item),
        content: item.content,
      }
    }
    case "thinking": {
      throw new CanonicalEditError(THINKING_INSERT_ERROR)
    }
    case "other": {
      throw new CanonicalEditError(`Item ${item.id} has no insertable kind.`)
    }
    default: {
      return { type: "text", text: item.content }
    }
  }
}

function hasToolUse(content: unknown): boolean {
  return asArray(content).some((b) => isRecord(b) && b.type === "tool_use")
}

// ─── Requests ───────────────────────────────────────────────────────────────

function parseRequestItems(body: JsonRecord): Array<ParsedItem> {
  const system =
    body.system === undefined ?
      []
    : parseContainer(body.system, "sys-0", "sys", "system", "sys-")
  const messages = asArray(body.messages).flatMap((msg, i) => {
    if (!isRecord(msg)) {
      return [
        {
          item: parseBlock(msg, `msg-${i}`, "user"),
          container: `m${i}`,
          containerRole: "user",
          partsContainer: false,
          ref: { t: "node" } satisfies NodeRef,
        },
      ]
    }
    const role = asString(msg.role) ?? "user"
    return parseContainer(
      msg.content,
      `msg-${i}`,
      `m${i}`,
      role,
      `msg-${i}-blk-`,
    )
  })
  return [...system, ...messages]
}

export function parseAnthropicRequestView(body: JsonRecord): CanonicalView {
  return {
    protocol: "anthropic_messages",
    phase: "request",
    model: asString(body.model),
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    items: parseRequestItems(body).map((p) => p.item),
    editable: true,
  }
}

function anthropicRole(item: CanonicalItem): string {
  return item.kind === "user" || item.kind === "tool_result" ?
      "user"
    : "assistant"
}

function buildSystem(
  orig: unknown,
  entries: ReadonlyArray<Entry>,
  hadItems: boolean,
): unknown {
  // A system that produced no items (`[]`, `null`) is kept as-is.
  if (entries.length === 0) return hadItems ? undefined : orig
  const [first] = entries
  if (
    entries.length === 1
    && (typeof orig === "string" || (orig === undefined && !first.orig))
  ) {
    return first.orig && !first.changed ? orig : first.item.content
  }
  return entries.map((e) => blockFor(e, asArray(orig)))
}

/**
 * Re-inserts messages that produced no items (e.g. `content: []`) verbatim,
 * each right after the output of the nearest earlier original message that
 * survived the edit, or first when none did.
 */
function withEmptyMessages(
  messages: ReadonlyArray<unknown>,
  parsed: ReadonlyArray<ParsedItem>,
  segments: ReadonlyArray<Segment>,
  built: Array<unknown>,
): Array<unknown> {
  const withItems = new Set(parsed.map((p) => p.container))
  const lastSegment = new Map<string, number>()
  for (const [s, segment] of segments.entries()) {
    if (segment.key !== undefined) lastSegment.set(segment.key, s)
  }
  const after = new Map<number, Array<unknown>>()
  let anchor = -1
  for (const [i, msg] of messages.entries()) {
    const key = `m${i}`
    const at = lastSegment.get(key)
    if (at !== undefined) anchor = at
    else if (!withItems.has(key)) {
      const list = after.get(anchor) ?? []
      list.push(msg)
      after.set(anchor, list)
    }
  }
  if (after.size === 0) return built
  const out = [...(after.get(-1) ?? [])]
  for (const [s, msg] of built.entries()) {
    out.push(msg, ...(after.get(s) ?? []))
  }
  return out
}

function isSystemEntry(e: Entry): boolean {
  return e.orig ?
      e.orig.container === "sys"
    : e.item.kind === "system" || e.item.kind === "developer"
}

export function patchAnthropicRequest(
  body: JsonRecord,
  edited: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  const messages = asArray(body.messages)
  const parsed = parseRequestItems(body)
  const { entries, unchanged } = classifyEdits(parsed, edited)
  if (unchanged) return undefined

  for (const e of entries) {
    if (!e.orig && e.item.kind === "thinking") {
      throw new CanonicalEditError(THINKING_INSERT_ERROR)
    }
  }
  const segments = groupSegments(
    entries.filter((e) => !isSystemEntry(e)),
    {
      roleForNew: anthropicRole,
      canJoin: (segment, item, inside) => {
        if (segment.role !== anthropicRole(item)) return false
        if (item.kind === "tool_call") return true
        if (item.kind === "tool_result") {
          return segment.entries.at(-1)?.item.kind === "tool_result"
        }
        return inside
      },
    },
  )

  const nextMessages = segments.map((segment) => {
    const orig =
      segment.key === undefined ?
        undefined
      : messages[Number(segment.key.slice(1))]
    if (orig !== undefined && !isRecord(orig)) return orig
    const msg: JsonRecord = orig ? { ...orig } : { role: segment.role }
    const [first] = segment.entries
    if (
      typeof orig?.content === "string"
      && segment.entries.length === 1
      && first.orig?.ref.t === "whole"
    ) {
      if (first.changed) msg.content = first.item.content
      return msg
    }
    msg.content = segment.entries.map((e) =>
      blockFor(e, asArray(orig?.content)),
    )
    return msg
  })

  const next: JsonRecord = {
    ...body,
    messages: withEmptyMessages(messages, parsed, segments, nextMessages),
  }
  const system = buildSystem(
    body.system,
    entries.filter((e) => isSystemEntry(e)),
    parsed.some((p) => p.container === "sys"),
  )
  if (system === undefined) Reflect.deleteProperty(next, "system")
  else next.system = system
  return next
}

// ─── Responses (JSON and the final object of a stream) ──────────────────────

function parseResponseItems(message: JsonRecord): Array<ParsedItem> {
  return parseContainer(
    asArray(message.content),
    "out",
    "content",
    "assistant",
    "out-",
  )
}

export function parseAnthropicResponseView(
  message: JsonRecord,
  stream: boolean,
): CanonicalView {
  return {
    protocol: "anthropic_messages",
    phase: "response",
    model: asString(message.model),
    stream,
    stopReason: asString(message.stop_reason),
    items: parseResponseItems(message).map((p) => p.item),
    editable: true,
  }
}

export function patchAnthropicResponse(
  message: JsonRecord,
  edited: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  const blocks = asArray(message.content)
  const { entries, unchanged } = classifyEdits(
    parseResponseItems(message),
    edited,
  )
  if (unchanged) return undefined
  for (const e of entries) {
    if (e.orig || e.item.kind === "assistant" || e.item.kind === "tool_call")
      continue
    throw new CanonicalEditError(
      e.item.kind === "thinking" ?
        THINKING_INSERT_ERROR
      : `A ${e.item.kind} item cannot be added to a model response.`,
    )
  }
  const content = entries.map((e) => blockFor(e, blocks))
  const next: JsonRecord = { ...message, content }
  if ("stop_reason" in message) {
    next.stop_reason = reconcileStopReason(
      message.stop_reason,
      hasToolUse(blocks),
      hasToolUse(content),
      "end_turn",
      "tool_use",
    )
  }
  return next
}

// ─── Streams ────────────────────────────────────────────────────────────────

export interface AnthropicStream {
  /** The message the stream describes, as a non-streaming object. */
  message: JsonRecord
  start: JsonRecord
  ping: boolean
  delta: JsonRecord
  stop: JsonRecord
  readOnlyReason?: string
}

function applyBlockDelta(
  block: JsonRecord,
  delta: JsonRecord,
  json: Map<number, string>,
  index: number,
): boolean {
  switch (delta.type) {
    case "text_delta": {
      block.text = (asString(block.text) ?? "") + (asString(delta.text) ?? "")
      return true
    }
    case "thinking_delta": {
      block.thinking =
        (asString(block.thinking) ?? "") + (asString(delta.thinking) ?? "")
      return true
    }
    case "signature_delta": {
      block.signature =
        (asString(block.signature) ?? "") + (asString(delta.signature) ?? "")
      return true
    }
    case "input_json_delta": {
      json.set(
        index,
        (json.get(index) ?? "") + (asString(delta.partial_json) ?? ""),
      )
      return true
    }
    case "citations_delta": {
      block.citations = [...asArray(block.citations), delta.citation]
      return true
    }
    default: {
      return false
    }
  }
}

export function parseAnthropicStream(
  events: ReadonlyArray<SseEvent>,
): AnthropicStream {
  let readOnlyReason: string | undefined
  let start: JsonRecord | undefined
  let delta: JsonRecord | undefined
  let stop: JsonRecord | undefined
  let ping = false
  const blocks = new Map<number, JsonRecord>()
  const json = new Map<number, string>()
  const fail = (reason: string) => {
    readOnlyReason ??= reason
  }

  for (const ev of events) {
    if (!ev.data) continue
    let payload: unknown
    try {
      payload = JSON.parse(ev.data)
    } catch {
      fail("The stream contains an event that is not JSON.")
      continue
    }
    if (!isRecord(payload)) continue
    const type = asString(payload.type) ?? ev.event
    const index = typeof payload.index === "number" ? payload.index : -1
    switch (type) {
      case "message_start": {
        start = payload
        break
      }
      case "ping": {
        ping = true
        break
      }
      case "content_block_start": {
        if (!isRecord(payload.content_block)) {
          fail("The stream contains a malformed content block.")
          break
        }
        blocks.set(index, { ...payload.content_block })
        if (TOOL_INPUT_BLOCKS.has(String(payload.content_block.type))) {
          json.set(index, "")
        }
        break
      }
      case "content_block_delta": {
        const block = blocks.get(index)
        if (
          !block
          || !isRecord(payload.delta)
          || !applyBlockDelta(block, payload.delta, json, index)
        ) {
          fail(
            "The stream contains a content delta structured edits cannot reproduce.",
          )
        }
        break
      }
      case "content_block_stop": {
        const raw = json.get(index)
        const block = blocks.get(index)
        if (block && raw?.trim()) {
          try {
            block.input = JSON.parse(raw)
          } catch {
            fail("A tool call's streamed input is not valid JSON.")
          }
        }
        break
      }
      case "message_delta": {
        delta = payload
        break
      }
      case "message_stop": {
        stop = payload
        break
      }
      case "error": {
        fail(
          "The stream contains an error event that structured edits cannot reproduce.",
        )
        break
      }
      default: {
        fail(`The stream contains an unsupported event (${type ?? "unnamed"}).`)
      }
    }
  }

  const startMessage = isRecord(start?.message) ? start.message : {}
  const message: JsonRecord = {
    ...startMessage,
    content: [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b),
  }
  const d = isRecord(delta?.delta) ? delta.delta : {}
  if ("stop_reason" in d) message.stop_reason = d.stop_reason
  if ("stop_sequence" in d) message.stop_sequence = d.stop_sequence
  if (isRecord(delta?.usage)) {
    message.usage = {
      ...(isRecord(startMessage.usage) ? startMessage.usage : {}),
      ...delta.usage,
    }
  }
  if (!start) fail("The stream has no message_start event.")
  if (!delta || !stop) {
    fail(
      "The stream ended before message_stop (truncated); structured edits are disabled.",
    )
  }
  return {
    message,
    start: start ?? {},
    ping,
    delta: delta ?? {},
    stop: stop ?? {},
    readOnlyReason,
  }
}

function emitBlock(out: Array<string>, block: unknown, index: number): void {
  const start = (contentBlock: unknown) =>
    out.push(
      sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: contentBlock,
      }),
    )
  const delta = (d: JsonRecord) =>
    out.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: d,
      }),
    )

  const type = isRecord(block) ? asString(block.type) : undefined
  if (isRecord(block) && type === "text") {
    const { text, citations, ...rest } = block
    start({
      ...rest,
      text: "",
      ...(citations === undefined ? {} : { citations: [] }),
    })
    if (typeof text === "string" && text) delta({ type: "text_delta", text })
    for (const citation of asArray(citations)) {
      delta({ type: "citations_delta", citation })
    }
  } else if (isRecord(block) && type === "thinking") {
    const { thinking, signature, ...rest } = block
    start({
      ...rest,
      thinking: "",
      ...(signature === undefined ? {} : { signature: "" }),
    })
    if (typeof thinking === "string" && thinking) {
      delta({ type: "thinking_delta", thinking })
    }
    if (typeof signature === "string" && signature) {
      delta({ type: "signature_delta", signature })
    }
  } else if (isRecord(block) && TOOL_INPUT_BLOCKS.has(type ?? "")) {
    const { input, ...rest } = block
    start({ ...rest, input: {} })
    const partial = JSON.stringify(input ?? {})
    if (partial !== "{}")
      delta({ type: "input_json_delta", partial_json: partial })
  } else {
    start(block)
  }
  out.push(
    sseEvent("content_block_stop", { type: "content_block_stop", index }),
  )
}

export function emitAnthropicStream(
  stream: AnthropicStream,
  message: JsonRecord,
): string {
  const out: Array<string> = []
  const startMessage =
    isRecord(stream.start.message) ? stream.start.message : {}
  out.push(
    sseEvent("message_start", {
      ...stream.start,
      message: { ...startMessage, content: [] },
    }),
  )
  if (stream.ping) out.push(sseEvent("ping", { type: "ping" }))
  for (const [index, block] of asArray(message.content).entries()) {
    emitBlock(out, block, index)
  }
  const d = isRecord(stream.delta.delta) ? stream.delta.delta : {}
  out.push(
    sseEvent("message_delta", {
      ...stream.delta,
      delta: {
        ...d,
        stop_reason: message.stop_reason ?? d.stop_reason ?? null,
      },
    }),
    sseEvent("message_stop", stream.stop),
  )
  return out.join("")
}
