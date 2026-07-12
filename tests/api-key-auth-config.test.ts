import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { resolveApiKeyAuth } from "~/lib/api-key-auth-config"

const repositoryRoot = path.join(import.meta.dir, "..")

async function readRepositoryFile(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")
}

test("repository configuration does not support a gateway key file", async () => {
  for (const relativePath of [
    "src/start.ts",
    "docker-compose.yml",
    ".env.schema",
    "README.md",
  ]) {
    expect(await readRepositoryFile(relativePath)).not.toContain(
      "COPILOT_API_KEY_AUTH_FILE",
    )
  }
})

test("Docker Compose preserves automatic secret-management integration", async () => {
  const compose = await readRepositoryFile("docker-compose.yml")

  expect(compose).toContain("OP_TOKEN")
  expect(compose).toContain("OP_ENV_ID")
  expect(compose).toContain("env_file")
  expect(compose).toContain("- .env")
})

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
