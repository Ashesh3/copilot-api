import { expect, test } from "bun:test"

import { resolveApiKeyAuth } from "~/lib/api-key-auth-config"

test("leaves API key authentication disabled when the CLI flag is omitted", () => {
  expect(resolveApiKeyAuth(undefined, "environment-secret")).toBeUndefined()
})

test("prefers an explicit CLI secret over the environment", () => {
  expect(resolveApiKeyAuth("cli-secret", "environment-secret")).toBe(
    "cli-secret",
  )
})

test("uses the environment secret for valueless CLI flags", () => {
  expect(resolveApiKeyAuth("", "environment-secret")).toBe("environment-secret")
  expect(resolveApiKeyAuth("true", "environment-secret")).toBe(
    "environment-secret",
  )
})

test("rejects a valueless CLI flag when the environment secret is missing", () => {
  expect(() => resolveApiKeyAuth("", undefined)).toThrow(
    /^--api-key-auth requires a value or COPILOT_API_KEY_AUTH environment variable$/,
  )
  expect(() => resolveApiKeyAuth("true", undefined)).toThrow(
    /^--api-key-auth requires a value or COPILOT_API_KEY_AUTH environment variable$/,
  )
})
