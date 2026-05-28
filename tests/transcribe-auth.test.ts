import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import { setConfigForTest } from "../src/lib/config"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { isIpWhitelisted } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalModels = state.models
const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => {
  return new Response(JSON.stringify({ text: "hello from dictation" }), {
    headers: { "content-type": "application/json" },
  })
})

beforeEach(() => {
  state.apiKeyAuth = undefined
  state.models = { object: "list", data: [] }
  setConfigForTest({
    auth: { apiKeys: ["config-secret"] },
    groqApiKey: "groq-secret",
  })
  setIpAllowlistForTest([])
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  state.models = originalModels
  setConfigForTest(null)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("configured API-key auth whitelists the IP for transcribe", async () => {
  const clientIp = "203.0.113.44"

  const modelsResponse = await server.request("/v1/models", {
    headers: {
      authorization: "Bearer config-secret",
      "x-forwarded-for": clientIp,
    },
  })

  expect(modelsResponse.status).toBe(200)
  expect(isIpWhitelisted(clientIp)).toBe(true)

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const transcribeResponse = await server.request("/transcribe", {
    method: "POST",
    headers: { "x-forwarded-for": clientIp },
    body: formData,
  })

  expect(transcribeResponse.status).toBe(200)
  expect(await transcribeResponse.json()).toEqual({
    text: "hello from dictation",
  })
})

test("transcribe still rejects an IP that has not authenticated", async () => {
  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.45" },
    body: formData,
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("managed allowlist accepts a different IPv6 address for transcribe", async () => {
  const ipv4 = "203.0.113.46"
  const ipv6 = "2406:7400:63:c69b:78ad:65b1:41f5:ccce"

  const modelsResponse = await server.request("/v1/models", {
    headers: {
      authorization: "Bearer config-secret",
      "x-forwarded-for": ipv4,
    },
  })
  expect(modelsResponse.status).toBe(200)

  setIpAllowlistForTest([
    {
      ip: ipv6,
      enabled: true,
      source: "manual",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    },
  ])

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: { "x-forwarded-for": ipv6 },
    body: formData,
  })

  expect(response.status).toBe(200)
})
