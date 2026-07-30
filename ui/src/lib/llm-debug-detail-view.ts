import type { CodeDocumentLanguage } from "./code-mirror-document"
import type { JsonValue, ParsedJsonBody } from "./json-tree"

export type RequestViewMode = "pretty" | "raw"

export type RequestPayloadView =
  | { kind: "empty" }
  | { formatted: string; kind: "tree"; value: JsonValue }
  | {
      kind: "virtualized"
      language: CodeDocumentLanguage
      value: string
    }

export function requestPayloadView(
  body: string | null,
  parsed: ParsedJsonBody | null,
  viewMode: RequestViewMode,
): RequestPayloadView {
  if (body === null) return { kind: "empty" }

  if (viewMode === "pretty" && parsed) {
    return { ...parsed, kind: "tree" }
  }

  return {
    kind: "virtualized",
    language: parsed ? "json" : "text",
    value: body,
  }
}
