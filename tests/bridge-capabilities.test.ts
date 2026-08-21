import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  authorizeEnvironmentCapability,
  authorizeWorkerCapability,
  bindWorkerCapability,
  issueEnvironmentCapability,
  issueWorkerCapability,
  resetBridgeCapabilitiesForTest,
} from "../src/lib/bridge-capabilities"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { OAuthStore, setOAuthStoreForTest } from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const GATEWAY_KEY = "bridge-test-gateway-key-with-enough-entropy"

function bearer(value: string): { authorization: string } {
  return { authorization: `Bearer ${value}` }
}

beforeEach(() => {
  setIpAllowlistForTest([])
  state.apiKeyAuth = GATEWAY_KEY
  resetIpSecurityForTest()
  setOAuthStoreForTest(new OAuthStore())
  resetBridgeCapabilitiesForTest()
})

afterEach(() => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  state.apiKeyAuth = undefined
  setOAuthStoreForTest(null)
  resetBridgeCapabilitiesForTest()
})

test("code sessions require a scoped user credential", async () => {
  const denied = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Denied" }),
  })
  expect(denied.status).toBe(401)

  const allowed = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Allowed" }),
  })
  expect(allowed.status).toBe(201)
})

test("code-session and session guards record missing credentials", async () => {
  for (const [clientIp, path, method] of [
    ["198.51.100.96", "/v1/code/sessions", "POST"],
    ["198.51.100.97", "/v1/sessions", "GET"],
  ] as const) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await server.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-copilot-peer-ip": clientIp,
        },
        ...(method === "POST" ? { body: JSON.stringify({ title: "x" }) } : {}),
      })
      expect(response.status).toBe(401)
    }
    expect(isIpBlocked(clientIp)).toBe(true)
  }
})

test("worker capability failures record missing credentials", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker failures" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const clientIp = "198.51.100.98"

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (
        await server.request(`/v1/code/sessions/${sessionId}/worker`, {
          headers: { "x-copilot-peer-ip": clientIp },
        })
      ).status,
    ).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(true)
})

test("stale worker epochs count toward the shared IP ban", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Stale worker epoch" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const firstBridge = await server.request(
    `/v1/code/sessions/${sessionId}/bridge`,
    {
      method: "POST",
      headers: bearer(GATEWAY_KEY),
    },
  )
  const firstWorker = (await firstBridge.json()) as {
    worker_jwt: string
    worker_epoch: number
  }
  expect(firstWorker.worker_epoch).toBe(1)
  const secondBridge = await server.request(
    `/v1/code/sessions/${sessionId}/bridge`,
    {
      method: "POST",
      headers: bearer(GATEWAY_KEY),
    },
  )
  const secondWorker = (await secondBridge.json()) as { worker_epoch: number }
  expect(secondWorker.worker_epoch).toBe(2)

  const clientIp = "198.51.100.101"
  const clientHeaders = {
    ...bearer(firstWorker.worker_jwt),
    "x-copilot-peer-ip": "127.0.0.1",
    "x-forwarded-for": clientIp,
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request(
      `/v1/code/sessions/${sessionId}/worker`,
      { headers: clientHeaders },
    )
    expect(response.status).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(true)
})

test("missing worker sessions do not count as credential failures", async () => {
  const sessionId = "cse_missing"
  const clientIp = "198.51.100.102"
  const headers = {
    ...bearer(issueWorkerCapability(sessionId, 1)),
    "x-copilot-peer-ip": "127.0.0.1",
    "x-forwarded-for": clientIp,
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request(
      `/v1/code/sessions/${sessionId}/worker`,
      { headers },
    )
    expect(response.status).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(false)
})

test("environment OAuth and capability guards record failures", async () => {
  for (const [clientIp, path, method] of [
    ["198.51.100.99", "/v1/environments/bridge", "POST"],
    ["198.51.100.100", "/v1/environments/env_missing/work/poll", "GET"],
  ] as const) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await server.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-copilot-peer-ip": clientIp,
        },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      })
      expect(response.status).toBe(401)
    }
    expect(isIpBlocked(clientIp)).toBe(true)
  }
})

test("worker capabilities are opaque, session-bound and epoch-bound", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const credentials = (await bridge.json()) as {
    worker_jwt: string
    worker_epoch: number
  }
  expect(credentials.worker_jwt).not.toContain(GATEWAY_KEY)
  expect(
    (
      await authorizeWorkerCapability(
        new Request("https://example.test", {
          headers: bearer(credentials.worker_jwt),
        }),
        sessionId,
      )
    )?.workerEpoch,
  ).toBe(credentials.worker_epoch)

  const crossSession = issueWorkerCapability("cse_other")
  expect(
    await authorizeWorkerCapability(
      new Request("https://example.test", { headers: bearer(crossSession) }),
      sessionId,
    ),
  ).toBeNull()
  expect(bindWorkerCapability(credentials.worker_jwt, sessionId, 99)).toBe(true)
})

test("worker HTTP routes reject user and cross-session credentials", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker routes" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const token = ((await bridge.json()) as { worker_jwt: string }).worker_jwt

  expect(
    (
      await server.request(`/v1/code/sessions/${sessionId}/worker`, {
        headers: bearer(GATEWAY_KEY),
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await server.request(`/v1/code/sessions/${sessionId}/worker`, {
        headers: bearer(issueWorkerCapability("cse_other")),
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await server.request(`/v1/code/sessions/${sessionId}/worker`, {
        headers: bearer(token),
      })
    ).status,
  ).toBe(200)
})

test("worker capability can open the client event SSE stream", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker SSE" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const token = ((await bridge.json()) as { worker_jwt: string }).worker_jwt

  const response = await server.request(
    `/v1/code/sessions/${sessionId}/events/stream`,
    { headers: bearer(token) },
  )

  expect(response.status).toBe(200)
  await response.body?.cancel()
})

test("environment capabilities are opaque and environment-bound", async () => {
  const first = issueEnvironmentCapability("env_first")
  const second = issueEnvironmentCapability("env_second")
  expect(first).not.toBe(second)
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", { headers: bearer(first) }),
      "env_first",
    ),
  ).toBe(true)
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", { headers: bearer(first) }),
      "env_second",
    ),
  ).toBe(false)
})

test("bridge capability stores do not evict active credentials by count", async () => {
  const workerSessionId = "cse_capacity"
  const worker = issueWorkerCapability(workerSessionId)
  for (let index = 0; index < 600; index += 1) {
    issueWorkerCapability(`cse_other_${index}`)
  }
  expect(
    await authorizeWorkerCapability(
      new Request("https://example.test", { headers: bearer(worker) }),
      workerSessionId,
    ),
  ).not.toBeNull()

  const environment = issueEnvironmentCapability("env_capacity")
  for (let index = 0; index < 150; index += 1) {
    issueEnvironmentCapability(`env_other_${index}`)
  }
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", { headers: bearer(environment) }),
      "env_capacity",
    ),
  ).toBe(true)
})

test("code-session writes accept large bodies and event batches", async () => {
  const largeSession = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(GATEWAY_KEY),
    },
    body: JSON.stringify({ title: "x".repeat(1024 * 1024 + 1) }),
  })
  expect(largeSession.status).toBe(201)

  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Complete events" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const worker = (await bridge.json()) as {
    worker_epoch: number
    worker_jwt: string
  }
  const clientIp = "198.51.100.103"
  const workerBatch = await server.request(
    `/v1/code/sessions/${sessionId}/worker/events`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(worker.worker_jwt),
        "x-copilot-peer-ip": "127.0.0.1",
        "x-forwarded-for": clientIp,
      },
      body: JSON.stringify({
        worker_epoch: worker.worker_epoch,
        events: Array.from({ length: 101 }, () => ({ payload: {} })),
      }),
    },
  )
  expect(workerBatch.status).toBe(200)
  expect(isIpBlocked(clientIp)).toBe(false)
})
