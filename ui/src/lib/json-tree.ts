export type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export const JSON_CHILD_PAGE_SIZE = 100
export const LARGE_JSON_BYTE_THRESHOLD = 250 * 1_024
export const LARGE_JSON_NODE_THRESHOLD = 5_000

export interface JsonDocumentScale {
  exceededNodeThreshold: boolean
  isLarge: boolean
  nodeCount: number
}

export interface JsonEntryPage {
  entries: Array<[string, JsonValue]>
  remaining: number
  total: number
}

export interface ParsedJsonBody {
  formatted: string
  value: JsonValue
}

export function parseJsonBody(raw: string): ParsedJsonBody | null {
  try {
    const value = JSON.parse(raw) as JsonValue
    return { formatted: JSON.stringify(value, null, 2), value }
  } catch {
    return null
  }
}

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1")
}

export function jsonPointerPath(parentPath: string, segment: string): string {
  return `${parentPath}/${escapeJsonPointerSegment(segment)}`
}

export function isJsonContainer(
  value: JsonValue,
): value is Array<JsonValue> | { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null
}

export function jsonEntries(value: JsonValue): Array<[string, JsonValue]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item])
  }
  return isJsonContainer(value) ? Object.entries(value) : []
}

export function jsonEntryPage(
  value: JsonValue,
  visibleCount: number,
): JsonEntryPage {
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, visibleCount)
      .map((item, index): [string, JsonValue] => [String(index), item])
    return {
      entries,
      remaining: value.length - entries.length,
      total: value.length,
    }
  }

  if (isJsonContainer(value)) {
    const keys = Object.keys(value)
    const entries = keys
      .slice(0, visibleCount)
      .map((key): [string, JsonValue] => [key, value[key]])
    return {
      entries,
      remaining: keys.length - entries.length,
      total: keys.length,
    }
  }

  return { entries: [], remaining: 0, total: 0 }
}

export function hasJsonEntries(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (!isJsonContainer(value)) return false

  for (const key in value) {
    if (Object.hasOwn(value, key)) return true
  }
  return false
}

export function measureJsonDocument(
  value: JsonValue,
  byteLength: number,
): JsonDocumentScale {
  if (byteLength > LARGE_JSON_BYTE_THRESHOLD) {
    return {
      exceededNodeThreshold: false,
      isLarge: true,
      nodeCount: 1,
    }
  }

  const stack = [value]
  let exceededNodeThreshold = false
  let nodeCount = 0

  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break

    nodeCount += 1
    if (nodeCount > LARGE_JSON_NODE_THRESHOLD) {
      exceededNodeThreshold = true
      break
    }

    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
    } else if (isJsonContainer(node)) {
      for (const key in node) {
        if (Object.hasOwn(node, key)) stack.push(node[key])
      }
    }
  }

  return {
    exceededNodeThreshold,
    isLarge: exceededNodeThreshold,
    nodeCount,
  }
}

export function collectJsonContainerPaths(
  value: JsonValue,
  maxDepth = Number.POSITIVE_INFINITY,
): Set<string> {
  const paths = new Set<string>()

  function visit(node: JsonValue, path: string, depth: number): void {
    if (!isJsonContainer(node) || !hasJsonEntries(node)) return
    if (depth <= maxDepth) paths.add(path)
    if (depth >= maxDepth) return

    for (const [key, child] of jsonEntries(node)) {
      visit(child, jsonPointerPath(path, key), depth + 1)
    }
  }

  visit(value, "#", 0)
  return paths
}

export function initialJsonContainerPaths(
  value: JsonValue,
  isLarge: boolean,
): Set<string> {
  return collectJsonContainerPaths(value, isLarge ? 0 : 1)
}
