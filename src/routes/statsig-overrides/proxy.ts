import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import {
  extractClientIp,
  isIpAllowedForWhitelistedRoute,
} from "~/lib/ip-blocker"
import {
  createProxyRequestHeaders,
  createProxyResponseHeaders,
  normalizeProxyHost,
} from "~/lib/proxy-http"

import type { StatsigOverrides } from "./store"

import {
  applyStatsigOverrides,
  createFullStatsigInitializeRequest,
  decodeStatsigInitializeBody,
} from "./protocol"
import { statsigOverrideStore } from "./store"

const STATSIG_PROXY_HOST = "ab.chatgpt.com"
const STATSIG_PROXY_ORIGIN = "https://ab.chatgpt.com"

export interface StatsigProxyDependencies {
  fetchImpl?: typeof fetch
  getOverrides?: () => StatsigOverrides
}

function createStatsigUpstreamUrl(sourceUrl: URL): URL {
  const upstreamUrl = new URL(STATSIG_PROXY_ORIGIN)
  upstreamUrl.pathname = sourceUrl.pathname
  upstreamUrl.search = sourceUrl.search
  return upstreamUrl
}

function createStatsigInitializeHeaders(request: Request): Headers {
  const headers = createProxyRequestHeaders(request)
  headers.delete("content-encoding")
  headers.set("content-type", "application/json")
  return headers
}

function hasStatsigOverrides(overrides: StatsigOverrides): boolean {
  return (
    Object.keys(overrides.featureGates).length > 0
    || Object.keys(overrides.dynamicConfigs).length > 0
  )
}

function isStatsigInitializeRequest(c: Context): boolean {
  return (
    c.req.method.toUpperCase() === "POST" && c.req.path === "/v1/initialize"
  )
}

function createProxyResponse(upstreamResponse: Response): Response {
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: createProxyResponseHeaders(upstreamResponse.headers),
  })
}

function getSafeErrorName(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "name" in error
    && typeof error.name === "string"
    && error.name.length > 0
  ) {
    return error.name
  }

  return "UnknownError"
}

type StatsigProxyFailureStage =
  | "request_decode"
  | "upstream_request"
  | "response_overlay"

interface StatsigProxyFailureDetails {
  stage: StatsigProxyFailureStage
  method: string
  pathname: string
}

function logSafeProxyFailure(
  { stage, method, pathname }: StatsigProxyFailureDetails,
  error: unknown,
): void {
  consola.error("[statsig-proxy] Request failed", {
    stage,
    method,
    pathname,
    errorName: getSafeErrorName(error),
  })
}

interface FetchStatsigUpstreamOptions {
  fetchImpl: typeof fetch
  init: RequestInit
  sourceUrl: URL
  upstreamUrl: URL
}

async function fetchStatsigUpstream({
  fetchImpl,
  init,
  sourceUrl,
  upstreamUrl,
}: FetchStatsigUpstreamOptions): Promise<Response | null> {
  try {
    return await fetchImpl(upstreamUrl, init)
  } catch (error) {
    logSafeProxyFailure(
      {
        stage: "upstream_request",
        method: init.method ?? "GET",
        pathname: sourceUrl.pathname,
      },
      error,
    )
    return null
  }
}

interface StatsigInitializeRequestOptions {
  c: Context
  fetchImpl: typeof fetch
  getOverrides: () => StatsigOverrides
  sourceUrl: URL
}

async function proxyStatsigInitializeRequest({
  c,
  fetchImpl,
  getOverrides,
  sourceUrl,
}: StatsigInitializeRequestOptions): Promise<Response> {
  const encoded = sourceUrl.searchParams.get("se") === "1"
  const gzipped = sourceUrl.searchParams.get("gz") === "1"

  let fullRequestBody: string
  try {
    const requestBody = new Uint8Array(await c.req.raw.arrayBuffer())
    const decodedBody = decodeStatsigInitializeBody(requestBody, {
      encoded,
      gzipped,
    })
    fullRequestBody = JSON.stringify(
      createFullStatsigInitializeRequest(decodedBody),
    )
  } catch (error) {
    logSafeProxyFailure(
      {
        stage: "request_decode",
        method: c.req.method.toUpperCase(),
        pathname: sourceUrl.pathname,
      },
      error,
    )
    return c.text("Bad Request", 400)
  }

  const upstreamUrl = createStatsigUpstreamUrl(sourceUrl)
  upstreamUrl.searchParams.delete("se")
  upstreamUrl.searchParams.delete("gz")

  const upstreamResponse = await fetchStatsigUpstream({
    fetchImpl,
    init: {
      method: "POST",
      headers: createStatsigInitializeHeaders(c.req.raw),
      body: fullRequestBody,
      redirect: "manual",
      signal: c.req.raw.signal,
    },
    sourceUrl,
    upstreamUrl,
  })

  if (upstreamResponse === null) {
    return c.text("Bad Gateway", 502)
  }

  if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
    return createProxyResponse(upstreamResponse)
  }

  let responseText: string
  try {
    responseText = await upstreamResponse.text()
    const overrides = getOverrides()
    const overriddenResponse = applyStatsigOverrides(
      JSON.parse(responseText) as unknown,
      overrides,
    )

    const responseHeaders = createProxyResponseHeaders(upstreamResponse.headers)
    if (!hasStatsigOverrides(overrides)) {
      return new Response(responseText, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      })
    }

    responseHeaders.delete("content-encoding")
    responseHeaders.delete("content-length")
    responseHeaders.delete("content-md5")
    responseHeaders.set("content-type", "application/json")

    return new Response(JSON.stringify(overriddenResponse), {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    logSafeProxyFailure(
      {
        stage: "response_overlay",
        method: c.req.method.toUpperCase(),
        pathname: sourceUrl.pathname,
      },
      error,
    )
    return c.text("Bad Gateway", 502)
  }
}

async function proxyRawStatsigRequest(
  c: Context,
  fetchImpl: typeof fetch,
  sourceUrl: URL,
): Promise<Response> {
  const method = c.req.method.toUpperCase()
  const upstreamResponse = await fetchStatsigUpstream({
    fetchImpl,
    init: {
      method,
      headers: createProxyRequestHeaders(c.req.raw),
      body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
      signal: c.req.raw.signal,
    },
    sourceUrl,
    upstreamUrl: createStatsigUpstreamUrl(sourceUrl),
  })

  if (upstreamResponse === null) {
    return c.text("Bad Gateway", 502)
  }

  return createProxyResponse(upstreamResponse)
}

export function createStatsigProxyMiddleware(
  dependencies: StatsigProxyDependencies = {},
): MiddlewareHandler {
  const getOverrides =
    dependencies.getOverrides ?? (() => statsigOverrideStore.get())

  return async (c, next) => {
    const host = normalizeProxyHost(c.req.header("host"))
    if (host !== STATSIG_PROXY_HOST) {
      await next()
      return
    }

    const clientIp = extractClientIp(c)
    if (
      clientIp === null
      || !(await isIpAllowedForWhitelistedRoute(clientIp))
    ) {
      return c.notFound()
    }

    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
    const sourceUrl = new URL(c.req.url)

    if (isStatsigInitializeRequest(c)) {
      return await proxyStatsigInitializeRequest({
        c,
        fetchImpl,
        getOverrides,
        sourceUrl,
      })
    }

    return await proxyRawStatsigRequest(c, fetchImpl, sourceUrl)
  }
}

export const statsigProxyMiddleware = createStatsigProxyMiddleware()
