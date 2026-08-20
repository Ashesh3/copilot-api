import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  getModelEndpointSupport,
  selectCopilotEndpoint,
} from "~/lib/endpoint-routing"
import { copilotControlPlaneRoutes } from "~/routes/copilot-control-plane/route"
import { server } from "~/server"
import { COPILOT_API_VERSION } from "~/services/copilot/copilot-contract"

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

const routeMatrix = [
  { method: "GET", canonical: "/v1/models", alias: "/models" },
  {
    method: "GET",
    canonical: "/v1/models/:model",
    alias: "/models/:model",
  },
  {
    method: "POST",
    canonical: "/v1/models/:model/policy",
    alias: "/models/:model/policy",
  },
  {
    method: "POST",
    canonical: "/v1/chat/completions",
    alias: "/chat/completions",
  },
  { method: "POST", canonical: "/v1/responses", alias: "/responses" },
  {
    method: "POST",
    canonical: "/v1/responses/compact",
    alias: "/responses/compact",
  },
  { method: "POST", canonical: "/v1/messages" },
  { method: "POST", canonical: "/v1/messages/count_tokens" },
  { method: "POST", canonical: "/v1/embeddings", alias: "/embeddings" },
  {
    method: "POST",
    canonical: "/v1/alpha/search",
    alias: "/alpha/search",
  },
] as const

const googleRouteMatrix = [
  "/v1beta/models/:model:generateContent",
  "/v1/models/:model:generateContent",
  "/models/:model:generateContent",
  "/v1beta/models/:model:streamGenerateContent",
  "/v1/models/:model:streamGenerateContent",
  "/models/:model:streamGenerateContent",
  "/v1beta/models/:model:countTokens",
  "/v1/models/:model:countTokens",
  "/models/:model:countTokens",
] as const

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/g, " ").trim()

function registeredRoutes(): Set<string> {
  return new Set(server.routes.map((route) => `${route.method} ${route.path}`))
}

test("documents the registered route matrix and reviewed endpoint authority", async () => {
  const text = await readFile(documentPath, "utf8")
  const normalizedText = normalizeWhitespace(text)
  const routes = registeredRoutes()

  for (const heading of requiredHeadings) expect(text).toContain(heading)
  expect(text).toContain(`\`${COPILOT_API_VERSION}\``)

  for (const route of routeMatrix) {
    expect(routes).toContain(`${route.method} ${route.canonical}`)
    expect(text).toContain(`\`${route.method} ${route.canonical}\``)
    if ("alias" in route) {
      expect(routes).toContain(`${route.method} ${route.alias}`)
      expect(text).toContain(`\`${route.method} ${route.alias}\``)
    }
  }

  for (const route of copilotControlPlaneRoutes.routes) {
    expect(routes).toContain(`${route.method} ${route.path}`)
    expect(text).toContain(`\`${route.method} ${route.path}\``)
  }

  for (const route of googleRouteMatrix) {
    expect(text).toContain(`\`POST ${route}\``)
  }

  const legacySupport = getModelEndpointSupport({})
  expect(legacySupport).toMatchObject({
    chat: true,
    messages: false,
    responses: false,
  })
  expect(normalizedText).toContain(
    "Live `supported_endpoints` metadata is authoritative for inference routing.",
  )
  expect(normalizedText).toContain(
    "A model record that omits `supported_endpoints` receives the legacy `/chat/completions` assumption only.",
  )

  const nativeDecision = selectCopilotEndpoint({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/chat/completions", "/responses"],
    }),
    candidates: [
      {
        endpoint: "/responses",
        reason: "endpoint_unavailable",
        check: { blockers: [], supported: true },
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        check: { blockers: [], supported: true },
      },
    ],
  })
  expect(nativeDecision).toMatchObject({
    reason: "native",
    target: "/responses",
    translated: false,
  })
  expect(text).toContain(
    "prefer the caller's native dialect when the selected model advertises it",
  )
  expect(text).toContain("endpoint_translation_unsupported")
})

test("documents precise field, error, streaming, and session-token boundaries", async () => {
  const text = normalizeWhitespace(await readFile(documentPath, "utf8"))

  for (const required of [
    "Unknown top-level fields are omitted at the final upstream boundary; nested data inside accepted fields is preserved unless a documented normalization applies.",
    "The native body uses a clone-and-denylist boundary",
    "An explicit modern `tool_choice` takes precedence over deprecated `function_call`.",
    "Chat streams end with `[DONE]`.",
    "Responses streams do not add `[DONE]`.",
    "Messages streams remove the trailing bare `[DONE]`",
    "Messages streams emit a safe Anthropic `error` event for handled failures after headers are committed.",
    "The synthetic Responses-from-Messages stream emits a protocol-native failed event for handled post-commit failures.",
    "Native Chat and native Responses stream paths may instead record the failure and close after headers are committed without synthesizing an in-band error event.",
    "Events written before a late stream failure remain visible to the client.",
    "Ordinary logs, telemetry, Sentry, and configuration exports never expose `Copilot-Session-Token`.",
    "Authorized administrator-only LLM Debug may contain the token when it captured a forwarded request.",
    "Last audited: 2026-08-17",
  ]) {
    expect(text).toContain(required)
  }

  for (const contradictory of [
    "After HTTP headers are committed, failures are emitted in-band using the source protocol's error event.",
    "It is never persisted or logged.",
    "Ordinary client errors, logs, telemetry, and Sentry events do not expose request bodies, prompts, credentials, session tokens",
  ]) {
    expect(text).not.toContain(contradictory)
  }
})

test("links the compatibility report from README", async () => {
  const text = await readFile(readmePath, "utf8")
  expect(text).toContain(
    "[detailed Copilot API compatibility contract](docs/copilot-api-compatibility.md)",
  )
})

test("contains no private paths, credentials, hosts, raw data, or static model IDs", async () => {
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
  expect(text).not.toMatch(
    /`?\b(?:gpt-(?:\d[\w.:-]*|o\d[\w.:-]*)|claude-(?:sonnet|opus|haiku)-[\w.:-]+|gemini-\d[\w.:-]*)`?/i,
  )
})
