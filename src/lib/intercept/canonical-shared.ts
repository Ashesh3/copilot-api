import { isRecord } from "~/lib/native-passthrough"

import type { CanonicalItem, CanonicalItemKind } from "./types"

export type JsonRecord = Record<string, unknown>

/** An operator or assistant edit that cannot be written back faithfully. */
export class CanonicalEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CanonicalEditError"
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function asArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : []
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function roleToKind(role: string | undefined): CanonicalItemKind {
  switch (role) {
    case "system":
    case "developer":
    case "user":
    case "assistant": {
      return role
    }
    case "tool": {
      return "tool_result"
    }
    default: {
      return "other"
    }
  }
}

/** Short human-readable stand-in for a node whose content cannot be shown. */
export function placeholderFor(node: unknown): string {
  if (!isRecord(node)) return "[unrecognized]"
  const type = asString(node.type) ?? "part"
  switch (type) {
    case "image":
    case "image_url":
    case "input_image": {
      return "[image]"
    }
    case "input_audio": {
      return "[audio]"
    }
    case "document": {
      const title = asString(node.title)
      return title ? `[document: ${title}]` : "[document]"
    }
    case "file":
    case "input_file": {
      const name =
        asString(node.filename)
        ?? (isRecord(node.file) ? asString(node.file.filename) : undefined)
      return name ? `[file: ${name}]` : "[file]"
    }
    case "redacted_thinking": {
      return "[redacted thinking]"
    }
    default: {
      return `[${type}]`
    }
  }
}

export function generatedId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
}

/**
 * Pointer from a canonical item to the wire node it was parsed from, relative
 * to its container (a message, choice, or top-level input/output item).
 */
export type NodeRef =
  /** The container's string content (or a string field such as `instructions`). */
  | { t: "whole" }
  /** Element `j` of the container's content array. */
  | { t: "part"; j: number }
  /** A Chat message's reasoning fields. */
  | { t: "think" }
  /** Element `j` of a Chat message's `tool_calls`. */
  | { t: "tc"; j: number }
  /** The container node itself (non-message Responses items). */
  | { t: "node" }

export interface ParsedItem {
  item: CanonicalItem
  /** Items sharing a container key live in the same wire node. */
  container: string
  /** Role of the wire node holding the item. */
  containerRole: string
  /** True when new text may become an extra content part of the container. */
  partsContainer: boolean
  ref: NodeRef
}

export interface OrigEntry {
  orig: ParsedItem
  item: CanonicalItem
  changed: boolean
}

export interface NewEntry {
  orig?: undefined
  changed?: undefined
  item: CanonicalItem
}

export type Entry = OrigEntry | NewEntry

function fieldsDiffer(orig: CanonicalItem, item: CanonicalItem): boolean {
  return (
    item.content !== orig.content
    || item.toolName !== orig.toolName
    || item.toolCallId !== orig.toolCallId
    || (item.toolArguments !== undefined
      && item.toolArguments !== orig.toolArguments)
  )
}

/**
 * Matches edited items against the parse of the body they will patch. Items
 * whose ID is unknown, or whose kind changed, become insertions.
 */
export function classifyEdits(
  parsed: ReadonlyArray<ParsedItem>,
  edited: ReadonlyArray<CanonicalItem>,
): { entries: Array<Entry>; unchanged: boolean } {
  const byId = new Map(parsed.map((p) => [p.item.id, p]))
  const seen = new Set<string>()
  const entries: Array<Entry> = []
  let unchanged = edited.length === parsed.length

  for (const [index, item] of edited.entries()) {
    if (seen.has(item.id)) {
      throw new CanonicalEditError(`Item ID "${item.id}" appears twice.`)
    }
    seen.add(item.id)
    const orig = byId.get(item.id)
    if (!orig) {
      if (item.opaque) {
        throw new CanonicalEditError(
          `"${item.label}" is a read-only item that does not exist in this payload.`,
        )
      }
      entries.push({ item })
      unchanged = false
      continue
    }
    const differs = fieldsDiffer(orig.item, item)
    if (orig.item.opaque) {
      if (differs || item.kind !== orig.item.kind) {
        throw new CanonicalEditError(
          `"${orig.item.label}" (${orig.item.id}) is read-only; it can be removed but not edited.`,
        )
      }
      entries.push({ orig, item: orig.item, changed: false })
    } else if (item.kind === orig.item.kind) {
      entries.push({ orig, item, changed: differs })
      if (differs) unchanged = false
    } else {
      // A kind change replaces the node with a new one at the same position.
      entries.push({ item })
      unchanged = false
    }
    if (parsed[index]?.item.id !== item.id) unchanged = false
  }
  return { entries, unchanged }
}

export function requireToolName(entry: Entry): string {
  const name = entry.item.toolName?.trim()
  if (!name) {
    throw new CanonicalEditError(
      `Tool call ${entry.item.id} needs a tool name.`,
    )
  }
  return name
}

export function requireToolCallId(item: CanonicalItem): string {
  const id = item.toolCallId?.trim()
  if (!id) {
    throw new CanonicalEditError(
      `Tool result ${item.id} needs the ID of the tool call it answers.`,
    )
  }
  return id
}

/** Arguments text the edit intends, whichever of the two fields was edited. */
function toolArgumentsText(entry: Entry): string {
  const { item } = entry
  if (!entry.orig) return item.toolArguments ?? item.content
  const before = entry.orig.item
  if (
    item.toolArguments !== undefined
    && item.toolArguments !== before.toolArguments
  ) {
    return item.toolArguments
  }
  if (item.content !== before.content) return item.content
  return before.toolArguments ?? before.content
}

/** Validated tool arguments; Anthropic `tool_use.input` must be an object. */
export function validatedToolArguments(
  entry: Entry,
  requireObject: boolean,
): { text: string; value: unknown } {
  const text = toolArgumentsText(entry)
  const name = entry.item.toolName ?? entry.item.id
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new CanonicalEditError(
      `Tool call "${name}" arguments are not valid JSON: ${(error as Error).message}`,
    )
  }
  if (requireObject && !isRecord(value)) {
    throw new CanonicalEditError(
      `Tool call "${name}" arguments must be a JSON object.`,
    )
  }
  return { text, value }
}

export interface Segment {
  /** Original container key; undefined for a container created by the edit. */
  key?: string
  /** The original container already appeared earlier in the output. */
  split: boolean
  role: string
  partsContainer: boolean
  entries: Array<Entry>
}

export interface SegmentPolicy {
  roleForNew: (item: CanonicalItem) => string
  /**
   * Whether a new item may join the open container. `inside` is true when the
   * next original item belongs to that same container.
   */
  canJoin: (segment: Segment, item: CanonicalItem, inside: boolean) => boolean
}

/** Groups ordered entries into output containers (messages or items). */
export function groupSegments(
  entries: ReadonlyArray<Entry>,
  policy: SegmentPolicy,
): Array<Segment> {
  const nextOrigContainer: Array<string | undefined> = []
  let upcoming: string | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    nextOrigContainer[i] = upcoming
    const orig = entries[i].orig
    if (orig) upcoming = orig.container
  }

  const segments: Array<Segment> = []
  const emitted = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    const last = segments.at(-1)
    if (entry.orig) {
      const key = entry.orig.container
      if (last?.key === key) {
        last.entries.push(entry)
        continue
      }
      segments.push({
        key,
        split: emitted.has(key),
        role: entry.orig.containerRole,
        partsContainer: entry.orig.partsContainer,
        entries: [entry],
      })
      emitted.add(key)
      continue
    }
    const inside = last?.key !== undefined && nextOrigContainer[i] === last.key
    if (last && policy.canJoin(last, entry.item, inside)) {
      last.entries.push(entry)
      continue
    }
    segments.push({
      split: false,
      role: policy.roleForNew(entry.item),
      partsContainer: false,
      entries: [entry],
    })
  }
  return segments
}

/** Original node refs present per container, e.g. whether it had reasoning. */
export function refsByContainer(
  parsed: ReadonlyArray<ParsedItem>,
): Map<string, Set<NodeRef["t"]>> {
  const refs = new Map<string, Set<NodeRef["t"]>>()
  for (const p of parsed) {
    const set = refs.get(p.container) ?? new Set<NodeRef["t"]>()
    set.add(p.ref.t)
    refs.set(p.container, set)
  }
  return refs
}

/** Swaps the normal and tool-use stop reasons when tool-call presence changed. */
// eslint-disable-next-line max-params
export function reconcileStopReason(
  reason: unknown,
  hadToolCalls: boolean,
  hasToolCalls: boolean,
  normal: string,
  toolUse: string,
): unknown {
  if (hadToolCalls === hasToolCalls) return reason
  if (hasToolCalls && reason === normal) return toolUse
  if (!hasToolCalls && reason === toolUse) return normal
  return reason
}

export const TEXT_KINDS: ReadonlySet<CanonicalItemKind> = new Set([
  "system",
  "developer",
  "user",
  "assistant",
])

export function stringifyLike(original: string, value: unknown): string {
  return /^\s*[[{]\s*\n/.test(original) ?
      JSON.stringify(value, null, 2)
    : JSON.stringify(value)
}

export interface SseEvent {
  event?: string
  data: string
}

export function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}
