import { normalizeIpAddress } from "./ip-allowlist"
import { isTrustedProxyPeer } from "./ip-blocker"

const ENCODED_TRAVERSAL_PATTERN = /(?:^|\/)(?:%2e|\.){1,2}(?=\/|$)|%2f|%5c/i

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0
    if (codePoint > 0xffff) index += 1
    if (codePoint <= 31 || codePoint === 127) return true
  }
  return false
}

function normalizePrefix(pathname: string): string {
  if (pathname === "/") return "/"
  return pathname.replace(/\/+$/, "") || "/"
}

function hasUnsafePath(pathname: string): boolean {
  return (
    pathname.includes("\\")
    || hasAsciiControl(pathname)
    || ENCODED_TRAVERSAL_PATTERN.test(pathname)
    || pathname
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  )
}

function isValidPublicUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    return false
  }
  return url.search === "" && url.hash === "" && !hasUnsafePath(url.pathname)
}

function parsePublicBase(value: string | undefined): URL | null {
  if (value === undefined || hasAsciiControl(value)) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("\\")) return null
  const rawPath = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i,
  )?.[1]
  if (rawPath && hasUnsafePath(rawPath)) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (!isValidPublicUrl(url)) return null

  url.pathname = normalizePrefix(url.pathname)
  return url
}

function firstForwardedValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim()
  return first || null
}

function parseForwardedOrigin(request: Request): URL | null {
  const peerIp = normalizeIpAddress(
    request.headers.get("x-copilot-peer-ip") ?? "",
  )
  if (!peerIp || !isTrustedProxyPeer(peerIp)) return null

  const protocol = firstForwardedValue(
    request.headers.get("x-forwarded-proto"),
  )?.toLowerCase()
  const host = firstForwardedValue(request.headers.get("x-forwarded-host"))
  if (
    (protocol !== "http" && protocol !== "https")
    || !host
    || hasAsciiControl(host)
    || /[\s\\/@?#]/.test(host)
  ) {
    return null
  }

  return parsePublicBase(`${protocol}://${host}/`)
}

export function resolvePublicOrigin(request: Request): URL {
  return (
    parsePublicBase(process.env.COPILOT_PUBLIC_BASE_URL)
    ?? parseForwardedOrigin(request)
    ?? new URL(new URL(request.url).origin)
  )
}

export function toWebSocketUrl(
  origin: URL,
  relativePath: ReadonlyArray<string>,
): URL {
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError("Public origin must use HTTP or HTTPS")
  }

  const encodedSegments = relativePath.map((segment) => {
    if (
      !segment
      || segment === "."
      || segment === ".."
      || hasAsciiControl(segment)
      || /\\/.test(segment)
    ) {
      throw new TypeError("WebSocket path segments must be safe and relative")
    }
    return encodeURIComponent(segment)
  })

  const result = new URL(origin.toString())
  result.protocol = origin.protocol === "http:" ? "ws:" : "wss:"
  const prefix = normalizePrefix(result.pathname)
  result.pathname = `${prefix === "/" ? "" : prefix}/${encodedSegments.join("/")}`
  result.search = ""
  result.hash = ""
  return result
}
