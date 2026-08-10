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
    const character = raw[index]
    if (character === "\r") {
      if (raw[index + 1] === "\n" && index + 1 < boundedOffset) index += 1
      line += 1
      lineStart = index + 1
    } else if (character === "\n") {
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

function isJsonWhitespace(character: string): boolean {
  return (
    character === " "
    || character === "\t"
    || character === "\n"
    || character === "\r"
  )
}

function nextNonWhitespace(raw: string, start: number): string | undefined {
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index]
    if (!isJsonWhitespace(character)) return character
  }
  return undefined
}

function previousNonWhitespace(raw: string, start: number): string | undefined {
  for (let index = start; index >= 0; index -= 1) {
    const character = raw[index]
    if (!isJsonWhitespace(character)) return character
  }
  return undefined
}

interface FormattedStructuralCharacter {
  depth: number
  text: string
}

interface StructuralCharacterOptions {
  character: string
  depth: number
  index: number
  raw: string
}

function formatStructuralCharacter({
  character,
  depth,
  index,
  raw,
}: StructuralCharacterOptions): FormattedStructuralCharacter {
  switch (character) {
    case "{":
    case "[": {
      const closingCharacter = character === "{" ? "}" : "]"
      if (nextNonWhitespace(raw, index + 1) === closingCharacter) {
        return { depth, text: character }
      }
      const nestedDepth = depth + 1
      return {
        depth: nestedDepth,
        text: `${character}\n${"  ".repeat(nestedDepth)}`,
      }
    }
    case "}":
    case "]": {
      const openingCharacter = character === "}" ? "{" : "["
      if (previousNonWhitespace(raw, index - 1) === openingCharacter) {
        return { depth, text: character }
      }
      const parentDepth = depth - 1
      return {
        depth: parentDepth,
        text: `\n${"  ".repeat(parentDepth)}${character}`,
      }
    }
    case ",": {
      return { depth, text: `,\n${"  ".repeat(depth)}` }
    }
    case ":": {
      return { depth, text: ": " }
    }
    default: {
      return { depth, text: character }
    }
  }
}

function formatValidatedJson(raw: string): string {
  let depth = 0
  let escaped = false
  let formatted = ""
  let inString = false

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]

    if (inString) {
      formatted += character
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (isJsonWhitespace(character)) continue

    if (character === '"') {
      formatted += character
      inString = true
    } else {
      const structuralCharacter = formatStructuralCharacter({
        character,
        depth,
        index,
        raw,
      })
      depth = structuralCharacter.depth
      formatted += structuralCharacter.text
    }
  }

  return formatted
}

export function formatJsonDocument(raw: string): string | null {
  if (findJsonDocumentDiagnostic(raw)) return null

  try {
    JSON.parse(raw)
    return formatValidatedJson(raw)
  } catch {
    return null
  }
}

export function prepareReplayDocument(raw: string): string {
  return raw
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
