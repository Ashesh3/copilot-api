import { expect, test } from "bun:test"

import {
  COPILOT_API_VERSION,
  DEFAULT_COPILOT_INTEGRATION_ID,
  resolveCopilotIntegrationId,
} from "~/services/copilot/copilot-contract"

test("pins the reviewed cumulative Copilot API contract", () => {
  expect(COPILOT_API_VERSION).toBe("2026-08-01")
})

test("keeps the compatibility integration default", () => {
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
