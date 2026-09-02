import { expect, test } from "bun:test"

import {
  collectSafeCopilotResponseHeaders,
  COPILOT_API_VERSION,
  DEFAULT_COPILOT_INTEGRATION_ID,
  resolveCopilotIntegrationId,
  sanitizeCopilotHeaderValue,
} from "~/services/copilot/copilot-contract"

test("pins the reviewed cumulative Copilot API contract", () => {
  expect(COPILOT_API_VERSION).toBe("2026-08-01")
})

test("uses the Copilot CLI integration default", () => {
  expect(DEFAULT_COPILOT_INTEGRATION_ID).toBe("copilot-developer-cli")
  expect(resolveCopilotIntegrationId(undefined)).toBe(
    DEFAULT_COPILOT_INTEGRATION_ID,
  )
  expect(resolveCopilotIntegrationId("   ")).toBe(
    DEFAULT_COPILOT_INTEGRATION_ID,
  )
})

test("accepts a configured integration identifier", () => {
  expect(resolveCopilotIntegrationId("  assigned-integration  ")).toBe(
    "assigned-integration",
  )
})

test("rejects integration identifiers that can inject a header", () => {
  expect(() => resolveCopilotIntegrationId("good\r\nX-Evil: 1")).toThrow(
    "COPILOT_INTEGRATION_ID",
  )
})

test("enforces request header limits in UTF-8 bytes", () => {
  const exactlyOneKiB = "é".repeat(512)
  const overOneKiB = `${exactlyOneKiB}a`

  expect(sanitizeCopilotHeaderValue(`  ${exactlyOneKiB}  `)).toBe(exactlyOneKiB)
  expect(sanitizeCopilotHeaderValue(overOneKiB)).toBeUndefined()
})

test("rejects every C0 and C1 control from Copilot header values", () => {
  const controlCodePoints = [
    ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  ]

  for (const codePoint of controlCodePoints) {
    const control = String.fromCodePoint(codePoint)
    expect(sanitizeCopilotHeaderValue(`safe${control}value`)).toBeUndefined()
    expect(sanitizeCopilotHeaderValue(`${control}safe`)).toBeUndefined()
    expect(sanitizeCopilotHeaderValue(`safe${control}`)).toBeUndefined()
  }
})

test("rejects edge controls before trimming integration identifiers", () => {
  expect(() => resolveCopilotIntegrationId("\tassigned-integration")).toThrow(
    "COPILOT_INTEGRATION_ID",
  )
  expect(() =>
    resolveCopilotIntegrationId("assigned-integration\u0085"),
  ).toThrow("COPILOT_INTEGRATION_ID")
})

test("accepts trimmed Unicode text without changing UTF-8 length semantics", () => {
  const ordinaryUnicode = "  café — 你好 🚀  "
  expect(sanitizeCopilotHeaderValue(ordinaryUnicode)).toBe("café — 你好 🚀")
  expect(sanitizeCopilotHeaderValue("  éé  ", 4)).toBe("éé")
  expect(sanitizeCopilotHeaderValue("  ééa  ", 4)).toBeUndefined()
})

test("collects only safe Copilot response metadata", () => {
  const headers = new Headers({
    "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
    "retry-after": "Sun, 17 Aug 2026 12:00:00 GMT",
    "x-copilot-api-exp-assignment-context": "capi_flight:1;",
    "x-copilot-service-request-id": "service-123",
    "x-github-request-id": "github-456",
    "x-github-copilot-request-te": "false",
    "x-usage-ratelimit-remaining": "42",
    "x-request-id": "upstream-owned",
    "set-cookie": "secret=1",
    authorization: "Bearer secret",
    "x-provider-deployment": "private-name",
  })

  expect(collectSafeCopilotResponseHeaders(headers)).toEqual({
    "retry-after": "Sun, 17 Aug 2026 12:00:00 GMT",
    "x-copilot-api-exp-assignment-context": "capi_flight:1;",
    "x-copilot-service-request-id": "service-123",
    "x-github-copilot-request-te": "false",
    "x-github-request-id": "github-456",
    "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
    "x-usage-ratelimit-remaining": "42",
  })
})

test("rejects unsafe Copilot response metadata values", () => {
  const headers = {
    *entries(): IterableIterator<[string, string]> {
      yield ["x-copilot-service-request-id", "service-123\0private"]
      yield ["x-github-request-id", "github-456\r\nprivate"]
      yield ["retry-after", "x".repeat(8 * 1024 + 1)]
      yield ["X-Usage-Ratelimit-Remaining", "42"]
    },
  } as unknown as Headers

  expect(collectSafeCopilotResponseHeaders(headers)).toEqual({
    "x-usage-ratelimit-remaining": "42",
  })
})

test("rejects every C0 and C1 control from safe response metadata", () => {
  const controlCodePoints = [
    ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  ]
  const headers = {
    *entries(): IterableIterator<[string, string]> {
      for (const codePoint of controlCodePoints) {
        yield [
          "x-copilot-service-request-id",
          `safe${String.fromCodePoint(codePoint)}value`,
        ]
      }
      yield ["x-github-request-id", "ordinary-你好"]
    },
  } as unknown as Headers

  expect(collectSafeCopilotResponseHeaders(headers)).toEqual({
    "x-github-request-id": "ordinary-你好",
  })
})

test("enforces the Copilot response metadata limit in UTF-8 bytes", () => {
  const exactlyEightKiB = "é".repeat(4 * 1024)
  const overEightKiB = `${exactlyEightKiB}a`
  const headers = {
    *entries(): IterableIterator<[string, string]> {
      yield ["x-github-request-id", exactlyEightKiB]
      yield ["x-copilot-service-request-id", overEightKiB]
    },
  } as unknown as Headers

  expect(collectSafeCopilotResponseHeaders(headers)).toEqual({
    "x-github-request-id": exactlyEightKiB,
  })
})
