/* eslint-disable complexity, max-lines-per-function, max-params */
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
  refsByContainer,
  requireToolCallId,
  requireToolName,
  roleToKind,
  type SseEvent,
  validatedToolArguments,
} from "./canonical-shared"

const REASONING_FIELDS = [
  "reasoning_text",
  "reasoning_content",
  "reasoning",
] as const
/** Copilot's field; used when a message gains reasoning it never had. */
const DEFAULT_REASONING_FIELD = "reasoning_text"

function reasoningFieldOf(msg: JsonRecord): string | undefined {
  return REASONING_FIELDS.find(
    (field) => typeof msg[field] === "string" && msg[field] !== "",
  )
}

function hasOpaqueReasoning(msg: JsonRecord): boolean {
  return msg.reasoning_opaque !== undefined && msg.reasoning_opaque !== null
}

function hasToolCalls(msg: unknown): boolean {
  return isRecord(msg) && asArray(msg.tool_calls).length > 0
}

function parseChatToolCall(tc: unknown, id: string): CanonicalItem {
  if (
    isRecord(tc)
    && isRecord(tc.function)
    && (tc.type === undefined || tc.type === "function")
  ) {
    const name = asString(tc.function.name) ?? ""
    const args =
      typeof tc.function.arguments === "string" ?
        tc.function.arguments
      : JSON.stringify(tc.function.arguments ?? {})
    return {
      id,
      kind: "tool_call",
      role: "assistant",
      label: `Tool Call: ${name || "tool"}`,
      content: args,
      toolName: name,
      toolCallId: asString(tc.id),
      toolArguments: args,
    }
  }
  // Custom or unknown tool-call variants cannot be rebuilt as functions.
  const custom = isRecord(tc) && isRecord(tc.custom) ? tc.custom : undefined
  const name = asString(custom?.name)
  return {
    id,
    kind: "tool_call",
    role: "assistant",
    label: `Tool Call: ${name ?? (isRecord(tc) ? asString(tc.type) : undefined) ?? "unknown"}`,
    content: asString(custom?.input) ?? placeholderFor(tc),
    toolName: name,
    toolCallId: isRecord(tc) ? asString(tc.id) : undefined,
    opaque: true,
  }
}

/** Items of one Chat message (request message or response choice message). */
function parseChatMessage(
  msg: unknown,
  prefix: string,
  container: string,
  defaultRole: string,
  labelSuffix = "",
): Array<ParsedItem> {
  if (!isRecord(msg)) {
    return [
      {
        item: {
          id: prefix,
          kind: "other",
          label: `Message${labelSuffix}`,
          content: "[unrecognized message]",
          opaque: true,
        },
        container,
        containerRole: defaultRole,
        partsContainer: false,
        ref: { t: "node" },
      },
    ]
  }
  const role = asString(msg.role) ?? defaultRole
  const kind = roleToKind(role)
  const partsContainer = Array.isArray(msg.content) && msg.content.length > 0
  const out: Array<ParsedItem> = []
  const add = (item: CanonicalItem, ref: NodeRef) => {
    out.push({ item, container, containerRole: role, partsContainer, ref })
  }

  const field = reasoningFieldOf(msg)
  if (field) {
    add(
      {
        id: `${prefix}-think`,
        kind: "thinking",
        role: "assistant",
        label: `Thinking${labelSuffix}`,
        content: msg[field] as string,
      },
      { t: "think" },
    )
  } else if (hasOpaqueReasoning(msg)) {
    add(
      {
        id: `${prefix}-think`,
        kind: "thinking",
        role: "assistant",
        label: `Thinking${labelSuffix}`,
        content: "[encrypted reasoning]",
        opaque: true,
      },
      { t: "think" },
    )
  }

  const toolName = role === "tool" ? asString(msg.name) : undefined
  const toolMeta =
    role === "tool" ?
      {
        ...(toolName ? { toolName } : {}),
        ...(asString(msg.tool_call_id) ?
          { toolCallId: asString(msg.tool_call_id) }
        : {}),
      }
    : {}
  const label =
    role === "tool" ?
      `Tool Result${toolName ? ` (${toolName})` : ""}${labelSuffix}`
    : `${capitalize(role)}${labelSuffix}`
  const toolCalls = asArray(msg.tool_calls)

  if (partsContainer) {
    for (const [j, part] of (msg.content as Array<unknown>).entries()) {
      const text =
        isRecord(part) && part.type === "text" ? asString(part.text) : undefined
      add(
        text === undefined ?
          {
            id: `${prefix}-p-${j}`,
            kind,
            role,
            label,
            content: placeholderFor(part),
            opaque: true,
            ...toolMeta,
          }
        : {
            id: `${prefix}-p-${j}`,
            kind,
            role,
            label,
            content: text,
            ...toolMeta,
          },
        { t: "part", j },
      )
    }
  } else if (
    (typeof msg.content === "string" && msg.content !== "")
    || toolCalls.length === 0
  ) {
    add(
      {
        id: prefix,
        kind,
        role,
        label,
        content: typeof msg.content === "string" ? msg.content : "",
        ...toolMeta,
      },
      { t: "whole" },
    )
  }

  for (const [j, tc] of toolCalls.entries()) {
    add(parseChatToolCall(tc, `${prefix}-tc-${j}`), { t: "tc", j })
  }
  return out
}

function chatRoleForKind(item: CanonicalItem): string {
  switch (item.kind) {
    case "tool_call":
    case "thinking": {
      return "assistant"
    }
    case "tool_result": {
      return "tool"
    }
    case "other": {
      throw new CanonicalEditError(`Item ${item.id} has no insertable kind.`)
    }
    default: {
      return item.kind
    }
  }
}

function applyReasoning(
  msg: JsonRecord,
  entries: ReadonlyArray<Entry>,
  hadReasoning: boolean,
  defaultField: string,
): void {
  const original = entries.find((e) => e.orig)
  if (original && entries.length === 1 && !original.changed) return
  const texts = entries.filter((e) => !e.item.opaque).map((e) => e.item.content)
  if (texts.length === 0) {
    if (hadReasoning && !original) {
      for (const field of REASONING_FIELDS) {
        if (typeof msg[field] === "string") Reflect.deleteProperty(msg, field)
      }
      Reflect.deleteProperty(msg, "reasoning_opaque")
    }
    return
  }
  msg[reasoningFieldOf(msg) ?? defaultField] = texts.join("\n")
}

function applyContent(
  msg: JsonRecord,
  origContent: unknown,
  entries: ReadonlyArray<Entry>,
  hadWhole: boolean,
  isNew: boolean,
): void {
  if (Array.isArray(origContent) && origContent.length > 0) {
    const parts = entries.map((e) => {
      if (e.orig?.ref.t === "part") {
        const part: unknown = origContent[e.orig.ref.j]
        return e.changed && isRecord(part) ?
            { ...part, text: e.item.content }
          : part
      }
      return { type: "text", text: e.item.content }
    })
    msg.content = parts.length > 0 ? parts : null
    return
  }
  if (entries.length === 0) {
    if (isNew || hadWhole) msg.content = null
    return
  }
  const [first] = entries
  if (entries.length === 1 && first.orig && !first.changed) return
  msg.content = entries.map((e) => e.item.content).join("\n")
}

function applyToolCalls(
  msg: JsonRecord,
  origCalls: Array<unknown>,
  entries: ReadonlyArray<Entry>,
): void {
  const calls = entries.map((e) => {
    if (e.orig?.ref.t === "tc") {
      const tc = origCalls[e.orig.ref.j]
      if (!e.changed || !isRecord(tc)) return tc
      const fn = isRecord(tc.function) ? tc.function : {}
      return {
        ...tc,
        id: e.item.toolCallId ?? tc.id,
        function: {
          ...fn,
          name: requireToolName(e),
          arguments: validatedToolArguments(e, false).text,
        },
      }
    }
    return {
      id: e.item.toolCallId?.trim() || generatedId("call_"),
      type: "function",
      function: {
        name: requireToolName(e),
        arguments: validatedToolArguments(e, false).text,
      },
    }
  })
  if (calls.length > 0) msg.tool_calls = calls
  else if (origCalls.length > 0) Reflect.deleteProperty(msg, "tool_calls")
}

function applyToolMessageIds(
  msg: JsonRecord,
  entries: ReadonlyArray<Entry>,
): void {
  const [first] = entries
  if (msg.role !== "tool" || entries.length === 0) return
  if (!first.orig) {
    msg.tool_call_id = requireToolCallId(first.item)
    if (first.item.toolName) msg.name = first.item.toolName
    return
  }
  if (!first.changed) return
  if (first.item.toolCallId !== first.orig.item.toolCallId) {
    msg.tool_call_id = requireToolCallId(first.item)
  }
  if (first.item.toolName !== first.orig.item.toolName) {
    if (first.item.toolName) msg.name = first.item.toolName
    else Reflect.deleteProperty(msg, "name")
  }
}

function buildChatMessage(
  orig: unknown,
  role: string,
  entries: ReadonlyArray<Entry>,
  refs: ReadonlySet<NodeRef["t"]>,
  defaultReasoningField: string,
): unknown {
  if (orig !== undefined && !isRecord(orig)) return orig
  const msg: JsonRecord = orig ? { ...orig } : { role }
  const thinking: Array<Entry> = []
  const calls: Array<Entry> = []
  const texts: Array<Entry> = []
  for (const e of entries) {
    if (e.item.kind === "thinking") thinking.push(e)
    else if (e.item.kind === "tool_call") calls.push(e)
    else texts.push(e)
  }
  applyReasoning(msg, thinking, refs.has("think"), defaultReasoningField)
  applyContent(msg, orig?.content, texts, refs.has("whole"), !orig)
  applyToolCalls(msg, asArray(orig?.tool_calls), calls)
  applyToolMessageIds(msg, texts)
  return msg
}

function defaultReasoningField(messages: ReadonlyArray<unknown>): string {
  for (const msg of messages) {
    const field = isRecord(msg) ? reasoningFieldOf(msg) : undefined
    if (field) return field
  }
  return DEFAULT_REASONING_FIELD
}

const NO_REFS: ReadonlySet<NodeRef["t"]> = new Set()

// ─── Requests ───────────────────────────────────────────────────────────────

function parseRequestItems(body: JsonRecord): Array<ParsedItem> {
  return asArray(body.messages).flatMap((msg, i) =>
    parseChatMessage(msg, `msg-${i}`, `m${i}`, "user"),
  )
}

export function parseChatRequestView(body: JsonRecord): CanonicalView {
  return {
    protocol: "chat_completions",
    phase: "request",
    model: asString(body.model),
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    items: parseRequestItems(body).map((p) => p.item),
    editable: true,
  }
}

export function patchChatRequest(
  body: JsonRecord,
  edited: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  const messages = asArray(body.messages)
  const parsed = parseRequestItems(body)
  const { entries, unchanged } = classifyEdits(parsed, edited)
  if (unchanged) return undefined
  const refs = refsByContainer(parsed)
  const reasoningField = defaultReasoningField(messages)
  const segments = groupSegments(entries, {
    roleForNew: chatRoleForKind,
    canJoin: (segment, item, inside) => {
      if (item.kind === "tool_call") return segment.role === "assistant"
      if (item.kind === "thinking") {
        return (
          segment.role === "assistant"
          && !segment.entries.some((e) => e.item.kind === "thinking")
        )
      }
      if (item.kind === "tool_result") return false
      return inside && segment.role === chatRoleForKind(item)
    },
  })
  return {
    ...body,
    messages: segments.map((segment) =>
      buildChatMessage(
        segment.key === undefined ?
          undefined
        : messages[Number(segment.key.slice(1))],
        segment.role,
        segment.entries,
        segment.key === undefined ?
          NO_REFS
        : (refs.get(segment.key) ?? NO_REFS),
        reasoningField,
      ),
    ),
  }
}

// ─── Responses (JSON and the final object of a stream) ──────────────────────

function parseResponseItems(body: JsonRecord): Array<ParsedItem> {
  const choices = asArray(body.choices)
  return choices.flatMap((choice, c) =>
    isRecord(choice) ?
      parseChatMessage(
        choice.message ?? {},
        `out-${c}`,
        `c${c}`,
        "assistant",
        choices.length > 1 ? ` (choice ${c + 1})` : "",
      )
    : [],
  )
}

export function parseChatResponseView(
  body: JsonRecord,
  stream: boolean,
): CanonicalView {
  const first = asArray(body.choices).find((c): c is JsonRecord => isRecord(c))
  return {
    protocol: "chat_completions",
    phase: "response",
    model: asString(body.model),
    stream,
    stopReason: first ? asString(first.finish_reason) : undefined,
    items: parseResponseItems(body).map((p) => p.item),
    editable: true,
  }
}

const RESPONSE_KINDS = new Set(["assistant", "thinking", "tool_call"])

export function patchChatResponse(
  body: JsonRecord,
  edited: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  const parsed = parseResponseItems(body)
  const { entries, unchanged } = classifyEdits(parsed, edited)
  if (unchanged) return undefined
  const refs = refsByContainer(parsed)
  const original = asArray(body.choices)
  const choices =
    original.length > 0 ?
      original
    : [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ]

  // New items join the choice of the item before them (or the first choice).
  const byChoice = new Map<number, Array<Entry>>()
  const firstOrig = entries.find((e) => e.orig)?.orig
  let current = firstOrig ? Number(firstOrig.container.slice(1)) : 0
  for (const e of entries) {
    if (e.orig) current = Number(e.orig.container.slice(1))
    else if (!RESPONSE_KINDS.has(e.item.kind)) {
      throw new CanonicalEditError(
        `A ${e.item.kind} item cannot be added to a model response.`,
      )
    }
    const list = byChoice.get(current) ?? []
    list.push(e)
    byChoice.set(current, list)
  }

  const reasoningField = defaultReasoningField(
    choices.map((choice) => (isRecord(choice) ? choice.message : undefined)),
  )
  return {
    ...body,
    choices: choices.map((choice, c) => {
      if (!isRecord(choice)) return choice
      const own = byChoice.get(c) ?? []
      const before = parsed.filter((p) => p.container === `c${c}`)
      // An untouched choice stays verbatim, whatever shape its message has.
      if (
        own.length === before.length
        && own.every((e, k) => e.orig === before[k] && !e.changed)
      ) {
        return choice
      }
      const origMsg = isRecord(choice.message) ? choice.message : undefined
      const message = buildChatMessage(
        origMsg ?? { role: "assistant" },
        "assistant",
        own,
        refs.get(`c${c}`) ?? NO_REFS,
        reasoningField,
      )
      const next: JsonRecord = { ...choice, message }
      if ("finish_reason" in choice) {
        next.finish_reason = reconcileStopReason(
          choice.finish_reason,
          hasToolCalls(origMsg),
          hasToolCalls(message),
          "stop",
          "tool_calls",
        )
      }
      return next
    }),
  }
}

// ─── Streams ────────────────────────────────────────────────────────────────

interface ToolCallAcc {
  id?: string
  type?: string
  name: string
  arguments: string
}

interface ChoiceAcc {
  index: number
  role?: string
  content?: string
  refusal?: string
  reasoningField?: string
  reasoning?: string
  reasoningOpaque?: unknown
  toolCalls: Map<number, ToolCallAcc>
  finish?: string
}

export interface ChatStream {
  /** The completion the stream describes, as a non-streaming object. */
  final: JsonRecord
  /** Top-level fields repeated on every chunk (id, created, model, ...). */
  chunkBase: JsonRecord
  /** Choice-less chunks (e.g. prompt filter results), re-emitted verbatim. */
  leading: Array<string>
  trailing: Array<string>
  usageChunk?: string
  inlineUsage?: unknown
  done: boolean
  readOnlyReason?: string
}

function accumulateDelta(acc: ChoiceAcc, delta: JsonRecord): void {
  if (typeof delta.role === "string") acc.role = delta.role
  if (typeof delta.content === "string") {
    acc.content = (acc.content ?? "") + delta.content
  }
  if (typeof delta.refusal === "string") {
    acc.refusal = (acc.refusal ?? "") + delta.refusal
  }
  for (const field of REASONING_FIELDS) {
    if (typeof delta[field] === "string") {
      acc.reasoningField ??= field
      acc.reasoning = (acc.reasoning ?? "") + delta[field]
    }
  }
  if (delta.reasoning_opaque !== undefined && delta.reasoning_opaque !== null) {
    acc.reasoningOpaque =
      (
        typeof acc.reasoningOpaque === "string"
        && typeof delta.reasoning_opaque === "string"
      ) ?
        acc.reasoningOpaque + delta.reasoning_opaque
      : delta.reasoning_opaque
  }
  for (const tc of asArray(delta.tool_calls)) {
    if (!isRecord(tc)) continue
    const index = typeof tc.index === "number" ? tc.index : 0
    const call = acc.toolCalls.get(index) ?? { name: "", arguments: "" }
    if (typeof tc.id === "string") call.id = tc.id
    if (typeof tc.type === "string") call.type = tc.type
    const fn = isRecord(tc.function) ? tc.function : {}
    const name = asString(fn.name)
    if (name && name !== call.name) call.name += name
    const args = asString(fn.arguments)
    if (args) call.arguments += args
    acc.toolCalls.set(index, call)
  }
}

function finalChoice(acc: ChoiceAcc): JsonRecord {
  const message: JsonRecord = {
    role: acc.role ?? "assistant",
    content: acc.content ?? null,
  }
  if (acc.reasoning !== undefined) {
    message[acc.reasoningField ?? DEFAULT_REASONING_FIELD] = acc.reasoning
  }
  if (acc.reasoningOpaque !== undefined) {
    message.reasoning_opaque = acc.reasoningOpaque
  }
  if (acc.refusal !== undefined) message.refusal = acc.refusal
  if (acc.toolCalls.size > 0) {
    message.tool_calls = [...acc.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        ...(call.id ? { id: call.id } : {}),
        type: call.type ?? "function",
        function: { name: call.name, arguments: call.arguments },
      }))
  }
  return { index: acc.index, message, finish_reason: acc.finish ?? null }
}

export function parseChatStream(events: ReadonlyArray<SseEvent>): ChatStream {
  let readOnlyReason: string | undefined
  let chunkBase: JsonRecord | undefined
  const leading: Array<string> = []
  const trailing: Array<string> = []
  let usageChunk: string | undefined
  let inlineUsage: unknown
  let done = false
  const accs = new Map<number, ChoiceAcc>()

  for (const ev of events) {
    if (ev.data === "[DONE]") {
      done = true
      continue
    }
    if (!ev.data) continue
    let payload: unknown
    try {
      payload = JSON.parse(ev.data)
    } catch {
      readOnlyReason ??= "The stream contains a chunk that is not JSON."
      continue
    }
    if (!isRecord(payload)) {
      readOnlyReason ??=
        "The stream contains a chunk that is not a JSON object."
      continue
    }
    if (payload.error !== undefined && payload.error !== null) {
      readOnlyReason ??=
        "The stream contains an error event that structured edits cannot reproduce."
      continue
    }
    const choices = asArray(payload.choices)
    if (choices.length === 0) {
      if (payload.usage !== undefined && payload.usage !== null) {
        usageChunk = ev.data
      } else {
        ;(chunkBase ? trailing : leading).push(ev.data)
      }
      continue
    }
    if (!chunkBase) {
      chunkBase = { ...payload }
      Reflect.deleteProperty(chunkBase, "choices")
      if (chunkBase.usage !== null) Reflect.deleteProperty(chunkBase, "usage")
    }
    if (payload.usage !== undefined && payload.usage !== null) {
      inlineUsage = payload.usage
    }
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const index = typeof choice.index === "number" ? choice.index : 0
      const acc: ChoiceAcc = accs.get(index) ?? { index, toolCalls: new Map() }
      if (isRecord(choice.delta)) accumulateDelta(acc, choice.delta)
      if (typeof choice.finish_reason === "string") {
        acc.finish = choice.finish_reason
      }
      accs.set(index, acc)
    }
  }

  const base = chunkBase ?? {}
  const final: JsonRecord = { ...base, object: "chat.completion" }
  Reflect.deleteProperty(final, "usage")
  final.choices = [...accs.values()]
    .sort((a, b) => a.index - b.index)
    .map((acc) => finalChoice(acc))
  let usage = inlineUsage
  if (usage === undefined && usageChunk) {
    usage = (JSON.parse(usageChunk) as JsonRecord).usage
  }
  if (usage !== undefined) final.usage = usage

  if (!chunkBase) {
    readOnlyReason ??= "The stream has no completion chunks."
  } else if ([...accs.values()].some((acc) => acc.finish === undefined)) {
    readOnlyReason ??=
      "The stream ended without a finish_reason (truncated); structured edits are disabled."
  }
  return {
    final,
    chunkBase: base,
    leading,
    trailing,
    usageChunk,
    inlineUsage,
    done,
    readOnlyReason,
  }
}

export function emitChatStream(stream: ChatStream, final: JsonRecord): string {
  const out: Array<string> = []
  const data = (raw: string) => out.push(`data: ${raw}\n\n`)
  const chunk = (choice: JsonRecord, usage?: unknown) => {
    data(
      JSON.stringify({
        ...stream.chunkBase,
        choices: [choice],
        ...(usage === undefined ? {} : { usage }),
      }),
    )
  }

  for (const raw of stream.leading) data(raw)
  const choices = asArray(final.choices).filter((c) => isRecord(c))
  for (const [n, choice] of choices.entries()) {
    const index = typeof choice.index === "number" ? choice.index : n
    const msg = isRecord(choice.message) ? choice.message : {}
    // eslint-disable-next-line unicorn/consistent-function-scoping -- captures the choice index.
    const delta = (d: JsonRecord) => {
      chunk({ index, delta: d, finish_reason: null })
    }
    delta({ role: asString(msg.role) ?? "assistant" })
    const field = reasoningFieldOf(msg)
    if (field) delta({ [field]: msg[field] })
    if (hasOpaqueReasoning(msg))
      delta({ reasoning_opaque: msg.reasoning_opaque })
    if (typeof msg.content === "string" && msg.content) {
      delta({ content: msg.content })
    }
    if (typeof msg.refusal === "string" && msg.refusal) {
      delta({ refusal: msg.refusal })
    }
    for (const [j, tc] of asArray(msg.tool_calls).entries()) {
      delta({ tool_calls: [{ index: j, ...(isRecord(tc) ? tc : {}) }] })
    }
    chunk(
      { index, delta: {}, finish_reason: choice.finish_reason ?? null },
      n === choices.length - 1 ? stream.inlineUsage : undefined,
    )
  }
  for (const raw of stream.trailing) data(raw)
  if (stream.usageChunk) data(stream.usageChunk)
  if (stream.done) data("[DONE]")
  return out.join("")
}
