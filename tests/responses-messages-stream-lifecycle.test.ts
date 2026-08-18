import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
let upstreamAborted = false

const messagesOnlyModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "route-model",
      name: "Route Model",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 64_000 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const fetchMock = mock(
  (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const rejectAsAborted = (): void => {
        upstreamAborted = true
        reject(new DOMException("The request was aborted", "AbortError"))
      }
      if (init?.signal?.aborted) {
        rejectAsAborted()
        return
      }
      init?.signal?.addEventListener("abort", rejectAsAborted, { once: true })
    }),
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamAborted = false
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = messagesOnlyModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setSsePreflushDeadlineForTest(20)
})

afterEach(() => {
  setSsePreflushDeadlineForTest()
})

test("commits synthetic Responses SSE before buffered Messages headers", async () => {
  const responsePromise = Promise.resolve(
    server.request("/v1/responses", createRequest()),
  )
  const outcome = await Promise.race([
    responsePromise.then(() => "response" as const),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 250),
    ),
  ])

  expect(outcome).toBe("response")
  const response = await responsePromise
  const reader = requireBody(response).getReader()
  const first = await reader.read()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
  await reader.cancel()
})

test("cancels buffered Messages and emits no Responses events after detach", async () => {
  const response = await server.request("/v1/responses", createRequest())
  const reader = requireBody(response).getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")

  await reader.cancel()

  expect(await waitForUpstreamAbort()).toBe(true)
})

function createRequest(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "route-model",
      input: "hello",
      stream: true,
    }),
  }
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

async function waitForUpstreamAbort(): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (upstreamAborted) return true
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return false
}
