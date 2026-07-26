import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "../src/lib/sse-lifecycle"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let delayedStreamController:
  | ReadableStreamDefaultController<Uint8Array>
  | undefined
let delayedUpstreamAborted = false
let lastUpstreamPath: string | undefined
let streamMode: "immediate" | "stall-body" | "stall-fetch" = "stall-body"

const nativeMessagesModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages", "/chat/completions"],
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

function parseRequestBody(init?: RequestInit): ChatCompletionsPayload {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON request body")
  }
  return JSON.parse(init.body) as ChatCompletionsPayload
}

function createImmediateStream(): Response {
  const contentChunk = {
    id: "chatcmpl-stream-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "hello" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const stopChunk = {
    ...contentChunk,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
  return new Response(
    `data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify(stopChunk)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createStalledStream(signal?: AbortSignal | null): Response {
  signal?.addEventListener(
    "abort",
    () => {
      delayedUpstreamAborted = true
    },
    { once: true },
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        delayedStreamController = controller
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const payload = parseRequestBody(init)
  if (!payload.stream) throw new Error("Expected a streaming upstream request")
  let url: string
  if (typeof _url === "string") url = _url
  else if (_url instanceof URL) url = _url.href
  else url = _url.url
  lastUpstreamPath = new URL(url).pathname
  if (streamMode === "stall-fetch") {
    return new Promise<Response>((_resolve, reject) => {
      const rejectAsAborted = (): void => {
        delayedUpstreamAborted = true
        reject(new DOMException("The request was aborted", "AbortError"))
      }
      if (init?.signal?.aborted) {
        rejectAsAborted()
        return
      }
      init?.signal?.addEventListener("abort", rejectAsAborted, { once: true })
    })
  }
  return streamMode === "immediate" ?
      createImmediateStream()
    : createStalledStream(init?.signal)
})

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

function closeDelayedStream(): void {
  try {
    delayedStreamController?.close()
  } catch {
    // The stream may already have been cancelled by the route under test.
  }
  delayedStreamController = undefined
}

async function waitForUpstreamAbort(): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (delayedUpstreamAborted) return true
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return false
}

function createMessagesRequest(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Write a very long plan." }],
      max_tokens: 32000,
      stream: true,
    }),
  }
}

function createNativeMessagesRequest(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4.8",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from("%PDF-1.4 lifecycle test").toString("base64"),
              },
            },
          ],
        },
      ],
      max_tokens: 32_000,
      stream: true,
    }),
  }
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  closeDelayedStream()
  delayedUpstreamAborted = false
  lastUpstreamPath = undefined
  streamMode = "stall-body"
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  closeDelayedStream()
  setSsePreflushDeadlineForTest()
})

test("commits a keepalive before the upstream first SSE event", async () => {
  setSsePreflushDeadlineForTest(20)
  const responsePromise = Promise.resolve(
    server.request("/v1/messages", createMessagesRequest()),
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
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
  await reader.cancel()
})

test("aborts the pending upstream request when the downstream stream is cancelled", async () => {
  setSsePreflushDeadlineForTest(20)
  const response = await server.request("/v1/messages", createMessagesRequest())
  const reader = requireBody(response).getReader()

  await reader.read()
  await reader.cancel()

  expect(await waitForUpstreamAbort()).toBe(true)
})

test("keeps the Anthropic event order unchanged when the first event is immediate", async () => {
  streamMode = "immediate"
  const response = await server.request("/v1/messages", createMessagesRequest())
  const body = await response.text()

  expect(body).not.toContain(": keepalive")
  expect(
    Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1]),
  ).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ])
})

test("commits a keepalive while native Anthropic waits for upstream headers", async () => {
  setSsePreflushDeadlineForTest(20)
  streamMode = "stall-fetch"
  state.models = nativeMessagesModels
  const response = await server.request(
    "/v1/messages",
    createNativeMessagesRequest(),
  )
  const reader = requireBody(response).getReader()
  const first = await reader.read()

  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
  await reader.cancel()
  expect(await waitForUpstreamAbort()).toBe(true)
})
