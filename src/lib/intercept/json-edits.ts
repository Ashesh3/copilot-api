import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import type { ArrayGuard, JsonChange, JsonPath } from "./send-owner"

/** An operator's edits to a JSON request, replayable onto a resend. */
export interface JsonEdits {
  changes: Array<JsonChange>
  guards: Array<ArrayGuard>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value))
}

function diffJson(original: unknown, approved: unknown): Array<JsonChange> {
  const changes: Array<JsonChange> = []
  const walk = (before: unknown, after: unknown, path: JsonPath): void => {
    if (isDeepStrictEqual(before, after)) return
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        if (!Object.hasOwn(after, key)) {
          changes.push({ path: [...path, key], before: { value: before[key] } })
        } else if (!Object.hasOwn(before, key)) {
          changes.push({ path: [...path, key], after: { value: after[key] } })
        } else {
          walk(before[key], after[key], [...path, key])
        }
      }
      return
    }
    if (
      Array.isArray(before)
      && Array.isArray(after)
      && before.length === after.length
    ) {
      for (const [index, value] of before.entries()) {
        walk(value, after[index], [...path, index])
      }
      return
    }
    changes.push({ path, before: { value: before }, after: { value: after } })
  }
  walk(original, approved, [])
  return changes
}

/** The value at `path`, following own properties only. */
function valueAt(
  root: unknown,
  path: JsonPath,
): { value: unknown } | undefined {
  let current: unknown = root
  for (const key of path) {
    if (
      (!isRecord(current) && !Array.isArray(current))
      || !Object.hasOwn(current, key)
    ) {
      return undefined
    }
    current = (current as Record<string | number, unknown>)[key]
  }
  return { value: current }
}

function arrayGuards(
  original: unknown,
  changes: Array<JsonChange>,
): Array<ArrayGuard> {
  const guards = new Map<string, ArrayGuard>()
  for (const change of changes) {
    for (const [index, key] of change.path.entries()) {
      if (typeof key !== "number") continue
      const path = change.path.slice(0, index)
      const id = JSON.stringify(path)
      const array = valueAt(original, path)
      if (!guards.has(id) && array) {
        guards.set(id, { path, digest: digestJson(array.value) })
      }
    }
  }
  return [...guards.values()]
}

/**
 * Apply `changes` to `target` only where it still holds exactly what the
 * operator changed; anything else means the resend differs where the
 * operator edited, and it must be reviewed again.
 */
function applyChanges(
  target: unknown,
  changes: Array<JsonChange>,
): { value: unknown } | undefined {
  let root = structuredClone(target)
  for (const change of changes) {
    if (change.path.length === 0) {
      if (!isDeepStrictEqual(root, change.before?.value)) return undefined
      root = structuredClone(change.after?.value)
      continue
    }
    const parent = valueAt(root, change.path.slice(0, -1))?.value
    const key = change.path.at(-1) as string | number
    if (!isRecord(parent) && !Array.isArray(parent)) return undefined
    const container = parent as Record<string | number, unknown>
    const present = Object.hasOwn(container, key)
    if (
      change.before ?
        !present || !isDeepStrictEqual(container[key], change.before.value)
      : present
    ) {
      return undefined
    }
    if (change.after) {
      // A plain assignment to a `__proto__` key would replace the prototype.
      Object.defineProperty(container, key, {
        value: structuredClone(change.after.value),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    } else {
      Reflect.deleteProperty(container, key)
    }
  }
  return { value: root }
}

/** Edits from the original to the approved body; undefined when not JSON. */
export function computeEdits(
  original: string,
  approved: string,
): JsonEdits | undefined {
  const before = parseJson(original)
  const after = parseJson(approved)
  if (!before || !after) return undefined
  const changes = diffJson(before.value, after.value)
  return { changes, guards: arrayGuards(before.value, changes) }
}

/**
 * Replay edits onto a resend. Undefined when the resend is not JSON, an
 * array on an edited path changed (an index may now name another element),
 * or an edited value differs from what the operator saw.
 */
export function applyEdits(body: string, edits: JsonEdits): string | undefined {
  const parsed = parseJson(body)
  if (!parsed) return undefined
  for (const guard of edits.guards) {
    const array = valueAt(parsed.value, guard.path)
    if (!array || digestJson(array.value) !== guard.digest) return undefined
  }
  const replayed = applyChanges(parsed.value, edits.changes)
  return replayed ? JSON.stringify(replayed.value) : undefined
}
