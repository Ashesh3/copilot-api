import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const TRUSTED_ORIGIN = "https://client.example"
const originalOrigins = process.env.COPILOT_INFERENCE_CORS_ORIGINS
const originalGatewayKey = state.apiKeyAuth
const originalModels = state.models

const corsModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "model.with-dashes",
      name: "CORS Model",
      object: "model",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

beforeEach(() => {
  process.env.COPILOT_INFERENCE_CORS_ORIGINS = TRUSTED_ORIGIN
  state.apiKeyAuth = "cors-gateway-key"
  state.models = structuredClone(corsModels)
  resetIpSecurityForTest()
})

afterAll(() => {
  if (originalOrigins === undefined) {
    delete process.env.COPILOT_INFERENCE_CORS_ORIGINS
  } else {
    process.env.COPILOT_INFERENCE_CORS_ORIGINS = originalOrigins
  }
  state.apiKeyAuth = originalGatewayKey
  state.models = originalModels
  resetIpSecurityForTest()
})

function preflight(
  pathname: string,
  method: string | undefined,
  origin = TRUSTED_ORIGIN,
): Promise<Response> {
  const headers = new Headers({ origin })
  if (method !== undefined) {
    headers.set("access-control-request-method", method)
  }
  return Promise.resolve(
    server.request(pathname, { method: "OPTIONS", headers }),
  )
}

function actual(
  pathname: string,
  method: "GET" | "POST",
  origin = TRUSTED_ORIGIN,
): Promise<Response> {
  return Promise.resolve(
    server.request(pathname, {
      method,
      headers: {
        "content-type": "application/json",
        origin,
        "x-copilot-peer-ip": "198.51.100.220",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
  )
}

function expectNoGrant(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  expect(response.headers.get("vary")).toBeNull()
}

function expectActualGrant(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBe(
    TRUSTED_ORIGIN,
  )
  expect(response.headers.get("vary")).toBe("Origin")
  expect(response.headers.get("access-control-allow-credentials")).toBeNull()
}

function expectPreflightGrant(response: Response): void {
  expect(response.status).toBe(204)
  expect(response.headers.get("access-control-allow-origin")).toBe(
    TRUSTED_ORIGIN,
  )
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "GET, POST, OPTIONS",
  )
  expect(response.headers.get("access-control-allow-headers")).toBe(
    "authorization, content-type, x-api-key, x-goog-api-key",
  )
  expect(response.headers.get("access-control-max-age")).toBe("600")
  expect(response.headers.get("vary")).toBe("Origin")
  expect(response.headers.get("access-control-allow-credentials")).toBeNull()

  const allowedHeaders =
    response.headers.get("access-control-allow-headers") ?? ""
  expect(allowedHeaders).toContain("x-goog-api-key")
  expect(allowedHeaders).not.toContain("*")
  expect(allowedHeaders).not.toContain("cookie")
  expect(allowedHeaders).not.toContain("csrf")
  expect(allowedHeaders).not.toContain("x-copilot-gateway-key")
}

test("inference CORS is disabled by default", async () => {
  delete process.env.COPILOT_INFERENCE_CORS_ORIGINS
  expectNoGrant(
    await server.request("/v1/models", {
      headers: { origin: TRUSTED_ORIGIN },
    }),
  )
})

test.each([
  ["GET", "/models"],
  ["GET", "/v1/models"],
  ["GET", "/models/model.with-dashes"],
  ["GET", "/v1/models/model.with-dashes/"],
  ["POST", "/chat/completions"],
  ["POST", "/v1/chat/completions"],
  ["POST", "/embeddings"],
  ["POST", "/v1/embeddings"],
  ["POST", "/v1/messages"],
  ["POST", "/v1/messages/count_tokens"],
  ["POST", "/responses"],
  ["POST", "/responses/compact"],
  ["POST", "/v1/responses"],
  ["POST", "/v1/responses/compact"],
  ["POST", "/models/model.with-dashes:generateContent"],
  ["POST", "/v1/models/model.with-dashes:streamGenerateContent"],
  ["POST", "/v1beta/models/model.with-dashes:countTokens"],
  ["POST", "/alpha/search"],
  ["POST", "/v1/alpha/search"],
  ["POST", "/codex/responses"],
  ["POST", "/models/session"],
  ["POST", "/models/session/intent"],
  ["POST", "/auto"],
] as const)("grants %s inference CORS only on %s", async (method, pathname) => {
  expectPreflightGrant(await preflight(pathname, method))
  expectActualGrant(await actual(pathname, method))
  expectNoGrant(await actual(pathname, method, "https://evil.invalid"))
})

test.each([
  ["POST", "/dashboard"],
  ["GET", "/dashboard/api/overview"],
  ["POST", "/api/token"],
  ["POST", "/oauth/token"],
  ["POST", "/v1/oauth/token"],
  ["POST", "/v1/code/sessions/private"],
  ["POST", "/v1/environments/private"],
  ["POST", "/v1/sessions/private"],
  ["POST", "/sessions/private"],
  ["GET", "/remote/private"],
  ["GET", "/code/private"],
  ["POST", "/transcribe"],
  ["POST", "/wham/private"],
  ["POST", "/backend-api/private"],
  ["POST", "/models/model.with-dashes/policy"],
  ["POST", "/unknown"],
  ["GET", "/v1/responses"],
  ["GET", "/v1/messages"],
  ["GET", "/v1/models/model.with-dashes:generateContent"],
  ["GET", "/auto"],
  ["POST", "/v1/models"],
  ["POST", "/models/model.with-dashes"],
  ["GET", "/models/session"],
  ["GET", "/models/session/"],
  ["GET", "/models/session/intent"],
  ["POST", "/proxy/v1/messages"],
] as const)("does not grant %s CORS on %s", async (method, pathname) => {
  const response = await preflight(pathname, method)
  expect(response.status).toBe(404)
  expectNoGrant(response)
})

test.each([undefined, "", "OPTIONS", "PATCH", "not-a-method"])(
  "rejects malformed preflight requested method %s",
  async (method) => {
    const response = await preflight("/v1/responses", method)
    expect(response.status).toBe(404)
    expectNoGrant(response)
  },
)

test("uses exact origin membership and never a wildcard", async () => {
  process.env.COPILOT_INFERENCE_CORS_ORIGINS =
    "https://first.example, https://client.example"
  expectPreflightGrant(await preflight("/v1/models", "GET"))
  expectNoGrant(
    await preflight("/v1/models", "GET", "https://client.example.evil"),
  )
})
