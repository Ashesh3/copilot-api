import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const documentPath = new URL(
  "../docs/copilot-api-compatibility.md",
  import.meta.url,
)
const readmePath = new URL("../README.md", import.meta.url)

const requiredHeadings = [
  "## Contract version and source precedence",
  "## Public route and alias table",
  "## Model discovery and endpoint routing",
  "## Responses accepted, normalized, rejected, and local fields",
  "## Messages body, header, and count-tokens behavior",
  "## Chat compatibility behavior",
  "## Streaming and WebSocket termination and continuation semantics",
  "## Multi-account and session-token constraints",
  "## Intentional gateway extensions",
  "## Error privacy and LLM Debug exception",
  "## Verification matrix and last-audited date",
  "## Residual feature-flag, account, and provider limitations",
] as const

const requiredRoutes = [
  "/models",
  "/v1/models",
  "/chat/completions",
  "/v1/chat/completions",
  "/responses",
  "/v1/responses",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/models/session",
  "/models/session/intent",
  "/auto",
] as const

test("documents the reviewed Copilot compatibility contract", async () => {
  const text = await readFile(documentPath, "utf8")

  for (const heading of requiredHeadings) expect(text).toContain(heading)
  for (const route of requiredRoutes) expect(text).toContain(route)

  for (const required of [
    "2026-08-01",
    "supported_endpoints",
    "endpoint_translation_unsupported",
    "previous_response_not_found",
    "Hash-only account affinity",
    "Copilot-Session-Token",
    "current WebSocket connection",
    "does not promise direct upstream WebSocket use",
    "Chat streams end with `[DONE]`",
    "Responses streams do not add `[DONE]`",
    "Messages streams remove the trailing bare `[DONE]`",
    "Last audited: 2026-08-17",
  ]) {
    expect(text).toContain(required)
  }
})

test("links the compatibility report from README", async () => {
  const text = await readFile(readmePath, "utf8")
  expect(text).toContain(
    "[detailed Copilot API compatibility contract](docs/copilot-api-compatibility.md)",
  )
})

test("contains no private paths, credentials, hosts, raw data, or static model list", async () => {
  const text = await readFile(documentPath, "utf8")

  for (const forbidden of [
    "github_pat_",
    "gho_",
    "ghp_",
    "sk-",
    "Bearer ",
    "10.0.0.",
    "internal-host.tld",
    "api.githubcopilot.com",
    "private-upstream-marker",
    "raw prompt",
    "raw user data",
  ]) {
    expect(text).not.toContain(forbidden)
  }

  expect(text).not.toMatch(/[A-Z]:\\(?:Projects|Users)\\/i)
  expect(text).not.toMatch(/\/(?:home|root|Users)\/[\w.-]+\//)
  expect(text).not.toMatch(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/,
  )
  expect(text).not.toMatch(/(?:^|\s)(?:gpt|claude|gemini)-[\w.:-]+/im)
})
