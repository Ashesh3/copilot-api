import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import { setConfigForTest } from "../src/lib/config"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { isIpWhitelisted, unwhitelistIp } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => {
  return new Response(JSON.stringify({ text: "hello from dictation" }), {
    headers: { "content-type": "application/json" },
  })
})

const chatCompletionsMock = mock(
  (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "cleaned text" } }],
      }),
      { headers: { "content-type": "application/json" } },
    )
  },
)

beforeEach(() => {
  state.apiKeyAuth = undefined
  state.models = { object: "list", data: [] }
  state.copilotToken = "copilot-token"
  setConfigForTest({
    auth: { apiKeys: ["config-secret"] },
    groqApiKey: "groq-secret",
  })
  setIpAllowlistForTest([])
  fetchMock.mockClear()
  chatCompletionsMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  // Drop any IP whitelisted by an earlier test so each case starts from a
  // known, un-whitelisted state.
  for (const ip of [
    "203.0.113.44",
    "203.0.113.45",
    "203.0.113.46",
    "203.0.113.50",
    "203.0.113.51",
    "203.0.113.52",
    "203.0.113.53",
    "203.0.113.54",
    "203.0.113.55",
    "203.0.113.56",
  ]) {
    unwhitelistIp(ip)
  }
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  setConfigForTest(null)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("configured API-key auth does not permanently whitelist transcribe IP", async () => {
  const clientIp = "203.0.113.44"

  const modelsResponse = await server.request("/v1/models", {
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
  })

  expect(modelsResponse.status).toBe(200)
  expect(isIpWhitelisted(clientIp)).toBe(false)

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const transcribeResponse = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(transcribeResponse.status).toBe(404)
})

test("transcribe still rejects an IP that has not authenticated", async () => {
  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": "203.0.113.45",
    },
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
      "x-copilot-peer-ip": "127.0.0.1",
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
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": ipv6,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
})

// ──────────────────────────────────────────────────────────────────────────────
// authorizeCodexDesktopRequest direct-bearer path (codex-desktop-spoof flow).
// When CODEX_API_BASE_URL is pointed at a spoofed *.openai.com hostname,
// Codex Desktop's main process attaches `Authorization: Bearer <key>` to
// the very first /transcribe (or /codex/responses) call, BEFORE the IP has
// authed against any other route. The endpoints accept that bearer directly
// without converting that request into permanent IP trust.

test("transcribe: direct Authorization Bearer is accepted without whitelisting", async () => {
  const clientIp = "203.0.113.50"
  expect(isIpWhitelisted(clientIp)).toBe(false)

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: "hello from dictation" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(isIpWhitelisted(clientIp)).toBe(false)

  const followup = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })
  expect(followup.status).toBe(404)
})

test("transcribe: direct x-api-key header is accepted", async () => {
  const clientIp = "203.0.113.51"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-api-key": "config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("transcribe: wrong bearer is silently dropped (no IP whitelisted)", async () => {
  const clientIp = "203.0.113.52"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("transcribe: invalid bearer cannot fall through to an allowed IP", async () => {
  const clientIp = "203.0.113.52"
  setIpAllowlistForTest([{ ip: clientIp, enabled: true }])

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("transcribe: when no API keys are configured, only IP whitelist gates the route", async () => {
  // Strip all configured API keys to simulate a deployment that's relying on
  // IP whitelist alone (the pre-change behavior of the route).
  setConfigForTest({ groqApiKey: "groq-secret" })
  const clientIp = "203.0.113.53"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  // Without any auth at all, a fresh IP is rejected.
  const reject = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })
  expect(reject.status).toBe(404)

  // A bearer that would have been valid in a key-configured deployment is
  // also rejected — the route MUST NOT trust headers when no keys exist.
  const rejectBearer = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer anything",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })
  expect(rejectBearer.status).toBe(404)
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("codex-responses: direct Authorization Bearer is accepted", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chatCompletionsMock as unknown as typeof fetch

  const clientIp = "203.0.113.54"

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      instructions: "cleanup",
      input: [
        { type: "message", role: "user", content: [{ text: "hi there" }] },
      ],
    }),
  })

  expect(response.status).toBe(200)
  const text = await response.text()
  // Hono streamSSE wraps each writeSSE in `data: ...\n\n`.
  expect(text).toContain('"type":"response.output_text.done"')
  expect(text).toContain('"text":"cleaned text"')
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("codex-responses: wrong bearer is silently dropped", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chatCompletionsMock as unknown as typeof fetch

  const clientIp = "203.0.113.55"

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })

  expect(response.status).toBe(404)
  expect(chatCompletionsMock).not.toHaveBeenCalled()
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("codex-responses: invalid bearer cannot fall through to an allowed IP", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chatCompletionsMock as unknown as typeof fetch

  const clientIp = "203.0.113.55"
  setIpAllowlistForTest([{ ip: clientIp, enabled: true }])

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })

  expect(response.status).toBe(404)
  expect(chatCompletionsMock).not.toHaveBeenCalled()
})

test("transcribe: --api-key-auth CLI key is honored as a direct bearer", async () => {
  // Single-key mode (state.apiKeyAuth) — must work the same as the multi-key
  // config.auth.apiKeys path because getActiveApiKeys() promotes it.
  state.apiKeyAuth = "cli-secret"
  setConfigForTest({ groqApiKey: "groq-secret" }) // no config keys
  const clientIp = "203.0.113.56"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer cli-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(isIpWhitelisted(clientIp)).toBe(false)
})
