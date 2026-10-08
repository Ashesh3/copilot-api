import type { JsonValue } from "./json-tree"

type JsonRecord = { [key: string]: JsonValue }

/** One image from an OpenAI-style Images API response. */
export interface ParsedResponseImage {
  /** Decoded size of inline image data in bytes. */
  byteLength: number | null
  /** Inline `data:` URL; null when the image is remote, invalid, or unknown. */
  dataUrl: string | null
  /** Position in the response's `data` array. */
  index: number
  mimeType: string | null
  revisedPrompt: string | null
  url: string | null
}

interface ParsedImagesBody {
  assistantText: string
  copilotUsage: JsonRecord | null
  errorMessage: string | null
  events: Array<never>
  images: Array<ParsedResponseImage>
  isPartial: boolean
  reasoningText: string
  response: JsonRecord
  status: string | null
  toolCalls: Array<never>
  usage: JsonRecord | null
}

const BASE64_PATTERN = /^[\d+/a-z]+={0,2}$/i

const OUTPUT_FORMAT_TYPES = new Map([
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isImageEntry(value: JsonValue): value is JsonRecord {
  return (
    isRecord(value)
    && (typeof value.b64_json === "string" || typeof value.url === "string")
  )
}

/** Matches `{created, data: [{b64_json | url}]}` from the Images API. */
export function looksLikeImagesResponse(value: JsonRecord): boolean {
  return (
    typeof value.created === "number"
    && Array.isArray(value.data)
    && value.data.length > 0
    && value.data.every((entry) => isImageEntry(entry))
  )
}

/** Reads the file signature so a mislabeled format still renders correctly. */
function sniffImageType(base64: string): string | null {
  let header: string
  try {
    header = atob(base64.slice(0, 16))
  } catch {
    return null
  }
  if (header.startsWith("\u0089PNG\r\n\u001A\n")) return "image/png"
  if (header.startsWith("\u00FF\u00D8\u00FF")) return "image/jpeg"
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif"
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp"
  }
  return null
}

function parseImage(
  entry: JsonRecord,
  index: number,
  declaredType: string | null,
): ParsedResponseImage {
  const base64 = typeof entry.b64_json === "string" ? entry.b64_json : null
  const common = {
    index,
    revisedPrompt:
      typeof entry.revised_prompt === "string" ? entry.revised_prompt : null,
    url: typeof entry.url === "string" ? entry.url : null,
  }
  if (
    base64 === null
    || base64.length % 4 !== 0
    || !BASE64_PATTERN.test(base64)
  ) {
    return { ...common, byteLength: null, dataUrl: null, mimeType: null }
  }

  let padding = 0
  if (base64.endsWith("==")) padding = 2
  else if (base64.endsWith("=")) padding = 1
  const mimeType = sniffImageType(base64) ?? declaredType
  return {
    ...common,
    byteLength: (base64.length / 4) * 3 - padding,
    dataUrl: mimeType ? `data:${mimeType};base64,${base64}` : null,
    mimeType,
  }
}

export function parseImagesBody(response: JsonRecord): ParsedImagesBody {
  const format =
    typeof response.output_format === "string" ?
      response.output_format.toLowerCase()
    : ""
  const declaredType = OUTPUT_FORMAT_TYPES.get(format) ?? null
  const entries =
    Array.isArray(response.data) ?
      response.data.filter((entry) => isImageEntry(entry))
    : []

  return {
    assistantText: "",
    copilotUsage:
      isRecord(response.copilot_usage) ? response.copilot_usage : null,
    errorMessage: null,
    events: [],
    images: entries.map((entry, index) =>
      parseImage(entry, index, declaredType),
    ),
    isPartial: false,
    reasoningText: "",
    response,
    status: null,
    toolCalls: [],
    usage: isRecord(response.usage) ? response.usage : null,
  }
}
