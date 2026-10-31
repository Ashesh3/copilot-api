import { expect, test } from "bun:test"

import {
  sanitizeRequestDiagnosticReference,
  shouldOmitRequestBodyFromDiagnostics,
} from "~/lib/request-diagnostics"
import { sanitizeRequestBodyForLog } from "~/lib/request-logger"

test("credential-control request bodies are never read for diagnostics", () => {
  for (const route of [
    "/dashboard/api/credentials/gateway",
    "/dashboard/api/credentials/gateway/fixture/reveal",
    "/dashboard/api/custom-providers",
    "/dashboard/api/custom-providers/fixture/reveal",
    "/dashboard/auth/setup",
    "/dashboard/auth/login",
  ])
    expect(shouldOmitRequestBodyFromDiagnostics(route)).toBe(true)
  expect(shouldOmitRequestBodyFromDiagnostics("/v1/models")).toBe(false)
})

test("generic diagnostic scrubbing conceals custom keys and all submitted header values", () => {
  const sanitized = sanitizeRequestBodyForLog({
    label: "Fixture",
    credential: "fixture-raw-gateway",
    gatewayKey: "fixture-login-gateway",
    apiKey: "fixture-provider-key",
    headers: { "X-Anything": "fixture-header-value" },
  })
  expect(sanitized.label).toBe("Fixture")
  for (const raw of [
    "fixture-raw-gateway",
    "fixture-login-gateway",
    "fixture-provider-key",
    "fixture-header-value",
  ])
    expect(JSON.stringify(sanitized)).not.toContain(raw)
})

test("Desktop sign-in forms are excluded before debug logging reads their bodies", () => {
  for (const prefix of ["", "/v1"])
    for (const endpoint of ["device", "verify", "token", "revoke"])
      expect(
        shouldOmitRequestBodyFromDiagnostics(
          `${prefix}/gateway/oauth/${endpoint}`,
        ),
      ).toBe(true)
})

test("Desktop verification and device codes are redacted from diagnostic URLs", () => {
  for (const prefix of ["", "/v1"]) {
    const sanitized = sanitizeRequestDiagnosticReference(
      "GET",
      `https://gateway.test${prefix}/gateway/oauth/verify?user_code=ABCD-EFGH&device_code=private-device-code&visible=1`,
    )
    expect(sanitized).not.toContain("ABCD-EFGH")
    expect(sanitized).not.toContain("private-device-code")
    expect(sanitized).toContain("visible=1")
  }
})
