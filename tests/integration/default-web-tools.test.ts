import "./data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import { state } from "~/lib/state"

import { initializeTestState, postJSON, useIntegrationFixture } from "./setup"

const originalFetch = globalThis.fetch
const destinations: Array<{ host: string; path: string; status: number }> = []
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
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const response = await originalFetch(input, init)
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

test("live defaults search and fetch without client tools", async () => {
  const response = await postJSON("/v1/messages", {
    model,
    max_tokens: 2048,
    stream: false,
    messages: [
      {
        role: "user",
        content:
          "Use the provided web search tool to search for IANA example domains. Then separately use the provided web fetch tool to retrieve https://example.com/ directly. Report its page title and one sentence from the fetched page. Do not answer from memory; actually use both tools. Keep the answer under 80 words.",
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
      (item) => item.host === "example.com" && item.status === 200,
    ),
  ).toBe(true)
  expect(body).toContain("Example Domain")
  expect(body).not.toContain('"name":"_copilot_web_')
}, 180_000)

test("live native Responses fetch runs without client tools", async () => {
  const candidates =
    state.models?.data.filter(
      (entry) =>
        entry.supported_endpoints?.includes("/responses")
        && entry.capabilities.supports.tool_calls === true,
    ) ?? []
  const selected =
    candidates.find((entry) => entry.id === "gpt-5.5") ?? candidates.at(0)
  if (!selected)
    throw new Error(
      "Live default-web-tools verification requires a tool-capable Responses model",
    )
  const response = await postJSON("/v1/responses", {
    model: selected.id,
    input:
      "Use the provided web fetch function to retrieve https://example.com/ now. Report its page title and opening sentence based on the fetched content. Do not search or answer from memory. Keep your answer under 60 words.",
    max_output_tokens: 2048,
    stream: false,
  })
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(
    destinations.some(
      (item) => item.path === "/responses" && item.status === 200,
    ),
  ).toBe(true)
  expect(
    destinations.some(
      (item) => item.host === "example.com" && item.status === 200,
    ),
  ).toBe(true)
  expect(body).toContain("Example Domain")
  expect(body).not.toContain(
    '"type":"function_call","name":"_copilot_web_fetch"',
  )
}, 180_000)

test("live streaming fetch synthesizes an answer with one terminal", async () => {
  const response = await postJSON("/v1/messages", {
    model,
    max_tokens: 1536,
    stream: true,
    messages: [
      {
        role: "user",
        content:
          "Use the provided web fetch tool to retrieve https://example.com/ now. Report the page title and the opening sentence from the fetched content. Do not search or answer from memory.",
      },
    ],
  })
  const body = await response.text()
  expect(response.status).toBe(200)
  expect(
    destinations.some(
      (item) => item.host === "example.com" && item.status === 200,
    ),
  ).toBe(true)
  expect(body).toContain("Example Domain")
  expect(body.match(/event: message_stop/g)).toHaveLength(1)
  expect(body).not.toContain('"name":"_copilot_web_')
}, 180_000)
