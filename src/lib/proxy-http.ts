const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const DECODED_BODY_HEADERS = [
  "content-encoding",
  "content-length",
  "content-md5",
]

function deleteHopByHopHeaders(headers: Headers): void {
  const connectionHeader = headers.get("connection")
  if (connectionHeader) {
    for (const header of connectionHeader.split(",")) {
      const trimmed = header.trim()
      if (trimmed) headers.delete(trimmed)
    }
  }

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
}

export function normalizeProxyHost(host: string | undefined): string | null {
  const trimmed = (host ?? "").trim().toLowerCase()
  if (!trimmed) return null

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }

  return trimmed.split(":")[0] ?? null
}

export function createProxyRequestHeaders(request: Request): Headers {
  const headers = new Headers(request.headers)

  deleteHopByHopHeaders(headers)

  headers.delete("content-length")
  headers.delete("host")
  headers.set("accept-encoding", "identity")
  return headers
}

export function createProxyResponseHeaders(headers: Headers): Headers {
  const responseHeaders = new Headers(headers)
  const hasEncodedBody = responseHeaders.has("content-encoding")

  deleteHopByHopHeaders(responseHeaders)

  if (hasEncodedBody) {
    for (const header of DECODED_BODY_HEADERS) {
      responseHeaders.delete(header)
    }
  }

  return responseHeaders
}
