import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { server } from "~/server"
import { createEmbeddings } from "~/services/copilot/create-embeddings"

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const originalIsMultiToken = state.isMultiToken
const originalModels = state.models
let queuedResponse: Response

const fetchMock = mock(() => queuedResponse)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  state.isMultiToken = originalIsMultiToken
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  queuedResponse = Response.json({ object: "list", data: [] })
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [
      {
        id: "text-embedding-3-small",
        name: "Text Embedding 3 Small",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "embedding",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "embedding",
        },
      },
    ],
  }
})

test("preserves native embedding failure identity and exact route bytes", async () => {
  const body = Uint8Array.from([123, 10, 0, 255, 125])
  const createUpstream = () =>
    new Response(body.slice(), {
      status: 422,
      headers: { "content-type": "application/octet-stream" },
    })
  const upstream = createUpstream()
  queuedResponse = upstream
  const payload = { model: "text-embedding-3-small", input: "hello" }

  const error = await createEmbeddings(payload).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response).toBe(upstream)
  expect(upstream.bodyUsed).toBe(false)

  queuedResponse = createUpstream()
  const response = await server.request("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(response.status).toBe(422)
  expect(response.headers.get("content-type")).toBe("application/octet-stream")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
})

test("returns a fixed invalid JSON error without dispatching embeddings", async () => {
  for (const request of [
    {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    {
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  ]) {
    fetchMock.mockClear()
    const response = await server.request("/v1/embeddings", request)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(text).toBe(
      '{"error":{"code":"invalid_json","message":"The request body must contain valid JSON.","param":"body","type":"invalid_request_error"}}',
    )
    expect(text).not.toMatch(/SyntaxError|Unexpected|JSON Parse|Bun|Hono/)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  }
})
