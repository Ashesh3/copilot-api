import type { Context } from "hono"

import consola from "consola"

import { extractClientIp, isIpWhitelisted } from "./ip-blocker"

const TRANSPARENT_PROXY_HOSTS = new Set([
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
])

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

const OWNED_ROUTE_PREFIXES = [
  "/api/claude_cli",
  "/api/claude_code",
  "/api/organization",
  "/api/organizations",
  "/api/oauth",
  "/api/web/domain_info",
  "/chat/completions",
  "/code",
  "/dashboard",
  "/embeddings",
  "/feature-flags",
  "/health",
  "/messages",
  "/model-redirects",
  "/oauth",
  "/remote",
  "/replacements",
  "/responses",
  "/sessions",
  "/usage",
  "/v1/chat/completions",
  "/v1/code",
  "/v1/embeddings",
  "/v1/environment_providers",
  "/v1/environments",
  "/v1/mcp_servers",
  "/v1/messages",
  "/v1/oauth",
  "/v1/responses",
  "/v1/session_ingress",
  "/v1/sessions",
  "/v1/ultrareview",
]

const OWNED_EXACT_ROUTES = new Set(["/", "/api/hello", "/models", "/v1/models"])

function normalizeHost(host: string | undefined): string | null {
  if (!host) return null

  const trimmed = host.trim().toLowerCase()
  if (!trimmed) return null

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }

  return trimmed.split(":")[0] ?? null
}

function shouldProxyPath(host: string): boolean {
  return TRANSPARENT_PROXY_HOSTS.has(host)
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function isOwnedRoutePath(path: string): boolean {
  if (OWNED_EXACT_ROUTES.has(path)) return true

  if (
    /^\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)
  ) {
    return true
  }

  if (
    /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(
      path,
    )
  ) {
    return true
  }

  return OWNED_ROUTE_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix))
}

function createProxyHeaders(request: Request): Headers {
  const headers = new Headers(request.headers)

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }

  headers.delete("content-length")
  return headers
}

function createResponseHeaders(headers: Headers): Headers {
  const responseHeaders = new Headers(headers)

  for (const header of HOP_BY_HOP_HEADERS) {
    responseHeaders.delete(header)
  }

  return responseHeaders
}

export function isTransparentProxyHost(host: string | undefined): boolean {
  const normalizedHost = normalizeHost(host)
  return normalizedHost !== null && TRANSPARENT_PROXY_HOSTS.has(normalizedHost)
}

export function isAllowedTransparentProxyRequest(c: Context): boolean {
  const host = normalizeHost(c.req.header("host"))
  if (host === null || !TRANSPARENT_PROXY_HOSTS.has(host)) return false
  if (isOwnedRoutePath(c.req.path)) return false

  return shouldProxyPath(host)
}

export function isTransparentProxyClientWhitelisted(c: Context): boolean {
  const clientIp = extractClientIp(c)
  return clientIp !== null && isIpWhitelisted(clientIp)
}

export async function transparentProxy(c: Context): Promise<Response> {
  const host = normalizeHost(c.req.header("host"))
  if (host === null || !TRANSPARENT_PROXY_HOSTS.has(host)) {
    return c.notFound()
  }

  if (!shouldProxyPath(host)) {
    return c.notFound()
  }

  if (!isTransparentProxyClientWhitelisted(c)) {
    return c.notFound()
  }

  const sourceUrl = new URL(c.req.url)
  const targetUrl = new URL(
    sourceUrl.pathname + sourceUrl.search,
    `https://${host}`,
  )
  const method = c.req.method.toUpperCase()

  consola.info(`[transparent-proxy] ${method} ${targetUrl.toString()}`)

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers: createProxyHeaders(c.req.raw),
      body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
      signal: c.req.raw.signal,
    })

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: createResponseHeaders(upstreamResponse.headers),
    })
  } catch (error) {
    consola.error(
      `[transparent-proxy] ${method} ${targetUrl.toString()} failed:`,
      error,
    )
    return c.text("Bad Gateway", 502)
  }
}
