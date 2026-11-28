import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { interceptEngine } from "~/lib/intercept/engine"
import { respondWithInterceptKeepalive } from "~/lib/intercept/keepalive-response"
import {
  markStreamingClient,
  signalInterceptWait,
} from "~/lib/intercept/wait-signal"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { SSE_HEARTBEAT_COMMENT } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { fetchServer } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const chatModel = "gpt-chat-keepalive"
const originalFetch = globalThis.fetch
const originalState = { ...state }
const upstreamPaths: Array<string> = []

beforeEach(() => {
  upstreamPaths.length = 0
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  Object.assign(state, {
    accountType: "individual",
    apiKeyAuth: PROTOCOL_GATEWAY_KEY,
    copilotToken: "keepalive-copilot-token",
    githubToken: "keepalive-github-token",
    isMultiToken: false,
    manualApprove: false,
    models: { object: "list", data: [model(chatModel)] },
  })
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    upstreamPaths.push(url.pathname)
    if (url.pathname === "/chat/completions") return Promise.resolve(chatSse())
    throw new Error(`Unexpected upstream request ${url.pathname}`)
  }) as typeof fetch
})

afterEach(() => {
  interceptEngine.resetForTest()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
})

function sendChat(): Promise<Response> {
  return fetchServer(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: chatModel,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
}

async function openHeldChat() {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  await seedProtocolDatabase()
  const response = await sendChat()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain(SSE_HEARTBEAT_COMMENT)
  // The request is still held: nothing reached the upstream yet.
  expect(upstreamPaths).toEqual([])
  expect(interceptEngine.getSnapshot().pending).toHaveLength(1)
  return reader
}

async function readRest(
  reader: Awaited<ReturnType<typeof openHeldChat>>,
): Promise<string> {
  const decoder = new TextDecoder()
  let body = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return body
    body += decoder.decode(chunk.value, { stream: true })
  }
}

test("a held Copilot Chat Completions stream gets a keepalive before forward", async () => {
  const reader = await openHeldChat()
  expect(interceptEngine.forwardAllPending()).toBe(1)

  const body = await readRest(reader)
  expect(upstreamPaths).toEqual(["/chat/completions"])
  expect(body).toContain("keepalive answer")
  expect(body).toContain("[DONE]")
})

test("a complete reply to a held stream still arrives as chunks", async () => {
  // An app reply that ignored `stream: true`, arriving after the hold began.
  const response = await respondWithInterceptKeepalive({
    respond: async () => {
      markStreamingClient("chat")
      signalInterceptWait()
      await Bun.sleep(5)
      return Response.json({
        id: "chatcmpl-complete",
        object: "chat.completion",
        created: 1,
        model: chatModel,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "complete answer" },
          },
        ],
      })
    },
    decorate: () => undefined,
  })

  expect(response.headers.get("content-type")).toBe("text/event-stream")
  const body = await response.text()
  expect(body.startsWith(SSE_HEARTBEAT_COMMENT)).toBe(true)
  expect(body).toContain('"content":"complete answer"')
  expect(body).toContain("data: [DONE]")
})

test("cancelling a held stream drops the held request", async () => {
  const reader = await openHeldChat()
  await reader.cancel()

  for (let tries = 0; tries < 50; tries += 1) {
    if (interceptEngine.getSnapshot().pending.length === 0) break
    await Bun.sleep(10)
  }
  expect(interceptEngine.getSnapshot().pending).toHaveLength(0)
  expect(upstreamPaths).toEqual([])
})

test("the heartbeat kill switch keeps a held stream unopened", async () => {
  process.env.COPILOT_API_DISABLE_SSE_HEARTBEAT = "1"
  try {
    interceptEngine.updateConfig({ enabled: true, direction: "request" })
    await seedProtocolDatabase()
    const pending = sendChat()
    for (let tries = 0; tries < 50; tries += 1) {
      if (interceptEngine.getSnapshot().pending.length > 0) break
      await Bun.sleep(10)
    }
    const early = await Promise.race([pending, Bun.sleep(50).then(() => null)])
    expect(early).toBeNull()

    expect(interceptEngine.forwardAllPending()).toBe(1)
    const body = await (await pending).text()
    expect(body).not.toContain(SSE_HEARTBEAT_COMMENT)
    expect(body).toContain("keepalive answer")
  } finally {
    delete process.env.COPILOT_API_DISABLE_SSE_HEARTBEAT
  }
})

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: { streaming: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function chatSse(): Response {
  const base = {
    id: "chatcmpl-keepalive",
    object: "chat.completion.chunk",
    created: 1,
    model: chatModel,
  }
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "keepalive answer" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  ]
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
    + "data: [DONE]\n\n"
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}
