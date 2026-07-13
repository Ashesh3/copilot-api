export type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue }

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

export function collectJsonContainerPaths(
  value: JsonValue,
  maxDepth = Number.POSITIVE_INFINITY,
): Set<string> {
  const paths = new Set<string>()

  function visit(node: JsonValue, path: string, depth: number): void {
    const entries = jsonEntries(node)
    if (!isJsonContainer(node) || entries.length === 0) return
    if (depth <= maxDepth) paths.add(path)
    if (depth >= maxDepth) return

    for (const [key, child] of entries) {
      visit(child, jsonPointerPath(path, key), depth + 1)
    }
  }

  visit(value, "#", 0)
  return paths
}
