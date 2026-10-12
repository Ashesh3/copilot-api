import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { SSEStreamingApi } from "hono/streaming"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
} from "~/lib/usage-tracker"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  manualApprove: state.manualApprove,
  models: state.models,
}
let upstream: Response | undefined
let logs: ReturnType<typeof spyOn<typeof console, "log">>

beforeEach(() => {
  enableDatabaseUsageForTest()
  logs = spyOn(console, "log").mockImplementation(() => {})
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest({
    enabled: false,
    notifyClient: false,
    nativeClientNotice: false,
    rules: [],
  })
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "responses-cancellation",
        name: "Responses Cancellation",
        object: "model",
        vendor: "openai",
        version: "test",
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
  globalThis.fetch = ((url: string | URL | Request) => {
    const requestUrl =
      typeof url === "string" || url instanceof URL ? url : url.url
    expect(new URL(requestUrl).pathname).toBe("/responses")
    const response = upstream
    upstream = undefined
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  logs.mockRestore()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function terminalFrame(status: "completed" | "incomplete"): string {
  const type = `response.${status}`
  return `event: ${type}\ndata: ${JSON.stringify({
    type,
    response: {
      id: "resp_cancelled",
      object: "response",
      created_at: 1,
      model: "responses-cancellation",
      status,
      output: [],
      output_text: "Completed upstream text",
      usage: { input_tokens: 17, output_tokens: 4, total_tokens: 21 },
      error: null,
      incomplete_details:
        status === "incomplete" ? { reason: "max_output_tokens" } : null,
    },
  })}\n\n`
}

for (const path of ["/v1/chat/completions", "/v1/messages"]) {
  test.each(["completed", "incomplete"] as const)(
    `${path} cancellation keeps received %s usage before translated terminal writes finish`,
    async (status) => {
      const blocked = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const writingFinished = Promise.withResolvers<undefined>()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoke the original with the real Hono stream as this.
      const writeSse = SSEStreamingApi.prototype.writeSSE
      let writes = 0
      const writer = spyOn(
        SSEStreamingApi.prototype,
        "writeSSE",
      ).mockImplementation(async function (this: SSEStreamingApi, message) {
        if (++writes === 2) {
          blocked.resolve(undefined)
          await release.promise
          try {
            await writeSse.call(this, message)
          } finally {
            writingFinished.resolve(undefined)
          }
          return
        }
        await writeSse.call(this, message)
      })
      try {
        upstream = new Response(terminalFrame(status), {
          headers: { "content-type": "text/event-stream" },
        })
        await seedProtocolDatabase()
        const response = await server.request(path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "responses-cancellation",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 16,
            stream: true,
          }),
        })
        expect(response.status).toBe(200)
        if (!response.body) throw new Error("Missing downstream stream")
        const reader =
          response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        const first = await reader.read()
        expect(first.done).toBe(false)
        const text = new TextDecoder().decode(first.value)
        expect(text).toContain(
          path === "/v1/messages" ? "message_start" : '"role":"assistant"',
        )
        expect(text).not.toContain(
          path === "/v1/messages" ? "message_stop" : '"finish_reason":"stop"',
        )
        await blocked.promise
        expect((await getUsageResponse()).lifetime).toMatchObject({
          total_requests: 0,
        })
        await reader.cancel(
          "client disconnected while translated writes remain",
        )
        expect((await getUsageResponse()).lifetime).toMatchObject({
          total_input_tokens: 17,
          total_output_tokens: 4,
          total_requests: 1,
        })
        await reader.cancel()
        expect((await getUsageResponse()).lifetime).toMatchObject({
          total_input_tokens: 17,
          total_output_tokens: 4,
          total_requests: 1,
        })
      } finally {
        release.resolve(undefined)
        await writingFinished.promise
        writer.mockRestore()
      }
    },
  )
}
