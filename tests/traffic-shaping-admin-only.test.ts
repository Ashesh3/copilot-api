import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  getUserReplacements,
  setReplacementsForTest,
} from "../src/lib/auto-replace"
import {
  getAllModelRedirects,
  setModelRedirectsForTest,
} from "../src/lib/model-redirect"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const GATEWAY_KEY = "test-dashboard-gateway-key-with-enough-entropy"

beforeEach(() => {
  state.apiKeyAuth = GATEWAY_KEY
  setReplacementsForTest([])
  setModelRedirectsForTest([])
})

afterEach(() => {
  resetTestAdminSession()
  setReplacementsForTest([])
  setModelRedirectsForTest([])
})

test("inference credentials cannot mutate replacements or model redirects", async () => {
  const replacementCreate = await server.request("/replacements", {
    method: "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      pattern: "secret",
      replacement: "redacted",
    }),
  })
  expect(replacementCreate.status).toBe(404)
  expect(await getUserReplacements()).toHaveLength(0)

  const redirectCreate = await server.request("/model-redirects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sourceModel: "claude-source",
      targetModel: "claude-target",
    }),
  })
  expect(redirectCreate.status).toBe(404)
  expect(await getAllModelRedirects()).toHaveLength(0)

  const replacementList = await server.request("/replacements", {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
  })
  expect(replacementList.status).toBe(404)

  const redirectList = await server.request("/model-redirects", {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
  })
  expect(redirectList.status).toBe(404)
})

test("dashboard admin session can manage replacements and model redirects", async () => {
  const session: TestAdminSession = await createTestAdminSession()

  const createReplacement = await server.request(
    "/dashboard/api/replacements",
    {
      method: "POST",
      headers: adminHeaders(session),
      body: JSON.stringify({
        pattern: "needle",
        replacement: "haystack",
        name: "admin-rule",
      }),
    },
  )
  expect(createReplacement.status).toBe(200)
  const replacement = (await createReplacement.json()) as { id: string }
  expect(replacement.id).toBeTruthy()
  expect(await getUserReplacements()).toHaveLength(1)

  const listReplacements = await server.request("/dashboard/api/replacements", {
    headers: adminHeaders(session, false),
  })
  expect(listReplacements.status).toBe(200)

  const createRedirect = await server.request(
    "/dashboard/api/model-redirects",
    {
      method: "POST",
      headers: adminHeaders(session),
      body: JSON.stringify({
        sourceModel: "claude-source",
        targetModel: "claude-target",
        name: "admin-redirect",
      }),
    },
  )
  expect(createRedirect.status).toBe(200)
  const redirect = (await createRedirect.json()) as { id: string }
  expect(redirect.id).toBeTruthy()
  expect(await getAllModelRedirects()).toHaveLength(1)

  const listRedirects = await server.request("/dashboard/api/model-redirects", {
    headers: adminHeaders(session, false),
  })
  expect(listRedirects.status).toBe(200)
})

test("dashboard mutations reject missing admin session even with gateway key", async () => {
  const response = await server.request("/dashboard/api/replacements", {
    method: "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      "content-type": "application/json",
      origin: "https://ai.ashesh.dev",
    },
    body: JSON.stringify({
      pattern: "should-not-work",
      replacement: "x",
    }),
  })
  expect(response.status).toBe(401)
  expect(await getUserReplacements()).toHaveLength(0)
})
