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

export const ATTACHMENT_FETCH_MAX_BYTES = 3_145_728
export const ATTACHMENT_FETCH_MAX_REDIRECTS = 5
export const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000

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
  return parseFetchableHttpUrl(url) !== null
}

export function parseFetchableHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ?
        parsed
      : null
  } catch {
    return null
  }
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

function createAttachmentAbort(options: {
  callerSignal?: AbortSignal
  timeoutMs: number
}): {
  abortState: AttachmentAbortState
  cleanup: () => void
  signal: AbortSignal
} {
  const controller = new AbortController()
  const abortState: AttachmentAbortState = { source: null }
  const onCallerAbort = () => {
    if (abortState.source) return
    abortState.source = "caller"
    controller.abort(options.callerSignal?.reason)
  }
  options.callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    if (abortState.source) return
    abortState.source = "timeout"
    controller.abort(
      new DOMException("Attachment fetch timed out", "AbortError"),
    )
  }, options.timeoutMs)
  return {
    abortState,
    cleanup: () => {
      clearTimeout(timer)
      options.callerSignal?.removeEventListener("abort", onCallerAbort)
    },
    signal: controller.signal,
  }
}

async function fetchAttachmentResponse(options: {
  fetchImplementation: typeof fetch
  initialUrl: URL
  maxRedirects: number
  signal: AbortSignal
}): Promise<{ response: Response; url: URL } | null> {
  let currentUrl = options.initialUrl
  let redirects = 0
  while (true) {
    const response = await options.fetchImplementation(currentUrl, {
      credentials: "omit",
      headers: { accept: "*/*" },
      redirect: "manual",
      signal: options.signal,
    })
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, url: currentUrl }
    }
    const location = response.headers.get("location")
    if (!location || redirects >= options.maxRedirects) return null
    const nextUrl = parseFetchableHttpUrl(new URL(location, currentUrl).href)
    if (!nextUrl) return null
    currentUrl = nextUrl
    redirects += 1
  }
}

function mediaTypeForResponse(options: {
  expectPdf: boolean
  response: Response
  url: URL
}): string {
  const headerMediaType = options.response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase()
  return (
    (headerMediaType && headerMediaType !== "application/octet-stream" ?
      headerMediaType
    : undefined)
    ?? mediaTypeFromFilename(options.url.pathname)
    ?? (options.expectPdf ? "application/pdf" : "application/octet-stream")
  )
}

/**
 * Fetch an external http(s) attachment and inline it as a data URI.
 * Upstream Copilot rejects external URLs on every endpoint, so the proxy
 * fetches on the client's behalf. Returns null on any failure (caller
 * downgrades to a text note).
 */
// eslint-disable-next-line complexity -- bounded transport outcome branches are explicit
export async function fetchUrlAsDataUri(
  value: string,
  options?: FetchUrlAsDataUriOptions,
): Promise<ParsedDataUri | null> {
  let currentUrl = parseFetchableHttpUrl(value)
  if (!currentUrl) return null
  options?.signal?.throwIfAborted()
  const fetchImplementation = options?.fetch ?? globalThis.fetch
  const maxBytes = options?.maxBytes ?? ATTACHMENT_FETCH_MAX_BYTES
  const maxRedirects = options?.maxRedirects ?? ATTACHMENT_FETCH_MAX_REDIRECTS
  const timeoutMs = options?.timeoutMs ?? ATTACHMENT_FETCH_TIMEOUT_MS
  const abort = createAttachmentAbort({
    callerSignal: options?.signal,
    timeoutMs,
  })

  try {
    const fetched = await fetchAttachmentResponse({
      fetchImplementation,
      initialUrl: currentUrl,
      maxRedirects,
      signal: abort.signal,
    })
    if (!fetched) return null
    const { response } = fetched
    currentUrl = fetched.url
    if (!response.ok) {
      consola.warn(`Attachment fetch failed with HTTP ${response.status}`)
      return null
    }

    const buffer = await readBoundedResponseBody(
      response,
      maxBytes,
      abort.signal,
    )
    if (!buffer) {
      consola.warn("Attachment fetch exceeded the byte limit")
      return null
    }
    return {
      mediaType: mediaTypeForResponse({
        expectPdf: options?.expectPdf ?? false,
        response,
        url: currentUrl,
      }),
      data: buffer.toString("base64"),
    }
  } catch {
    if (abort.abortState.source === "caller") throw options?.signal?.reason
    if (abort.abortState.source === "timeout") return null
    consola.warn("Attachment fetch failed with a transport error")
    return null
  } finally {
    abort.cleanup()
  }
}

export interface FetchUrlAsDataUriOptions {
  expectPdf?: boolean
  fetch?: typeof fetch
  maxBytes?: number
  maxRedirects?: number
  signal?: AbortSignal
  timeoutMs?: number
}

type AttachmentAbortState = { source: "caller" | "timeout" | null }

export type AttachmentFetchResolver = (options: {
  expectPdf: boolean
  signal?: AbortSignal
  value: string
}) => Promise<ParsedDataUri | null>

export function createAttachmentFetchResolver(options?: {
  fetch?: typeof fetch
}): AttachmentFetchResolver {
  const values = new Map<string, Promise<ParsedDataUri | null>>()
  return async ({ expectPdf, signal, value }) => {
    signal?.throwIfAborted()
    const key = `${expectPdf ? "pdf" : "asset"}:${value}`
    let pending = values.get(key)
    if (!pending) {
      pending = fetchUrlAsDataUri(value, {
        expectPdf,
        fetch: options?.fetch,
        signal,
      })
      values.set(key, pending)
      void pending.catch(() => {
        if (values.get(key) === pending) values.delete(key)
      })
    }
    return await pending
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const declared = parseContentLength(response.headers.get("content-length"))
  if (declared !== undefined && declared > maxBytes) return null
  if (!response.body) return Buffer.alloc(0)
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Array<Uint8Array> = []
  let total = 0
  let cancelPending: Promise<void> | undefined
  const cancelReader = (): Promise<void> => {
    cancelPending ??= (async () => {
      try {
        await reader.cancel(signal.reason)
      } catch {
        // Cancellation is best-effort; the abort outcome remains authoritative.
      }
    })()
    return cancelPending
  }
  try {
    while (true) {
      // Bun's Response.body reader is correctly Uint8Array at runtime, but the
      // project DOM typings surface the read result as error-typed here.

      let rejectAbort: ((reason?: unknown) => void) | undefined
      const onAbort = () => {
        void cancelReader()
        rejectAbort?.(
          signal.reason instanceof Error ?
            signal.reason
          : new DOMException("Attachment fetch aborted", "AbortError"),
        )
      }
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
      let result: { done: boolean; value?: Uint8Array }
      try {
        result = await Promise.race([reader.read(), abortPromise])
      } finally {
        signal.removeEventListener("abort", onAbort)
      }

      if (signal.aborted) throw signal.reason

      if (result.done) break

      const chunk = result.value
      if (!chunk) break
      if (total + chunk.byteLength > maxBytes) {
        await cancelReader()
        return null
      }
      chunks.push(chunk)
      total += chunk.byteLength
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    if (signal.aborted) {
      await cancelReader()
      throw signal.reason
    }
    throw error
  } finally {
    reader.releaseLock()
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
