import consola from "consola"

/**
 * Shared helpers for image/PDF attachment handling across all API dialects.
 *
 * Empirically confirmed CAPI constraints (probed 2026-07-03):
 * - /chat/completions accepts only `text` and `image_url` content parts;
 *   image_url must be a data URI ("external image URLs are not supported").
 * - /responses accepts `input_image` (data URI) and `input_file` with
 *   `file_data` as a data URI (raw base64 is rejected); external file_url
 *   values are rejected.
 * - /v1/messages (Anthropic dialect, claude models) accepts base64 `image`
 *   and base64 `document` source blocks; `text` sources and external URL
 *   sources are rejected.
 */

export interface ParsedDataUri {
  mediaType: string
  /** base64 payload (without the data: prefix) */
  data: string
}

const DATA_URI_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s

export function parseDataUri(url: string): ParsedDataUri | null {
  const match = DATA_URI_RE.exec(url)
  if (!match) return null
  return { mediaType: match[1].toLowerCase(), data: match[2] }
}

export function toDataUri(mediaType: string, base64Data: string): string {
  return `data:${mediaType};base64,${base64Data}`
}

export function isDataUri(url: string): boolean {
  return url.startsWith("data:")
}

export function isHttpUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://")
}

export function isPdfMediaType(mediaType: string | undefined): boolean {
  return mediaType?.toLowerCase().split(";")[0].trim() === "application/pdf"
}

export function isImageMediaType(mediaType: string | undefined): boolean {
  return mediaType?.toLowerCase().startsWith("image/") ?? false
}

/** Looks like raw base64 (no data: prefix, plausible alphabet). */
export function isLikelyBase64(value: string): boolean {
  return (
    !isDataUri(value)
    && !isHttpUrl(value)
    && /^[A-Z0-9+/=\r\n]+$/i.test(value.slice(0, 256))
  )
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
}

export function mediaTypeFromFilename(
  filename: string | undefined | null,
): string | undefined {
  if (!filename) return undefined
  const ext = filename.split(".").pop()?.toLowerCase()
  return ext ? EXTENSION_MEDIA_TYPES[ext] : undefined
}

/**
 * Fetch an external http(s) attachment and inline it as a data URI.
 * Upstream Copilot rejects external URLs on every endpoint, so the proxy
 * fetches on the client's behalf. Returns null on any failure (caller
 * downgrades to a text note).
 */
export async function fetchUrlAsDataUri(
  url: string,
  options?: { expectPdf?: boolean; signal?: AbortSignal },
): Promise<ParsedDataUri | null> {
  if (!isHttpUrl(url)) return null

  try {
    const response = await fetch(url, {
      headers: { accept: "*/*" },
      signal: options?.signal,
    })
    if (!response.ok) {
      consola.warn(`Attachment fetch failed with HTTP ${response.status}`)
      return null
    }

    const buffer = await response.arrayBuffer()
    const headerMediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase()
    const mediaType =
      (headerMediaType && headerMediaType !== "application/octet-stream" ?
        headerMediaType
      : undefined)
      ?? mediaTypeFromFilename(new URL(url).pathname)
      ?? (options?.expectPdf ? "application/pdf" : "application/octet-stream")

    return {
      mediaType,
      data: Buffer.from(buffer).toString("base64"),
    }
  } catch (error) {
    if (options?.signal?.aborted) throw error
    consola.warn("Attachment fetch failed with a transport error")
    return null
  }
}

export function attachmentOmittedNote(options: {
  kind: "image" | "PDF" | "file"
  name?: string | null
  reason: string
}): string {
  const name = options.name ? ` "${options.name}"` : ""
  return `[${options.kind} attachment${name} omitted: ${options.reason}]`
}

export function pdfUnsupportedByModelNote(
  model: string,
  filename?: string | null,
): string {
  return attachmentOmittedNote({
    kind: "PDF",
    name: filename,
    reason: `model ${model} cannot accept PDF input through the Copilot API. Use a Claude or GPT-5.x (Responses) model, or a custom provider with file support`,
  })
}
