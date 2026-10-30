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
let model = ""

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
        }>
      }
      for (const item of value.output ?? [])
        if (
          item.type === "web_search_call"
          && item.action?.type === "open_page"
          && item.action.url
        )
          openedUrls.push(item.action.url)
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
  expect(body).toContain("Example Domain")
  expect(openedUrls).toContain("https://example.com/")
  expect(pageOriginAttempts).toEqual([])
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
  expect(body).toContain("Example Domain")
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
  expect(streamedText(body)).toContain("Example Domain")
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
