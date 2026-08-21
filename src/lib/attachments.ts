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

/**
 * Recover any canonical HTTP(S) URL the client supplied, including local and
 * IP targets. Malformed or non-HTTP values are skipped so fetch does not throw.
 */
export function isSafeExternalHttpUrl(value: string): boolean {
  return isCanonicalHttpUrl(value)
}

export function isCanonicalHttpUrl(value: string): boolean {
  if (
    !isHttpUrl(value)
    || hasUnsafeRawUrlCharacter(value)
    || hasInvalidPercentEncoding(value)
  ) {
    return false
  }
  try {
    const url = new URL(value)
    const authority = rawUrlAuthority(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0
      && isValidRawHttpAuthority(authority, url.hostname, url.protocol)
      && matchesCanonicalHttpUrl(value, url)
    )
  } catch {
    return false
  }
}

function hasUnsafeRawUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (
      character === "\\"
      || code === undefined
      || code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
      || character.trim().length === 0
    ) {
      return true
    }
  }
  return false
}

function hasInvalidPercentEncoding(value: string): boolean {
  for (
    let index = value.indexOf("%");
    index >= 0;
    index = value.indexOf("%", index + 1)
  ) {
    if (!/^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) return true
  }
  return false
}

function rawUrlAuthority(value: string): string {
  const authorityStart = value.startsWith("https://") ? 8 : 7
  const authorityEnd = findFirstDelimiter(value, authorityStart)
  return value.slice(authorityStart, authorityEnd)
}

function isValidRawHttpAuthority(
  authority: string,
  parsedHostname: string,
  protocol: string,
): boolean {
  if (authority.length === 0 || authority.includes("@")) return false
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]")
    if (closingBracket <= 1) return false
    return authority === new URL(`${protocol}//${authority}`).host
  }
  const firstColon = authority.indexOf(":")
  const lastColon = authority.lastIndexOf(":")
  if (firstColon !== lastColon) return false
  const hostname = firstColon < 0 ? authority : authority.slice(0, firstColon)
  const portSuffix = firstColon < 0 ? "" : authority.slice(firstColon)
  return (
    isValidRawHostname(hostname)
    && isValidRawPortSuffix(portSuffix)
    && (!isCanonicalIpv4Address(parsedHostname) || hostname === parsedHostname)
  )
}

function isValidRawHostname(hostname: string): boolean {
  const withoutTrailingDot =
    hostname.endsWith(".") ? hostname.slice(0, -1) : hostname
  if (/^[\d.]+$/.test(withoutTrailingDot)) {
    const octets = withoutTrailingDot.split(".")
    return (
      octets.length === 4
      && octets.every(
        (octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255,
      )
    )
  }
  return (
    withoutTrailingDot.length > 0
    && withoutTrailingDot.length <= 253
    && withoutTrailingDot
      .split(".")
      .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  )
}

function isValidRawPortSuffix(value: string): boolean {
  if (value.length === 0) return true
  const port = value.slice(1)
  return /^\d{1,5}$/.test(port) && Number(port) <= 65_535
}

function isCanonicalIpv4Address(value: string): boolean {
  return value.split(".").length === 4 && isValidRawHostname(value)
}

function matchesCanonicalHttpUrl(value: string, url: URL): boolean {
  const authorityEnd = findFirstDelimiter(value, url.protocol.length + 2)
  const rawPathAndSuffix = value.slice(authorityEnd)
  const canonicalAuthorityEnd = findFirstDelimiter(
    url.href,
    url.protocol.length + 2,
  )
  const canonicalPathAndSuffix = url.href.slice(canonicalAuthorityEnd)
  if (rawPathAndSuffix.length === 0) return canonicalPathAndSuffix === "/"
  if (rawPathAndSuffix.startsWith("?") || rawPathAndSuffix.startsWith("#")) {
    return canonicalPathAndSuffix === `/${rawPathAndSuffix}`
  }
  return rawPathAndSuffix === canonicalPathAndSuffix
}

function findFirstDelimiter(value: string, start: number): number {
  const indexes = ["/", "?", "#"]
    .map((delimiter) => value.indexOf(delimiter, start))
    .filter((index) => index >= 0)
  return indexes.length === 0 ? value.length : Math.min(...indexes)
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
