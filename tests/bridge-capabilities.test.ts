import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  authorizeEnvironmentCapability,
  authorizeWorkerCapability,
  bindWorkerCapability,
  issueEnvironmentCapability,
  issueWorkerCapability,
  resetBridgeCapabilitiesForTest,
} from "../src/lib/bridge-capabilities"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { OAuthStore, setOAuthStoreForTest } from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import {
  CODE_SESSION_MAX_BODY_BYTES,
  CODE_SESSION_MAX_EVENTS_PER_REQUEST,
} from "../src/routes/code-sessions/route"
import { server } from "../src/server"

const GATEWAY_KEY = "bridge-test-gateway-key-with-enough-entropy"

function bearer(value: string): { authorization: string } {
  return { authorization: `Bearer ${value}` }
}

beforeEach(() => {
  state.apiKeyAuth = GATEWAY_KEY
  resetIpSecurityForTest()
  setOAuthStoreForTest(new OAuthStore())
  resetBridgeCapabilitiesForTest()
})

afterEach(() => {
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

test("code-session writes reject oversized bodies and event batches", async () => {
  const oversized = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(GATEWAY_KEY),
    },
    body: JSON.stringify({ title: "x".repeat(CODE_SESSION_MAX_BODY_BYTES) }),
  })
  expect(oversized.status).toBe(413)

  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Bounded events" }),
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
  const workerBatch = await server.request(
    `/v1/code/sessions/${sessionId}/worker/events`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(worker.worker_jwt),
      },
      body: JSON.stringify({
        worker_epoch: worker.worker_epoch,
        events: Array.from(
          { length: CODE_SESSION_MAX_EVENTS_PER_REQUEST + 1 },
          () => ({ payload: {} }),
        ),
      }),
    },
  )
  expect(workerBatch.status).toBe(400)
})
