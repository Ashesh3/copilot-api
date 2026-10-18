import { expect, test } from "bun:test"
import { Hono } from "hono"

import { LocalHTTPError } from "~/lib/error"
import { readResponsesRequestJson } from "~/routes/responses/request-json"
import { webToolsMiddleware } from "~/services/web/middleware"
import {
  prepareManagedWebTools,
  webToolsContext,
} from "~/services/web/tool-context"

function responsesApp() {
  const app = new Hono()
  app.use("*", webToolsMiddleware)
  app.post("*", async (c) => {
    const source = await readResponsesRequestJson<Record<string, unknown>>(
      c.req.raw,
    )
    const prepared = prepareManagedWebTools(source, "responses")
    return c.json({
      source,
      payload: prepared.payload,
      managed: [...prepared.managed.keys()],
      callerNames: [...(webToolsContext()?.callerNames ?? [])],
    })
  })
  app.onError((error) => {
    if (error instanceof LocalHTTPError) return error.response
    throw error
  })
  return app
}

test.each(["/responses", "/v1/responses", "/v1/responses/"])(
  "zstd %s establishes tool ownership without consuming the route body",
  async (path) => {
    const source = {
      model: "model",
      input: "Open https://example.com/ and read the title.",
      tools: [
        {
          type: "function",
          name: "_copilot_web_search",
          parameters: { type: "object" },
        },
      ],
    }
    const response = await responsesApp().request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: Bun.zstdCompressSync(Buffer.from(JSON.stringify(source))),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      source: Record<string, unknown>
      payload: { tools: Array<Record<string, unknown>> }
      managed: Array<string>
      callerNames: Array<string>
    }
    expect(body.source).toEqual(source)
    expect(body.managed).toEqual([])
    expect(body.callerNames).toEqual(["_copilot_web_search"])
    expect(body.payload.tools[0]).toEqual(source.tools[0])
    expect(webToolsContext()).toBeUndefined()
  },
)

test.each([
  { encoding: "zstd", status: 400, code: "invalid_json" },
  { encoding: "gzip", status: 415, code: "unsupported_value" },
])(
  "preserves the Responses error for a JSON body labeled $encoding",
  async ({ encoding, status, code }) => {
    const response = await responsesApp().request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": encoding,
      },
      body: JSON.stringify({
        model: "model",
        input: "hello",
        tools: [{ type: "web_search", max_uses: 0 }],
      }),
    })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({
      error: { code, type: "invalid_request_error" },
    })
    expect(webToolsContext()).toBeUndefined()
  },
)

test("preserves stream aborts through Responses middleware parsing", async () => {
  const abortError = new DOMException("client disconnected", "AbortError")
  const app = responsesApp()
  let caught: unknown
  app.onError((error) => {
    caught = error
    return new Response(null, { status: 499 })
  })
  const response = await app.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(abortError)
      },
    }),
  })

  expect(response.status).toBe(499)
  expect(caught).toBe(abortError)
  expect(webToolsContext()).toBeUndefined()
})

test(
  "preserves the decompressed Responses size limit before establishing tool context",
  async () => {
    const response = await responsesApp().request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: Bun.zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1, 0x20)),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: "request_too_large", type: "invalid_request_error" },
    })
    expect(webToolsContext()).toBeUndefined()
  },
  { timeout: 15_000 },
)
