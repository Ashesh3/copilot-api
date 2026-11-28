import { createHash } from "node:crypto"

import type { AssistantDiffOp, CanonicalItem } from "./types"

/** Bounds on what one Intercept session remembers. */
const MAX_ENTRIES = 10_000
const MAX_BYTES = 8 * 1024 * 1024

/** Stands for the item an operation belongs to while it sits in the cache. */
const SELF = ""

/** The cache key of operations inserted at the very start of an item list. */
export const START_KEY = "start"

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

/**
 * Each item's identity across held items: its content, plus which repeat of
 * that content it is, so a second identical message is not mistaken for the
 * first. A conversation that grows keeps the keys of its earlier items.
 */
export function itemCacheKeys(
  items: ReadonlyArray<CanonicalItem>,
): Array<string> {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const fingerprint = digest(
      JSON.stringify([
        item.kind,
        item.role ?? "",
        item.toolName ?? "",
        item.toolCallId ?? "",
        item.opaque ? item.label : "",
        item.toolArguments ?? "",
        item.content,
      ]),
    )
    const occurrence = seen.get(fingerprint) ?? 0
    seen.set(fingerprint, occurrence + 1)
    return `${fingerprint}#${occurrence}`
  })
}

/** Everything that changes what the assistant would answer for an item. */
export function assistantCacheScope(settings: {
  model: string
  reasoningEffort: string
  systemPrompt: string
  instruction: string
  messageKinds: ReadonlyArray<string>
}): string {
  return digest(
    JSON.stringify([
      settings.model,
      settings.reasoningEffort,
      settings.systemPrompt,
      settings.instruction,
      [...settings.messageKinds].sort(),
    ]),
  )
}

/** `operations` with `itemId` replaced by a placeholder, or the reverse. */
function readdress(
  operations: ReadonlyArray<AssistantDiffOp>,
  from: string,
  to: string,
): Array<AssistantDiffOp> {
  return operations.map((op) => {
    if (op.op === "insert_after") {
      return op.afterId === from ? { ...op, afterId: to } : { ...op }
    }
    return op.id === from ? { ...op, id: to } : { ...op }
  })
}

interface CacheEntry {
  operations: Array<AssistantDiffOp>
  bytes: number
}

/**
 * What AI Assist already decided for items during one Intercept session, so a
 * conversation that grows sends only its new items to the model. Results are
 * kept per item, by scope (model, effort, prompts, instruction, message
 * types); the engine clears it when Intercept turns off or the assistant
 * settings change. Bounded, oldest first out.
 */
export class AssistantSessionCache {
  private readonly entries = new Map<string, CacheEntry>()
  /** Items already shown to the model as read-only context. */
  private readonly shown = new Set<string>()
  private bytes = 0

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.shown.clear()
    this.bytes = 0
  }

  /** The operations remembered for an item, addressed to `itemId`. */
  lookup(
    scope: string,
    key: string,
    itemId: string | null,
  ): Array<AssistantDiffOp> | undefined {
    const entry = this.entries.get(`${scope}:${key}`)
    if (!entry) return undefined
    return itemId === null ?
        entry.operations.map((op) => ({ ...op }))
      : readdress(entry.operations, SELF, itemId)
  }

  /** Remember the operations decided for an item (none is a decision too). */
  remember(
    scope: string,
    key: string,
    decision: {
      itemId: string | null
      operations: ReadonlyArray<AssistantDiffOp>
    },
  ): void {
    const { itemId, operations } = decision
    const id = `${scope}:${key}`
    this.drop(id)
    const stored =
      itemId === null ?
        operations.map((op) => ({ ...op }))
      : readdress(operations, itemId, SELF)
    const bytes = id.length + JSON.stringify(stored).length
    this.entries.set(id, { operations: stored, bytes })
    this.bytes += bytes
    this.evict()
  }

  /**
   * Items of `kinds` the operator accepted changes into: handled, with
   * nothing left to change. Items already remembered keep their result.
   */
  rememberHandled(
    scope: string,
    items: ReadonlyArray<CanonicalItem>,
    kinds: ReadonlySet<string>,
  ): void {
    const keys = itemCacheKeys(items)
    for (const [index, item] of items.entries()) {
      if (!kinds.has(item.kind)) continue
      if (this.entries.has(`${scope}:${keys[index]}`)) continue
      this.remember(scope, keys[index], { itemId: item.id, operations: [] })
    }
  }

  wasShown(scope: string, key: string): boolean {
    return this.shown.has(`${scope}:${key}`)
  }

  markShown(scope: string, keys: ReadonlyArray<string>): void {
    for (const key of keys) this.shown.add(`${scope}:${key}`)
    while (this.shown.size > MAX_ENTRIES) {
      const oldest = this.shown.values().next().value
      if (oldest === undefined) break
      this.shown.delete(oldest)
    }
  }

  private drop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.bytes -= entry.bytes
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
    }
  }
}
