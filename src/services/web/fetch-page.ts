import type {
  WebDocument,
  WebFetchFailure,
  WebFetchInput,
  WebFetchLimits,
  WebFetchOptions,
  WebFetchResult,
} from "./types"

import { extractPageContent, sliceWebDocument } from "./page-content"

export type * from "./types"

const redirects = new Set([301, 302, 303, 307, 308])
class FetchFailure extends Error {
  readonly code: WebFetchFailure["code"]
  readonly status?: number
  constructor(code: WebFetchFailure["code"], message: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function parseWebUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
    )
      return undefined
    return url
  } catch {
    return undefined
  }
}

export function domainAllowed(url: URL, limits: WebFetchLimits): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  const matches = (domain: string) => {
    const name = domain.toLowerCase().replace(/\.$/, "")
    return hostname === name || hostname.endsWith(`.${name}`)
  }
  return (
    !limits.blockedDomains?.some((domain) => matches(domain))
    && (!limits.allowedDomains?.length
      || limits.allowedDomains.some((domain) => matches(domain)))
  )
}

function validPagination(input: WebFetchInput): boolean {
  return (
    (input.raw === undefined || typeof input.raw === "boolean")
    && (input.start_index === undefined
      || (Number.isSafeInteger(input.start_index) && input.start_index >= 0))
    && (input.max_length === undefined
      || (Number.isSafeInteger(input.max_length) && input.max_length > 0))
  )
}

/** Apply the same policy to initial fetches and every cached continuation. */
export async function readFetchedDocument(
  document: WebDocument,
  input: WebFetchInput,
  options: { limits?: WebFetchLimits; warnings?: ReadonlyArray<string> } = {},
): Promise<WebFetchResult> {
  const limits = options.limits ?? {}
  if (!validPagination(input))
    return {
      ok: false,
      code: "invalid_tool_input",
      url: input.url,
      message:
        "Expected nonnegative integer pagination and a boolean raw flag.",
    }
  if (
    !domainAllowed(new URL(document.url), limits)
    || !domainAllowed(new URL(document.requestedUrl), limits)
  )
    return {
      ok: false,
      code: "url_not_allowed",
      url: input.url,
      message: "URL is outside the requested domain filters.",
    }
  const result = sliceWebDocument(document, input, options.warnings)
  if (!limits.maxContentTokens) return result
  const { encode } = await import("gpt-tokenizer/encoding/o200k_base")
  if (encode(result.content).length <= limits.maxContentTokens) return result
  // Cutting a token sequence may split UTF-8 bytes and introduce replacement
  // characters. Select a real Unicode prefix instead, so pagination loses nothing.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- Pagination uses Unicode scalar offsets, not grapheme display widths.
  const characters = [...result.content]
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (
      encode(characters.slice(0, middle).join("")).length
      <= limits.maxContentTokens
    )
      low = middle
    else high = middle - 1
  }
  if (low === 0)
    return {
      ok: false,
      code: "content_too_large",
      url: input.url,
      message:
        "max_content_tokens is too small to represent the next character.",
    }
  const start =
    (result.next_start_index ?? result.full_length) - result.content.length
  result.content = characters.slice(0, low).join("")
  result.next_start_index = start + result.content.length
  return result
}

async function cancellable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error ?
          signal.reason
        : new DOMException("Web fetch aborted", "AbortError"),
      )
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([work, abort])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  let finished = false
  try {
    while (true) {
      const chunk = await cancellable(reader.read(), signal)
      if (chunk.done) {
        finished = true
        break
      }
      size += chunk.value.byteLength
      if (size > maxBytes)
        throw new FetchFailure(
          "content_too_large",
          `Page exceeds ${maxBytes} bytes.`,
        )
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function decodeBody(bytes: Uint8Array, type: string): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(type)?.[1] ?? "utf8"
  try {
    return new TextDecoder(
      charset as ConstructorParameters<typeof TextDecoder>[0],
    ).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

async function responseFor(
  initial: URL,
  options: WebFetchOptions,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let url = initial
  const limits = options.limits ?? {}
  const request = options.request ?? ((target, init) => fetch(target, init))
  for (let count = 0; ; count++) {
    if (!domainAllowed(url, limits))
      throw new FetchFailure(
        "url_not_allowed",
        "URL is outside the requested domain filters.",
      )
    const response = await cancellable(
      request(url, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal,
        headers: {
          accept: "text/markdown, text/plain, text/html;q=0.9",
          "user-agent": "copilot-api-web-fetch",
        },
      }),
      signal,
    )
    if (!redirects.has(response.status)) return { response, url }
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (count >= Math.min(limits.maxRedirects ?? 10, 10))
      throw new FetchFailure(
        "redirect_limit",
        "Web fetch redirect limit exceeded.",
      )
    if (!location)
      throw new FetchFailure(
        "url_not_accessible",
        "Redirect has no Location header.",
        response.status,
      )
    let next: URL | undefined
    try {
      next = parseWebUrl(new URL(location, url).href)
    } catch {
      /* invalid location */
    }
    if (!next)
      throw new FetchFailure(
        "invalid_tool_input",
        "Redirect target is not an HTTP(S) URL without credentials.",
      )
    url = next
  }
}

// eslint-disable-next-line complexity, max-lines-per-function -- One deadline owns status, bounded body, extraction and cancellation.
export async function executeWebFetch(
  input: WebFetchInput,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const failure = (
    code: WebFetchFailure["code"],
    message: string,
    status?: number,
  ): WebFetchFailure => ({
    ok: false,
    code,
    url: input.url,
    message,
    ...(status === undefined ? {} : { status }),
  })
  if (
    typeof input.url !== "string"
    || !parseWebUrl(input.url)
    || !validPagination(input)
  )
    return failure(
      "invalid_tool_input",
      "Expected an HTTP(S) URL without credentials and nonnegative integer pagination.",
    )
  options.signal?.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Web fetch timed out", "TimeoutError")),
    Math.min(options.limits?.timeoutMs ?? 30_000, 30_000),
  )
  const signal =
    options.signal ?
      AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal
  let response: Response | undefined
  try {
    const fetched = await responseFor(new URL(input.url), options, signal)
    response = fetched.response
    if (!response.ok)
      throw new FetchFailure(
        response.status === 429 ? "too_many_requests" : "url_not_accessible",
        `HTTP ${response.status} fetching webpage.`,
        response.status,
      )
    const contentType = response.headers.get("content-type") ?? "text/plain"
    const mediaType = contentType.split(";")[0].trim().toLowerCase()
    if (
      ![
        "application/json",
        "application/xhtml+xml",
        "application/xml",
        "text/html",
        "text/markdown",
        "text/plain",
        "text/x-markdown",
        "text/xml",
      ].includes(mediaType)
    )
      throw new FetchFailure(
        "unsupported_content_type",
        `Unsupported webpage content type: ${mediaType}.`,
        response.status,
      )
    const bytes = await readBody(
      response,
      signal,
      Math.min(options.limits?.maxBytes ?? 10 * 1024 * 1024, 10 * 1024 * 1024),
    )
    const rawBody = decodeBody(bytes, contentType)
    const extracted =
      mediaType.includes("html") ?
        extractPageContent(rawBody, fetched.url.href)
      : {
          text: rawBody,
          title: fetched.url.href,
          links: [],
          warnings: [],
        }
    signal.throwIfAborted()
    return await readFetchedDocument(
      {
        requestedUrl: input.url,
        url: fetched.url.href,
        title: extracted.title,
        status: response.status,
        mediaType,
        retrievedAt: (options.now?.() ?? new Date()).toISOString(),
        text: extracted.text,
        rawBody,
        links: extracted.links,
      },
      input,
      { limits: options.limits, warnings: extracted.warnings },
    )
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (deadline.signal.aborted)
      return failure("timeout", "Webpage retrieval timed out.")
    if (error instanceof FetchFailure)
      return failure(error.code, error.message, error.status)
    return failure("unavailable", "Webpage retrieval failed.")
  } finally {
    clearTimeout(timer)
    if (response?.body && !response.body.locked)
      await response.body.cancel().catch(() => {})
  }
}
