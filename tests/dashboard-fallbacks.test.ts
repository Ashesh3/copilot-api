import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"

import {
  getLoadedModelFallbackConfig,
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "../src/lib/model-fallback-config"
import {
  addModelRedirect,
  loadModelRedirects,
  setModelRedirectsForTest,
} from "../src/lib/model-redirect"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  TEST_GATEWAY_KEY,
  type TestAdminSession,
} from "./helpers/admin-session"

let adminSession: TestAdminSession

beforeAll(async () => {
  adminSession = await createTestAdminSession()
})

beforeEach(() => {
  setModelFallbackConfigForTest(validateModelFallbackConfig({}))
  setModelRedirectsForTest([])
})

afterAll(async () => {
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  await resetTestAdminSession()
})

test("dashboard reports mixed routing loops and automatically clears warnings after correction", async () => {
  setModelRedirectsForTest([
    {
      id: "back",
      sourceModel: "b",
      sourceEffort: "all",
      targetModel: "a",
      enabled: true,
    },
  ])
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        { id: "fallback", sourceModel: "a", targetModel: "b", enabled: true },
      ],
    }),
  )
  const headers = adminHeaders(adminSession, false)
  const response = await server.request("/dashboard/api/model-routing-safety", {
    headers,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    safe: false,
    loop: { kind: "combined", models: ["a", "b", "a"] },
  })
  const fallbacks = await server.request("/dashboard/api/fallbacks", {
    headers,
  })
  expect(await fallbacks.json()).toMatchObject({ safety: { safe: false } })
  setModelRedirectsForTest([])
  const corrected = await server.request(
    "/dashboard/api/model-routing-safety",
    { headers },
  )
  expect(await corrected.json()).toEqual({ safe: true })
})

test("persisted fallback mutations return safety for the committed settings", async () => {
  setModelFallbackConfigForTest(null)
  await loadModelRedirects()
  await addModelRedirect("stored-b", "stored-a")
  const config = validateModelFallbackConfig({
    enabled: true,
    rules: [
      {
        id: "stored",
        sourceModel: "stored-a",
        targetModel: "stored-b",
        enabled: true,
      },
    ],
  })
  const update = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: JSON.stringify(config),
  })
  expect(update.status).toBe(200)
  expect(await update.json()).toMatchObject({ config, safety: { safe: false } })
  const correction = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: JSON.stringify({ ...config, rules: [] }),
  })
  expect(await correction.json()).toMatchObject({ safety: { safe: true } })
})

test("fallback settings require dashboard authentication", async () => {
  const response = await server.request("/dashboard/api/fallbacks")
  expect(response.status).toBe(401)
})

test("authenticated fallback settings include configuration and safety only", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    headers: adminHeaders(adminSession, false),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    config: { enabled: boolean; rules: Array<unknown> }
    safety: { safe: boolean }
  }
  expect(typeof body.config.enabled).toBe("boolean")
  expect(Array.isArray(body.config.rules)).toBe(true)
  expect(typeof body.safety.safe).toBe("boolean")
  expect(body).not.toHaveProperty("cache")
})

test("fallback mutations require the admin CSRF header", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession, false),
    body: JSON.stringify({ enabled: true }),
  })
  expect(response.status).toBe(401)
  expect(getLoadedModelFallbackConfig().enabled).toBe(false)
})

test("stale dashboard revisions cannot overwrite a newer fallback configuration", async () => {
  setModelFallbackConfigForTest(null)
  const original = await server.request("/dashboard/api/fallbacks", {
    headers: adminHeaders(adminSession, false),
  })
  const before = (await original.json()) as {
    config: ReturnType<typeof validateModelFallbackConfig>
    revision: number
  }
  expect(Number.isSafeInteger(before.revision)).toBe(true)
  const headers = {
    ...adminHeaders(adminSession),
    "if-match": JSON.stringify(String(before.revision)),
  }
  const first = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...before.config,
      notifyClient: !before.config.notifyClient,
    }),
  })
  expect(first.status).toBe(200)
  const committed = (await first.json()) as {
    config: unknown
    revision: number
  }
  expect(committed.revision).toBeGreaterThan(before.revision)
  const stale = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...before.config, rules: [] }),
  })
  expect(stale.status).toBe(409)
  const current = await server.request("/dashboard/api/fallbacks", {
    headers: adminHeaders(adminSession, false),
  })
  expect(await current.json()).toMatchObject(committed)
})

test("fallback PUT strips legacy affinity settings and GET returns canonical settings", async () => {
  const requestConfig = {
    enabled: true,
    conversationAffinity: false,
    notifyClient: true,
    nativeClientNotice: true,
    affinityTtlSeconds: 120,
    affinityMaxEntries: 25,
    rules: [
      {
        id: "test-rule",
        sourceModel: "source",
        targetModel: "alternate",
        enabled: true,
      },
    ],
  }
  const config = validateModelFallbackConfig(requestConfig)
  const update = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: JSON.stringify(requestConfig),
  })
  expect(update.status).toBe(200)
  const updated = (await update.json()) as { revision: number }
  expect(Number.isSafeInteger(updated.revision)).toBe(true)
  expect(updated).toMatchObject({
    config,
    safety: { safe: true },
  })

  const read = await server.request("/dashboard/api/fallbacks", {
    headers: adminHeaders(adminSession, false),
  })
  expect(await read.json()).toEqual(updated)
})

test("invalid fallback requests cannot replace the active configuration", async () => {
  const baseline = getLoadedModelFallbackConfig()
  const invalidBodies: Array<unknown> = [
    null,
    [],
    { enabled: "true" },
    { affinityTtl: 0 },
    { affinityEntries: 100001 },
    { rules: [{ id: "invalid", sourceModel: "same", targetModel: "same" }] },
    {
      rules: [
        { id: "first", sourceModel: "source", targetModel: "alternate" },
        { id: "second", sourceModel: "source", targetModel: "other" },
      ],
    },
  ]
  for (const body of invalidBodies) {
    const response = await server.request("/dashboard/api/fallbacks", {
      method: "PUT",
      headers: adminHeaders(adminSession),
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect(typeof ((await response.json()) as { error: unknown }).error).toBe(
      "string",
    )
    expect(getLoadedModelFallbackConfig()).toEqual(baseline)
  }
})

test("fallback PUT rejects malformed JSON with a readable error", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: "{",
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: "Request body must be valid JSON",
  })
})

test("fallback validation errors identify the field without raw validator JSON", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: JSON.stringify({
      rules: [{ id: "", sourceModel: "a", targetModel: "b" }],
    }),
  })
  const body = (await response.json()) as { error: string }
  expect(response.status).toBe(400)
  expect(body.error).toContain("rules.0.id:")
  expect(body.error).not.toContain('"code"')
})

test("removed fallback cache endpoint returns not found", async () => {
  const response = await server.request("/dashboard/api/fallbacks/cache", {
    headers: {
      ...adminHeaders(adminSession, false),
      authorization: `Bearer ${TEST_GATEWAY_KEY}`,
    },
  })
  expect(response.status).toBe(404)
})

test("dashboard bundle exposes full chains and client notice controls without cache controls", () => {
  expect(DASHBOARD_HTML).toContain("/dashboard/api/fallbacks")
  expect(DASHBOARD_HTML).not.toContain("/dashboard/api/fallbacks/cache")
  expect(DASHBOARD_HTML).toContain("Enable fallbacks")
  expect(DASHBOARD_HTML).not.toContain("3 fallback hops (4 model attempts)")
  expect(DASHBOARD_HTML).toContain("Configured chains")
  expect(DASHBOARD_HTML).toContain("fallback-connector")
  expect(DASHBOARD_HTML).toContain("Also redirects here:")
  expect(DASHBOARD_HTML).not.toContain("fallback rules do not form a chain")
  expect(DASHBOARD_HTML).toContain("Include diagnostic response headers")
  expect(DASHBOARD_HTML).toContain("Show native client fallback notice")
})
