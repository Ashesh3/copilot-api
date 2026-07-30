import { jsonLanguage } from "@codemirror/lang-json"

import type { JsonValue } from "./json-tree"

export interface JsonDocumentDiagnostic {
  column: number
  from: number
  kind: "model" | "root" | "syntax"
  line: number
  message: string
  to: number
}

export type ReplayDocumentValidation =
  | { ok: true; value: Record<string, JsonValue> }
  | { diagnostic: JsonDocumentDiagnostic; ok: false }

interface DocumentLocation {
  column: number
  line: number
}

interface DocumentDiagnosticOptions {
  from: number
  kind: JsonDocumentDiagnostic["kind"]
  message: string
  raw: string
  to: number
}

export function locationAt(raw: string, offset: number): DocumentLocation {
  const boundedOffset = Math.min(Math.max(offset, 0), raw.length)
  let line = 1
  let lineStart = 0

  for (let index = 0; index < boundedOffset; index += 1) {
    if (raw[index] === "\n") {
      line += 1
      lineStart = index + 1
    }
  }

  return { column: boundedOffset - lineStart + 1, line }
}

export function documentDiagnostic({
  from,
  kind,
  message,
  raw,
  to,
}: DocumentDiagnosticOptions): JsonDocumentDiagnostic {
  const boundedFrom = Math.min(Math.max(from, 0), raw.length)
  const boundedTo = Math.min(
    Math.max(to, boundedFrom + (raw.length > 0 ? 1 : 0)),
    raw.length,
  )
  const location = locationAt(raw, boundedFrom)

  return {
    column: location.column,
    from: boundedFrom,
    kind,
    line: location.line,
    message,
    to: boundedTo,
  }
}

function syntaxDiagnostic(
  raw: string,
  from: number,
  to: number,
): JsonDocumentDiagnostic {
  const { column, line } = locationAt(raw, from)
  return documentDiagnostic({
    from,
    kind: "syntax",
    message: `Invalid JSON at line ${line}, column ${column}.`,
    raw,
    to,
  })
}

export function findJsonDocumentDiagnostic(
  raw: string,
): JsonDocumentDiagnostic | null {
  const cursor = jsonLanguage.parser.parse(raw).cursor()

  do {
    if (cursor.type.isError) {
      return syntaxDiagnostic(raw, cursor.from, cursor.to)
    }
  } while (cursor.next())

  return null
}

export function formatJsonDocument(raw: string): string | null {
  if (findJsonDocumentDiagnostic(raw)) return null

  try {
    const value = JSON.parse(raw) as JsonValue
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

export function prepareReplayDocument(raw: string): string {
  return formatJsonDocument(raw) ?? raw
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateReplayDocument(raw: string): ReplayDocumentValidation {
  const syntaxError = findJsonDocumentDiagnostic(raw)
  if (syntaxError) return { diagnostic: syntaxError, ok: false }

  let value: JsonValue
  try {
    value = JSON.parse(raw) as JsonValue
  } catch {
    return { diagnostic: syntaxDiagnostic(raw, 0, raw.length), ok: false }
  }

  if (!isJsonRecord(value)) {
    return {
      diagnostic: documentDiagnostic({
        from: 0,
        kind: "root",
        message: "Replay body must be a JSON object.",
        raw,
        to: raw.length,
      }),
      ok: false,
    }
  }

  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    return {
      diagnostic: documentDiagnostic({
        from: 0,
        kind: "model",
        message: "model is required.",
        raw,
        to: raw.length,
      }),
      ok: false,
    }
  }

  return { ok: true, value }
}
