import "./data-dir"

import { afterEach, beforeEach, expect } from "bun:test"

import { state } from "~/lib/state"
import { executeWebSearch } from "~/services/copilot/mcp-web-search"

import { isGithubOrigin } from "../helpers/github-origin"
import { rejectsModelAsUnsupported, test } from "./live-models"
import { rankToolCapableResponsesModels } from "./model-candidates"
import { initializeTestState, postJSON, useIntegrationFixture } from "./setup"

// Tried before the rest of the catalog. Copilot can list a model it then
// refuses, so a refused model gives way to the next candidate.
const PREFERRED_RESPONSES_MODELS = ["gpt-5.3-codex"]
const RESPONSES_MODEL_ATTEMPTS = 3

/** The text a Messages SSE stream delivered; a phrase can span deltas. */
function streamedText(body: string): string {
  let text = ""
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const event = JSON.parse(line.slice("data: ".length)) as {
        delta?: { type?: string; text?: string }
      }
      if (event.delta?.type === "text_delta") text += event.delta.text ?? ""
    } catch {
      // Not a JSON event.
    }
  }
  return text
}

const originalFetch = globalThis.fetch
const destinations: Array<{ host: string; path: string; status: number }> = []
const pageOriginAttempts: Array<string> = []
const openedUrls: Array<string> = []
/** How GitHub's hosted reader answered each page read in the running test. */
const hostedPageReads: Array<"ok" | "cache_miss" | "error"> = []
let model = ""

const HOSTED_READER_MARKER = "GitHub-hosted webpage reader"

function hostedPageReadResult(value: {
  output?: Array<{ type?: string; content?: unknown }>
}): "ok" | "cache_miss" | "error" {
  const text = (value.output ?? [])
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content as Array<{ text?: unknown }>)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
  if (/"status"\s*:\s*"ok"/u.test(text)) return "ok"
  return /cache miss/iu.test(text) ? "cache_miss" : "error"
}

/**
 * GitHub's hosted reader is sometimes unable to open any page and answers
 * "Cache miss" for every URL, whatever the gateway sends. The gateway then
 * reports the failure, so the page-content check becomes a warning only when
 * every hosted page read in the test failed that way. All other checks run.
 */
function expectPageContent(label: string, text: string): void {
  const unavailable =
    hostedPageReads.length > 0
    && hostedPageReads.every((read) => read === "cache_miss")
  if (unavailable && !text.includes("Example Domain")) {
    const message = `Skipped the page-content check in live test "${label}": GitHub-hosted page reading answered "Cache miss" for every page it opened.`
    console.warn(message)
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(
        `::warning file=tests/integration/default-web-tools.test.ts,title=GitHub-hosted page reading unavailable::${message}\n`,
      )
    }
    return
  }
  expect(text).toContain("Example Domain")
}

beforeEach(async () => {
  await initializeTestState()
  const candidates =
    state.models?.data.filter(
      (entry) =>
        entry.supported_endpoints?.includes("/v1/messages")
        && entry.capabilities.supports.tool_calls !== false,
    ) ?? []
  model =
    (
      candidates.find((entry) => entry.id === "claude-sonnet-5.5")
      ?? candidates.at(0)
    )?.id ?? ""
  if (!model)
    throw new Error(
      "Live default-web-tools verification requires a tool-capable Messages model",
    )
  destinations.length = 0
  pageOriginAttempts.length = 0
  openedUrls.length = 0
  hostedPageReads.length = 0
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!isGithubOrigin(url, { allowGithubApi: true })) {
      pageOriginAttempts.push(url.hostname)
      throw new Error("Web tool attempted forbidden page-origin egress")
    }
    const response = await originalFetch(input, init)
    if (
      url.pathname === "/responses"
      && response.ok
      && response.headers.get("content-type")?.includes("application/json")
    ) {
      const value = (await response.clone().json()) as {
        output?: Array<{
          type?: string
          action?: { type?: string; url?: string }
          content?: unknown
        }>
      }
      for (const item of value.output ?? [])
        if (
          item.type === "web_search_call"
          && item.action?.type === "open_page"
          && item.action.url
        )
          openedUrls.push(item.action.url)
      if (
        typeof init?.body === "string"
        && init.body.includes(HOSTED_READER_MARKER)
      )
        hostedPageReads.push(hostedPageReadResult(value))
    }
    destinations.push({
      host: url.hostname,
      path: url.pathname,
      status: response.status,
    })
    return response
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})
useIntegrationFixture()

test("live default web search searches and opens pages entirely on GitHub", async () => {
  const response = await postJSON("/v1/messages", {
    model,
    max_tokens: 2048,
    stream: false,
    messages: [
      {
        role: "user",
        content:
          "Use the provided web search tool twice: first search for IANA example domains with a plain query without URLs. Then use the same web search tool to open https://example.com/ and read its page. Report the title and opening sentence from the opened page. Do not answer from memory. Keep the answer under 80 words.",
      },
    ],
  })
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(
    destinations.some(
      (item) => item.path === "/mcp/readonly" && item.status === 200,
    ),
  ).toBe(true)
  expect(
    destinations.some(
      (item) => item.path === "/responses" && item.status === 200,
    ),
  ).toBe(true)
  expect(openedUrls).toContain("https://example.com/")
  expect(pageOriginAttempts).toEqual([])
  expectPageContent("live default web search", body)
  expect(body).not.toContain('"name":"_copilot_web_')
}, 180_000)

test("live Responses clients open pages on GitHub without client configuration", async () => {
  const candidates = rankToolCapableResponsesModels(
    state.models?.data ?? [],
    PREFERRED_RESPONSES_MODELS,
  ).slice(0, RESPONSES_MODEL_ATTEMPTS)
  if (candidates.length === 0)
    throw new Error(
      "Live default-web-tools verification requires a tool-capable Responses model",
    )
  let status = 0
  let body = ""
  for (const candidate of candidates) {
    const response = await postJSON("/v1/responses", {
      model: candidate.id,
      input:
        "Use the provided web search function to open https://example.com/ now. Report its title and opening sentence based on the opened page. Do not answer from memory. Keep your answer under 60 words.",
      max_output_tokens: 2048,
      stream: false,
    })
    status = response.status
    body = await response.text()
    if (!rejectsModelAsUnsupported(status, body)) break
  }
  expect(status).toBe(200)
  expect(
    destinations.some(
      (item) => item.path === "/responses" && item.status === 200,
    ),
  ).toBe(true)
  expect(openedUrls).toContain("https://example.com/")
  expect(pageOriginAttempts).toEqual([])
  expectPageContent("live Responses clients", body)
  expect(body).not.toContain(
    '"type":"function_call","name":"_copilot_web_search"',
  )
}, 180_000)

test("live streaming page reading stays GitHub-only with one terminal", async () => {
  const response = await postJSON("/v1/messages", {
    model,
    max_tokens: 1536,
    stream: true,
    messages: [
      {
        role: "user",
        content:
          "Use the provided web search tool to open https://example.com/ now. Report the page title and opening sentence from that page. Do not answer from memory.",
      },
    ],
  })
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(openedUrls).toContain("https://example.com/")
  expect(pageOriginAttempts).toEqual([])
  expectPageContent("live streaming page reading", streamedText(body))
  expect(body.match(/event: message_stop/g)).toHaveLength(1)
  expect(body).not.toContain('"name":"_copilot_web_')
}, 180_000)

test("live page-reading failures have no local fallback or invented content", async () => {
  const result = await executeWebSearch(
    "Open https://copilot-fetch-probe-does-not-exist.invalid/page and report the retrieved page text.",
  )
  expect(result).toMatch(/^Web search (?:failed|error):/)
  expect(pageOriginAttempts).toEqual([])
  expect(destinations.some((item) => item.path === "/responses")).toBe(true)
}, 180_000)
