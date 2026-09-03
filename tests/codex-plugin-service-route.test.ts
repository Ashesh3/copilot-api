import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"
import { createHash } from "node:crypto"

import { sanitizeRequestDiagnosticReference } from "../src/lib/request-diagnostics"
import { state } from "../src/lib/state"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"
import { createCodexPluginServiceRoutes } from "../src/routes/codex-plugins/route"
import { server } from "../src/server"

const CREATED_AT = "2026-09-03T00:00:00.000Z"
const JWT = "header.chatgpt-shaped-payload.signature"
const AUTHORIZATION = `Bearer ${JWT}`

function registerJwt(enabled = true): void {
  trustedJwtDigestStore.replaceForTest([
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Codex Desktop",
      digest: createHash("sha256").update(JWT, "utf8").digest("hex"),
      enabled,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ])
}

function setInferenceCredentialDigests(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  } else {
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = value
  }
}

function getFetchedUrl(value: string | URL | Request | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof URL) return value.href
  return value?.url ?? ""
}

beforeEach(() => {
  trustedJwtDigestStore.replaceForTest([])
})

afterAll(() => {
  trustedJwtDigestStore.resetAfterTest()
})

test("proxies the public plugin home without forwarding client credentials", async () => {
  registerJwt()
  const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(
      { sections: [{ id: "featured", title: "Popular", plugins: [] }] },
      {
        headers: {
          "access-control-allow-origin": "https://chatgpt.com",
          "content-type": "application/json",
          location: "https://chatgpt.com/redirected",
          nel: '{"report_to":"cf-nel"}',
          "report-to": '{"group":"cf-nel"}',
          "set-cookie": "upstream=private",
          "www-authenticate": "Bearer upstream",
          "x-accel-redirect": "/private",
          "x-upstream": "plugin-service",
        },
      },
    ),
  )
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: fetchMock as unknown as typeof fetch,
  })

  const response = await routes.request("/plugins/home", {
    headers: {
      authorization: AUTHORIZATION,
      cookie: "desktop=private",
      "chatgpt-account-id": "synthetic-account",
      "oai-language": "en-US",
      "oai-product-sku": "codex",
      originator: "Codex Desktop",
      "x-openai-attach-auth": "1",
      "x-openai-attach-integrity-state": "1",
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("set-cookie")).toBeNull()
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  expect(response.headers.get("location")).toBeNull()
  expect(response.headers.get("nel")).toBeNull()
  expect(response.headers.get("report-to")).toBeNull()
  expect(response.headers.get("www-authenticate")).toBeNull()
  expect(response.headers.get("x-accel-redirect")).toBeNull()
  expect(response.headers.get("x-upstream")).toBeNull()
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(response.headers.get("cache-control")).toBe("private, max-age=300")
  expect(response.headers.get("vary")).toBe("OAI-Language, OAI-Product-Sku")
  expect(await response.json()).toEqual({
    sections: [{ id: "featured", title: "Popular", plugins: [] }],
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  const [url, init] = fetchMock.mock.calls[0] ?? []
  let fetchedUrl: string
  if (typeof url === "string") fetchedUrl = url
  else if (url instanceof URL) fetchedUrl = url.href
  else fetchedUrl = url.url
  expect(fetchedUrl).toBe("https://chatgpt.com/backend-api/ps/plugins/home")
  const headers = new Headers(init?.headers)
  expect(headers.get("authorization")).toBeNull()
  expect(headers.get("cookie")).toBeNull()
  expect(headers.get("chatgpt-account-id")).toBeNull()
  expect(headers.get("x-openai-attach-auth")).toBeNull()
  expect(headers.get("x-openai-attach-integrity-state")).toBeNull()
  expect(headers.get("oai-language")).toBe("en-US")
  expect(headers.get("oai-product-sku")).toBe("codex")
  expect(headers.get("originator")).toBe("Codex Desktop")
  expect(init?.redirect).toBe("error")
})

test("derives category pages from the anonymous public home document", async () => {
  registerJwt()
  const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({
      sections: [
        {
          id: "developer tools",
          url_slug: "developer-tools",
          title: "Developer Tools",
          plugins: [{ id: "plugin_example", display_name: "Example" }],
        },
      ],
    }),
  )
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: fetchMock as unknown as typeof fetch,
  })

  const response = await routes.request(
    "/plugin-categories/developer-tools/plugins?scope=GLOBAL&limit=50",
    { headers: { authorization: AUTHORIZATION } },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    plugins: [{ id: "plugin_example", display_name: "Example" }],
    pagination: { next_page_token: null },
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(getFetchedUrl(fetchMock.mock.calls[0]?.[0])).toBe(
    "https://chatgpt.com/backend-api/ps/plugins/home",
  )
})

test("proxies a strict public plugin detail ID without client credentials", async () => {
  registerJwt()
  const pluginId = "plugin_connector_1p_1a69035c238881919c4190932b2df699"
  const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBeNull()
    return Response.json({
      id: pluginId,
      release: { display_name: "GitHub", interface: {} },
    })
  })
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: fetchMock as unknown as typeof fetch,
  })

  const response = await routes.request(`/plugins/${pluginId}`, {
    headers: { authorization: AUTHORIZATION },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: pluginId,
    release: { display_name: "GitHub", interface: {} },
  })
  expect(getFetchedUrl(fetchMock.mock.calls[0]?.[0])).toBe(
    `https://chatgpt.com/backend-api/ps/plugins/${pluginId}`,
  )
})

test.each([
  { id: "plugin_other", release: { interface: {} } },
  { id: "plugin_connector_1p_1a69035c238881919c4190932b2df699" },
  ["invalid-array-payload"],
])(
  "rejects malformed or mismatched public plugin detail %#",
  async (payload) => {
    registerJwt()
    const pluginId = "plugin_connector_1p_1a69035c238881919c4190932b2df699"
    const warnLog = spyOn(consola, "warn").mockImplementation(((
      ..._arguments: Array<unknown>
    ) => {}) as typeof consola.warn)
    const routes = createCodexPluginServiceRoutes({
      fetchImpl: mock(() => Response.json(payload)) as unknown as typeof fetch,
    })

    try {
      const response = await routes.request(`/plugins/${pluginId}`, {
        headers: { authorization: AUTHORIZATION },
      })

      expect(response.status).toBe(502)
    } finally {
      warnLog.mockRestore()
    }
  },
)

test.each([
  "/plugins/not-a-valid-public-id",
  "/plugins/plugin_bad%2Fescape",
  "/plugin-categories/Bad_Category/plugins",
  "/plugins/home/",
  "/plugin-categories/developer-tools/plugins/",
])("rejects an invalid public plugin lookup path %s", async (path) => {
  registerJwt()
  const fetchMock = mock(() => Response.json({}))
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: fetchMock as unknown as typeof fetch,
  })

  const response = await routes.request(path, {
    headers: { authorization: AUTHORIZATION },
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  "/plugins/list?scope=GLOBAL&limit=200",
  "/plugins/search?q=calendar&scope=USER&limit=50",
  "/plugins/installed?limit=200&includeDownloadUrls=true",
  "/plugins/workspace/created?limit=50",
  "/plugins/workspace/shared?limit=50",
])(
  "returns an empty page for unsupported cloud catalog route %s",
  async (path) => {
    registerJwt()
    const routes = createCodexPluginServiceRoutes()
    const response = await routes.request(path, {
      headers: { authorization: AUTHORIZATION },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      plugins: [],
      pagination: { next_page_token: null },
    })
  },
)

test("returns empty endpoint recommendations instead of falling back to legacy remote discovery", async () => {
  registerJwt()
  const routes = createCodexPluginServiceRoutes()
  const response = await routes.request(
    "/plugins/suggested/codex?scope=GLOBAL",
    { headers: { authorization: AUTHORIZATION } },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ enabled: true, plugins: [] })
})

test.each([
  ["missing", undefined],
  ["invalid", "Bearer invalid.jwt.value"],
] as const)("rejects a %s managed credential", async (_name, authorization) => {
  const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ sections: [] }),
  )
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: fetchMock as unknown as typeof fetch,
  })
  const response = await routes.request("/plugins/home", {
    headers: authorization === undefined ? {} : { authorization },
  })

  expect(response.status).toBe(401)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects a disabled managed credential", async () => {
  registerJwt(false)
  const routes = createCodexPluginServiceRoutes()
  const response = await routes.request("/plugins/list", {
    headers: { authorization: AUTHORIZATION },
  })

  expect(response.status).toBe(401)
})

test("keeps mutations and adjacent plugin paths unavailable", async () => {
  registerJwt()
  const routes = createCodexPluginServiceRoutes()

  const mutation = await routes.request("/plugins/example/install", {
    method: "POST",
    headers: { authorization: AUTHORIZATION },
  })
  const adjacent = await routes.request("/plugins/home/extra", {
    headers: { authorization: AUTHORIZATION },
  })
  const detailMutation = await routes.request(
    "/plugins/plugin_connector_1p_1a69035c238881919c4190932b2df699/install",
    { method: "POST", headers: { authorization: AUTHORIZATION } },
  )

  expect(mutation.status).toBe(404)
  expect(adjacent.status).toBe(404)
  expect(detailMutation.status).toBe(404)
})

test("returns a bounded JSON error when the public directory request fails", async () => {
  registerJwt()
  const errorLog = spyOn(consola, "error").mockImplementation(((
    ..._arguments: Array<unknown>
  ) => {}) as typeof consola.error)
  try {
    const fetchMock = mock(() => Promise.reject(new Error("private details")))
    const routes = createCodexPluginServiceRoutes({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const response = await routes.request("/plugins/home", {
      headers: { authorization: AUTHORIZATION },
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "Plugin directory temporarily unavailable",
        type: "upstream_error",
      },
    })
    expect(errorLog).toHaveBeenCalledWith(
      "[codex-plugins] Public directory request failed",
      { errorName: "Error", pathname: "/plugins/home" },
    )
  } finally {
    errorLog.mockRestore()
  }
})

test("maps an upstream public-directory error to a bounded uncached response", async () => {
  registerJwt()
  const warnLog = spyOn(consola, "warn").mockImplementation(((
    ..._arguments: Array<unknown>
  ) => {}) as typeof consola.warn)
  const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ detail: "temporarily unavailable" }, { status: 503 }),
  )
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: fetchMock as unknown as typeof fetch,
  })

  try {
    const response = await routes.request("/plugins/home", {
      headers: { authorization: AUTHORIZATION },
    })

    expect(response.status).toBe(502)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      error: {
        message: "Plugin directory temporarily unavailable",
        type: "upstream_error",
      },
    })
    expect(warnLog).toHaveBeenCalledWith(
      "[codex-plugins] Public directory request rejected",
      { pathname: "/plugins/home", status: 503 },
    )
  } finally {
    warnLog.mockRestore()
  }
})

test("rejects a non-JSON public-directory response", async () => {
  registerJwt()
  const warnLog = spyOn(consola, "warn").mockImplementation(((
    ..._arguments: Array<unknown>
  ) => {}) as typeof consola.warn)
  const routes = createCodexPluginServiceRoutes({
    fetchImpl: mock(
      () =>
        new Response("<html>blocked</html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
    ) as unknown as typeof fetch,
  })

  try {
    const response = await routes.request("/plugins/home", {
      headers: { authorization: AUTHORIZATION },
    })

    expect(response.status).toBe(502)
    expect(warnLog).toHaveBeenCalledWith(
      "[codex-plugins] Public directory request rejected",
      { pathname: "/plugins/home", status: 200 },
    )
  } finally {
    warnLog.mockRestore()
  }
})

test("redacts plugin search terms and cursors from request diagnostics", () => {
  expect(
    sanitizeRequestDiagnosticReference(
      "GET",
      "/ps/plugins/search?q=private+query&scope=USER&pageToken=private-cursor",
    ),
  ).toBe("/ps/plugins/search?q=[REDACTED]&scope=USER&pageToken=[REDACTED]")

  expect(
    sanitizeRequestDiagnosticReference(
      "GET",
      "https://voice.openai.com/ps/plugins/search?scope=GLOBAL&q=private",
    ),
  ).toBe("https://voice.openai.com/ps/plugins/search?scope=GLOBAL&q=[REDACTED]")

  expect(
    sanitizeRequestDiagnosticReference(
      "GET",
      "/ps/plugin-categories/developer-tools/plugins?scope=GLOBAL&pageToken=private-cursor",
    ),
  ).toBe(
    "/ps/plugin-categories/developer-tools/plugins?scope=GLOBAL&pageToken=[REDACTED]",
  )
})

test("mounts plugin compatibility before the gateway and inference guards", async () => {
  registerJwt()
  const response = await server.request(
    "/ps/plugins/list?scope=GLOBAL&limit=200",
    { headers: { authorization: AUTHORIZATION } },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    plugins: [],
    pagination: { next_page_token: null },
  })
})

test("does not let a gateway credential impersonate a managed Desktop identity", async () => {
  const originalGatewayKey = state.apiKeyAuth
  state.apiKeyAuth = "gateway-only-test-key"
  try {
    const routes = createCodexPluginServiceRoutes()
    const response = await routes.request("/plugins/list", {
      headers: { authorization: "Bearer gateway-only-test-key" },
    })

    expect(response.status).toBe(401)
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.apiKeyAuth = originalGatewayKey
  }
})

test("does not let an environment inference credential impersonate a managed Desktop identity", async () => {
  const secret = "environment-inference-only-secret"
  const previous = process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  setInferenceCredentialDigests(
    createHash("sha256").update(secret, "utf8").digest("hex"),
  )
  try {
    const routes = createCodexPluginServiceRoutes()
    const response = await routes.request("/plugins/list", {
      headers: { authorization: `Bearer ${secret}` },
    })

    expect(response.status).toBe(401)
  } finally {
    setInferenceCredentialDigests(previous)
  }
})
