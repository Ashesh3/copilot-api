/* eslint-disable complexity */
import { isRecord } from "~/lib/native-passthrough"

import type { CanonicalItem, CanonicalView, InterceptPhase } from "./types"

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
  type ParsedItem,
  placeholderFor,
  requireToolCallId,
  requireToolName,
  roleToKind,
  type Segment,
  type SseEvent,
  sseEvent,
  TEXT_KINDS,
  validatedToolArguments,
} from "./canonical-shared"

const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"])

/** Field holding a message part's editable text, if it has one. */
function partTextField(part: unknown): "text" | "refusal" | undefined {
  if (!isRecord(part)) return undefined
  if (TEXT_PART_TYPES.has(String(part.type)) && typeof part.text === "string") {
    return "text"
  }
  if (part.type === "refusal" && typeof part.refusal === "string") {
    return "refusal"
  }
  return undefined
}

function summaryText(summary: unknown): string {
  return asArray(summary)
    .map((s) => (isRecord(s) ? (asString(s.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

function contentSummary(content: unknown): string {
  return asArray(content)
    .map((part) => {
      const field = partTextField(part)
      return field ? String((part as JsonRecord)[field]) : placeholderFor(part)
    })
    .join("\n")
}

function parseNode(node: JsonRecord, id: string): CanonicalItem {
  const type = asString(node.type)
  switch (type) {
    case "function_call": {
      const name = asString(node.name) ?? ""
      const args = asString(node.arguments) ?? ""
      const encrypted = asArray(node.encrypted_function_args).length > 0
      const namespace = asString(node.namespace)
      return {
        id,
        kind: "tool_call",
        role: "assistant",
        label: `Tool Call: ${namespace ? `${namespace} / ` : ""}${name || "tool"}`,
        content: encrypted ? "[encrypted arguments]" : args,
        toolName: name,
        toolCallId: asString(node.call_id),
        ...(encrypted ? { opaque: true } : { toolArguments: args }),
      }
    }
    case "function_call_output": {
      const editable = typeof node.output === "string"
      return {
        id,
        kind: "tool_result",
        role: "tool",
        label: "Tool Result",
        content:
          editable ? (node.output as string) : contentSummary(node.output),
        toolCallId: asString(node.call_id),
        ...(editable ? {} : { opaque: true }),
      }
    }
    case "reasoning": {
      const text = summaryText(node.summary)
      const opaque =
        (typeof node.encrypted_content === "string"
          && node.encrypted_content !== "")
        || asArray(node.content).length > 0
        || asArray(node.summary).length > 1
      return {
        id,
        kind: "thinking",
        role: "assistant",
        label: "Reasoning",
        content: opaque && !text ? "[encrypted reasoning]" : text,
        ...(opaque ? { opaque: true } : {}),
      }
    }
    case "custom_tool_call": {
      const name = asString(node.name)
      return {
        id,
        kind: "tool_call",
        role: "assistant",
        label: `Custom Tool Call: ${name ?? "tool"}`,
        content: asString(node.input) ?? placeholderFor(node),
        toolName: name,
        toolCallId: asString(node.call_id),
        opaque: true,
      }
    }
    case "custom_tool_call_output": {
      return {
        id,
        kind: "tool_result",
        role: "tool",
        label: "Custom Tool Result",
        content: asString(node.output) ?? contentSummary(node.output),
        toolCallId: asString(node.call_id),
        opaque: true,
      }
    }
    default: {
      return {
        id,
        kind: "other",
        label: `Item: ${type ?? "unknown"}`,
        content: placeholderFor(node),
        opaque: true,
      }
    }
  }
}

function isMessage(node: JsonRecord): boolean {
  return node.type === "message" || (node.type === undefined && "role" in node)
}

function parseItems(
  list: ReadonlyArray<unknown>,
  prefix: string,
  defaultRole: string,
): Array<ParsedItem> {
  return list.flatMap((node, k): Array<ParsedItem> => {
    const container = `i${k}`
    const id = `${prefix}-${k}`
    if (!isRecord(node) || !isMessage(node)) {
      return [
        {
          item:
            isRecord(node) ?
              parseNode(node, id)
            : {
                id,
                kind: "other",
                label: "Item",
                content: placeholderFor(node),
                opaque: true,
              },
          container,
          containerRole: "",
          partsContainer: false,
          ref: { t: "node" },
        },
      ]
    }
    const role = asString(node.role) ?? defaultRole
    const kind = roleToKind(role)
    const label = capitalize(role)
    const parts = asArray(node.content)
    if (typeof node.content === "string" || parts.length === 0) {
      return [
        {
          item: {
            id,
            kind,
            role,
            label,
            content: typeof node.content === "string" ? node.content : "",
          },
          container,
          containerRole: role,
          partsContainer: false,
          ref: { t: "whole" },
        },
      ]
    }
    return parts.map((part, j) => {
      const field = partTextField(part)
      return {
        item:
          field ?
            {
              id: `${id}-p-${j}`,
              kind,
              role,
              label: field === "refusal" ? `${label} (refusal)` : label,
              content: String((part as JsonRecord)[field]),
            }
          : {
              id: `${id}-p-${j}`,
              kind,
              role,
              label,
              content: placeholderFor(part),
              opaque: true,
            },
        container,
        containerRole: role,
        partsContainer: true,
        ref: { t: "part", j },
      }
    })
  })
}

function newPart(
  role: string,
  text: string,
  phase: InterceptPhase,
): JsonRecord {
  if (role !== "assistant") return { type: "input_text", text }
  return {
    type: "output_text",
    text,
    ...(phase === "response" ? { annotations: [] } : {}),
  }
}

function newItem(entry: Entry, phase: InterceptPhase): JsonRecord {
  const { item } = entry
  switch (item.kind) {
    case "tool_call": {
      const call = {
        type: "function_call",
        call_id: item.toolCallId?.trim() || generatedId("call_"),
        name: requireToolName(entry),
        arguments: validatedToolArguments(entry, false).text,
      }
      return phase === "response" ?
          { id: generatedId("fc_"), ...call, status: "completed" }
        : call
    }
    case "tool_result": {
      if (phase === "response") break
      return {
        type: "function_call_output",
        call_id: requireToolCallId(item),
        output: item.content,
      }
    }
    case "thinking": {
      throw new CanonicalEditError(
        "Reasoning items cannot be inserted; upstream issues and verifies them.",
      )
    }
    case "other": {
      throw new CanonicalEditError(`Item ${item.id} has no insertable kind.`)
    }
    default: {
      if (phase === "request") {
        return {
          type: "message",
          role: item.kind,
          content: [newPart(item.kind, item.content, phase)],
        }
      }
      if (item.kind !== "assistant") break
      return {
        id: generatedId("msg_"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [newPart("assistant", item.content, phase)],
      }
    }
  }
  throw new CanonicalEditError(
    `A ${item.kind} item cannot be added to a model response.`,
  )
}

function patchNode(node: JsonRecord, entry: Entry): JsonRecord {
  const { item } = entry
  switch (node.type) {
    case "function_call": {
      return {
        ...node,
        name: requireToolName(entry),
        call_id: item.toolCallId ?? node.call_id,
        arguments: validatedToolArguments(entry, false).text,
      }
    }
    case "function_call_output": {
      return {
        ...node,
        call_id: item.toolCallId ?? node.call_id,
        output: item.content,
      }
    }
    case "reasoning": {
      const [first] = asArray(node.summary)
      return {
        ...node,
        summary:
          item.content ?
            [
              {
                ...(isRecord(first) ? first : { type: "summary_text" }),
                text: item.content,
              },
            ]
          : [],
      }
    }
    default: {
      return node
    }
  }
}

function buildItem(
  orig: unknown,
  segment: Segment,
  phase: InterceptPhase,
): unknown {
  const [first] = segment.entries
  if (!first.orig) return newItem(first, phase)
  if (!isRecord(orig)) return orig
  if (first.orig.ref.t === "node") {
    return first.changed ? patchNode(orig, first) : orig
  }
  const node: JsonRecord = { ...orig }
  // A message split around another item keeps its ID only on the first half.
  if (segment.split) Reflect.deleteProperty(node, "id")
  if (first.orig.ref.t === "whole") {
    if (first.changed) {
      node.content =
        typeof orig.content === "string" ?
          first.item.content
        : [newPart(segment.role, first.item.content, phase)]
    }
    return node
  }
  const parts = asArray(orig.content)
  node.content = segment.entries.map((e) => {
    if (e.orig?.ref.t !== "part") {
      return newPart(segment.role, e.item.content, phase)
    }
    const part = parts[e.orig.ref.j]
    const field = partTextField(part)
    return e.changed && field ?
        { ...(part as JsonRecord), [field]: e.item.content }
      : part
  })
  return node
}

function patchItems(
  list: ReadonlyArray<unknown>,
  entries: ReadonlyArray<Entry>,
  phase: InterceptPhase,
): Array<unknown> {
  const segments = groupSegments(entries, {
    roleForNew: (item) => item.kind,
    canJoin: (segment, item, inside) =>
      inside
      && segment.partsContainer
      && TEXT_KINDS.has(item.kind)
      && segment.role === item.kind,
  })
  return segments.map((segment) =>
    buildItem(
      segment.key === undefined ?
        undefined
      : list[Number(segment.key.slice(1))],
      segment,
      phase,
    ),
  )
}

// ─── Requests ───────────────────────────────────────────────────────────────

/** A string `input` is treated as a single user message. */
function inputList(body: JsonRecord): Array<unknown> {
  return typeof body.input === "string" ?
      [{ type: "message", role: "user", content: body.input }]
    : asArray(body.input)
}

function parseRequestItems(body: JsonRecord): Array<ParsedItem> {
  const items = parseItems(inputList(body), "in", "user")
  if (typeof body.instructions !== "string") return items
  return [
    {
      item: {
        id: "sys-0",
        kind: "system",
        role: "system",
        label: "Instructions",
        content: body.instructions,
      },
      container: "instr",
      containerRole: "system",
      partsContainer: false,
      ref: { t: "whole" },
    },
    ...items,
  ]
}

export function parseResponsesRequestView(body: JsonRecord): CanonicalView {
  return {
    protocol: "responses",
    phase: "request",
    model: asString(body.model),
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    items: parseRequestItems(body).map((p) => p.item),
    editable: true,
  }
}

export function patchResponsesRequest(
  body: JsonRecord,
  edited: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  const { entries, unchanged } = classifyEdits(parseRequestItems(body), edited)
  if (unchanged) return undefined
  const next: JsonRecord = { ...body }

  const instructions = entries.find((e) => e.orig?.container === "instr")
  if (typeof body.instructions === "string") {
    if (!instructions) Reflect.deleteProperty(next, "instructions")
    else next.instructions = instructions.item.content
  }

  const input = patchItems(
    inputList(body),
    entries.filter((e) => e !== instructions),
    "request",
  )
  const [only] = input
  if (
    typeof body.input === "string"
    && input.length === 1
    && isRecord(only)
    && only.role === "user"
    && typeof only.content === "string"
  ) {
    next.input = only.content
  } else if (body.input !== undefined || input.length > 0) {
    next.input = input
  }
  return next
}

// ─── Responses (JSON and the final object of a stream) ──────────────────────

export function parseResponsesResponseView(
  response: JsonRecord,
  stream: boolean,
): CanonicalView {
  return {
    protocol: "responses",
    phase: "response",
    model: asString(response.model),
    stream,
    stopReason: asString(response.status),
    items: parseItems(asArray(response.output), "out", "assistant").map(
      (p) => p.item,
    ),
    editable: true,
  }
}

/** The SDK's `output_text`: all assistant output_text parts, concatenated. */
function outputText(output: ReadonlyArray<unknown>): string {
  return output
    .filter((node) => isRecord(node) && node.type === "message")
    .flatMap((node) => asArray((node as JsonRecord).content))
    .map((part) =>
      isRecord(part) && part.type === "output_text" ?
        (asString(part.text) ?? "")
      : "",
    )
    .join("")
}

export function patchResponsesResponse(
  response: JsonRecord,
  edited: ReadonlyArray<CanonicalItem>,
): JsonRecord | undefined {
  const list = asArray(response.output)
  const { entries, unchanged } = classifyEdits(
    parseItems(list, "out", "assistant"),
    edited,
  )
  if (unchanged) return undefined
  const output = patchItems(list, entries, "response")
  const next: JsonRecord = { ...response, output }
  if ("output_text" in response) {
    const text = outputText(output)
    if (text) next.output_text = text
    else Reflect.deleteProperty(next, "output_text")
  }
  return next
}

// ─── Streams ────────────────────────────────────────────────────────────────

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.done",
])

export interface ResponsesStream {
  /** The response the stream describes, as a non-streaming object. */
  final: JsonRecord
  created?: JsonRecord
  inProgress?: JsonRecord
  terminalType: string
  firstSequence: number
  readOnlyReason?: string
}

export function parseResponsesStream(
  events: ReadonlyArray<SseEvent>,
): ResponsesStream {
  let readOnlyReason: string | undefined
  let created: JsonRecord | undefined
  let inProgress: JsonRecord | undefined
  let terminal: { type: string; payload: JsonRecord } | undefined
  let firstSequence: number | undefined
  const doneItems = new Map<number, unknown>()

  for (const ev of events) {
    if (!ev.data || ev.data === "[DONE]") continue
    let payload: unknown
    try {
      payload = JSON.parse(ev.data)
    } catch {
      readOnlyReason ??= "The stream contains an event that is not JSON."
      continue
    }
    if (!isRecord(payload)) continue
    const type = asString(payload.type) ?? ev.event ?? ""
    if (typeof payload.sequence_number === "number") {
      firstSequence ??= payload.sequence_number
    }
    if (type === "response.created") created = payload
    else if (type === "response.in_progress") inProgress = payload
    else if (
      type === "response.output_item.done"
      && typeof payload.output_index === "number"
    ) {
      doneItems.set(payload.output_index, payload.item)
    } else if (TERMINAL_EVENTS.has(type)) terminal = { type, payload }
    else if (type === "error") {
      readOnlyReason ??=
        "The stream contains an error event that structured edits cannot reproduce."
    }
  }

  const terminalResponse =
    isRecord(terminal?.payload.response) ? terminal.payload.response : undefined
  if (!terminalResponse) {
    readOnlyReason ??=
      "The stream ended before a terminal response event (truncated); structured edits are disabled."
  }
  const createdResponse = isRecord(created?.response) ? created.response : {}
  const final: JsonRecord = { ...(terminalResponse ?? createdResponse) }
  if (asArray(final.output).length === 0 && doneItems.size > 0) {
    final.output = [...doneItems.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item)
  }
  return {
    final,
    created,
    inProgress,
    terminalType: terminal?.type ?? "response.completed",
    firstSequence: firstSequence ?? 0,
    readOnlyReason,
  }
}

function emitItem(
  emit: (type: string, data: JsonRecord) => void,
  item: unknown,
  outputIndex: number,
): void {
  const at = {
    ...(isRecord(item) && typeof item.id === "string" ?
      { item_id: item.id }
    : {}),
    output_index: outputIndex,
  }
  const added = (snapshot: unknown) => {
    emit("response.output_item.added", {
      output_index: outputIndex,
      item: snapshot,
    })
  }
  const inProgress =
    isRecord(item) && "status" in item ? { status: "in_progress" } : {}

  if (!isRecord(item)) {
    added(item)
  } else
    switch (item.type) {
      case "message": {
        added({ ...item, ...inProgress, content: [] })
        for (const [contentIndex, part] of asArray(item.content).entries()) {
          const partAt = { ...at, content_index: contentIndex }
          const field = partTextField(part)
          const kind = field === "refusal" ? "refusal" : "output_text"
          const text = field ? String((part as JsonRecord)[field]) : undefined
          emit("response.content_part.added", {
            ...partAt,
            part: field ? { ...(part as JsonRecord), [field]: "" } : part,
          })
          if (text) emit(`response.${kind}.delta`, { ...partAt, delta: text })
          if (field) emit(`response.${kind}.done`, { ...partAt, [field]: text })
          emit("response.content_part.done", { ...partAt, part })
        }

        break
      }
      case "function_call": {
        added({ ...item, ...inProgress, arguments: "" })
        const args = asString(item.arguments) ?? ""
        if (args)
          emit("response.function_call_arguments.delta", { ...at, delta: args })
        emit("response.function_call_arguments.done", {
          ...at,
          arguments: args,
        })

        break
      }
      case "custom_tool_call": {
        added({ ...item, ...inProgress, input: "" })
        const input = asString(item.input) ?? ""
        if (input)
          emit("response.custom_tool_call_input.delta", { ...at, delta: input })
        emit("response.custom_tool_call_input.done", { ...at, input })

        break
      }
      case "reasoning": {
        added({ ...item, summary: [] })
        for (const [summaryIndex, part] of asArray(item.summary).entries()) {
          const partAt = { ...at, summary_index: summaryIndex }
          const text = isRecord(part) ? (asString(part.text) ?? "") : ""
          emit("response.reasoning_summary_part.added", {
            ...partAt,
            part: { ...(isRecord(part) ? part : {}), text: "" },
          })
          if (text)
            emit("response.reasoning_summary_text.delta", {
              ...partAt,
              delta: text,
            })
          emit("response.reasoning_summary_text.done", { ...partAt, text })
          emit("response.reasoning_summary_part.done", { ...partAt, part })
        }

        break
      }
      default: {
        added(item)
      }
    }
  emit("response.output_item.done", { output_index: outputIndex, item })
}

export function emitResponsesStream(
  stream: ResponsesStream,
  final: JsonRecord,
): string {
  const out: Array<string> = []
  let sequence = stream.firstSequence
  const emit = (type: string, data: JsonRecord) => {
    out.push(sseEvent(type, { type, sequence_number: sequence++, ...data }))
  }

  const createdResponse =
    isRecord(stream.created?.response) ?
      stream.created.response
    : {
        ...Object.fromEntries(
          ["id", "object", "created_at", "model"]
            .filter((key) => key in final)
            .map((key) => [key, final[key]]),
        ),
        status: "in_progress",
        output: [],
      }
  emit("response.created", { response: createdResponse })
  if (isRecord(stream.inProgress?.response)) {
    emit("response.in_progress", { response: stream.inProgress.response })
  }
  for (const [index, item] of asArray(final.output).entries()) {
    emitItem(emit, item, index)
  }
  emit(stream.terminalType, { response: final })
  return out.join("")
}
