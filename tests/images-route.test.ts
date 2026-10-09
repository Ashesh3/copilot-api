import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { setImageRoutingModel } from "~/lib/config"
import { getLlmDebugLog, listLlmDebugLogs } from "~/lib/llm-debug-log"
import { state } from "~/lib/state"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
  resetUsageForTest,
} from "~/lib/usage-tracker"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

// Live catalog row observed on 2026-10-08, minus client billing notices.
const IMAGE_MODEL = {
  billing: {
    restricted_to: [
      "pro",
      "pro_plus",
      "individual_trial",
      "edu",
      "business",
      "enterprise",
      "max",
    ],
    token_prices: {
      batch_size: 1_000_000,
      default: {
        cache_read_price: 0,
        cache_write_price: 0,
        input_price: 500,
        max_prompt_tokens: 32_000,
        output_price: 0,
      },
    },
  },
  capabilities: {
    family: "gpt-image-2.5-sunburst",
    limits: { max_prompt_tokens: 32_000 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "image",
  },
  id: "gpt-image-2.5-sunburst",
  is_chat_default: false,
  is_chat_fallback: false,
  model_picker_enabled: false,
  model_picker_price_category: "high",
  name: "GPT Image 2.5 Sunburst",
  object: "model",
  preview: true,
  supported_endpoints: ["/v1/images/generations", "/v1/images/edits"],
  vendor: "Experimental",
  version: "gpt-image-2.5-sunburst",
} satisfies Model

const GENERATION_ONLY_MODEL = {
  ...IMAGE_MODEL,
  id: "generation-only-image",
  name: "Generation Only Image",
  supported_endpoints: ["/v1/images/generations"],
  version: "generation-only-image",
} satisfies Model

// A future catalog row for the OpenAI name that Codex hard-codes.
const LISTED_CODEX_IMAGE_MODEL = {
  ...IMAGE_MODEL,
  id: "gpt-image-2",
  name: "GPT Image 2",
  version: "gpt-image-2",
} satisfies Model

// A second live image model, listed ahead of the default fixture model.
const FLARE_MODEL = {
  ...IMAGE_MODEL,
  capabilities: { ...IMAGE_MODEL.capabilities, family: "gpt-image-2.5-flare" },
  id: "gpt-image-2.5-flare",
  name: "GPT Image 2.5 Flare",
  version: "gpt-image-2.5-flare",
} satisfies Model

const CHAT_MODEL = {
  capabilities: {
    family: "gpt-6-luna",
    limits: { max_output_tokens: 128_000, max_prompt_tokens: 872_000 },
    object: "model_capabilities",
    supports: { streaming: true, tool_calls: true, vision: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-6-luna",
  model_picker_enabled: true,
  name: "GPT-6 Luna",
  object: "model",
  policy: { state: "enabled", terms: "Enable access to GPT-6 Luna." },
  preview: false,
  supported_endpoints: ["/responses", "ws:/responses"],
  vendor: "OpenAI",
  version: "gpt-6-luna",
} satisfies Model

// A 1x1 PNG keeps the fixture small; the envelope matches the live response.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"))
const BOUNDARY = "copilot-api-images-boundary"
const UPSTREAM_IMAGE_BODY = `{"created":1791443261,"background":"opaque","data":[{"b64_json":"${PNG_BASE64}"}],"output_format":"png","quality":"low","size":"1024x1024","usage":{"input_tokens":21,"input_tokens_details":{"image_tokens":0,"text_tokens":21},"output_tokens":196,"output_tokens_details":{"image_tokens":196,"text_tokens":0},"total_tokens":217},"copilot_usage":{"token_details":[{"batch_size":1000000,"cost_per_batch":500000000000,"model":"gpt-image-2.5-sunburst","token_count":21,"token_type":"input"},{"batch_size":1000000,"cost_per_batch":3000000000000,"model":"gpt-image-2.5-sunburst","token_count":196,"token_type":"image_output"}],"total_nano_aiu":598500000}}\n`

const GENERATION_REQUEST = {
  model: "gpt-image-2.5-sunburst",
  prompt: "A flat red circle centered on a plain white background.",
  n: 1,
  size: "1024x1024",
  quality: "low",
  output_format: "png",
}

// Codex 0.160.0's built-in image tool sends these bodies, field for field.
const CODEX_GENERATION_REQUEST = {
  prompt: "A dog and a cat sitting in a wicker basket.",
  background: "opaque",
  model: "gpt-image-2",
  quality: "auto",
  size: "auto",
}

const CODEX_EDIT_REQUEST = {
  images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
  prompt: "Give the cat a red bow.",
  background: "opaque",
  model: "gpt-image-2",
  quality: "auto",
  size: "auto",
}

interface UpstreamRequest {
  authorization: string | null
  body: Uint8Array
  contentType: string | null
  path: string
}

const upstreamRequests: Array<UpstreamRequest> = []
let upstreamResponse: () => Response = () => new Response(null)

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotApiBaseUrl: state.copilotApiBaseUrl,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  models: state.models,
}

beforeAll(() => {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ?
        new Request(input, init)
      : new Request(input.toString(), init)
    upstreamRequests.push({
      authorization: request.headers.get("authorization"),
      body: new Uint8Array(await request.arrayBuffer()),
      contentType: request.headers.get("content-type"),
      path: new URL(request.url).pathname,
    })
    return upstreamResponse()
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  enableDatabaseUsageForTest()
})

beforeEach(async () => {
  upstreamRequests.length = 0
  upstreamResponse = () =>
    new Response(UPSTREAM_IMAGE_BODY, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  state.accountType = "individual"
  state.copilotApiBaseUrl = undefined
  state.copilotToken = "images-copilot-token"
  state.githubToken = "images-github-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [IMAGE_MODEL, GENERATION_ONLY_MODEL, CHAT_MODEL],
  }
  resetUsageForTest()
  await seedProtocolDatabase()
})

async function postImages(
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> {
  await seedProtocolDatabase()
  return await server.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`, ...headers },
    body,
  })
}

function decode(bytes: Uint8Array | undefined): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
}

function multipartEdit(fields: Record<string, string>): {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
} {
  // Hand-built so the exact forwarded bytes and boundary are known.
  const encoder = new TextEncoder()
  const text = Object.entries(fields).map(
    ([name, value]) =>
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  )
  return {
    bytes: new Uint8Array(
      Buffer.concat([
        encoder.encode(text.join("")),
        encoder.encode(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="image[]"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        PNG_BYTES,
        encoder.encode(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    ),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  }
}

test.each(["/v1/images/generations", "/images/generations"])(
  "%s forwards the native generation request and returns Copilot's exact bytes",
  async (path) => {
    const response = await postImages(path, JSON.stringify(GENERATION_REQUEST))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe(UPSTREAM_IMAGE_BODY)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]).toMatchObject({
      authorization: "Bearer images-copilot-token",
      contentType: "application/json",
      path: "/v1/images/generations",
    })
    expect(decode(upstreamRequests[0]?.body)).toEqual(GENERATION_REQUEST)
  },
)

test("records the token usage that Copilot reports for an image", async () => {
  const response = await postImages(
    "/v1/images/generations",
    JSON.stringify(GENERATION_REQUEST),
  )
  await response.text()

  expect((await getUsageResponse()).lifetime).toMatchObject({
    total_input_tokens: 21,
    total_output_tokens: 196,
    total_requests: 1,
  })
})

test("captures the upstream image generation attempt in LLM Debug", async () => {
  const response = await postImages(
    "/v1/images/generations",
    JSON.stringify(GENERATION_REQUEST),
  )
  await response.text()

  const details = await Promise.all(
    (await listLlmDebugLogs()).entries.map((entry) => getLlmDebugLog(entry.id)),
  )
  expect(
    details.some(
      (entry) =>
        entry?.request.path === "/v1/images/generations"
        && entry.request.body?.includes("A flat red circle"),
    ),
  ).toBe(true)
})

test("forwards JSON image edits with their image references", async () => {
  const edit = {
    model: IMAGE_MODEL.id,
    prompt: "Change the circle color to blue.",
    images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
    input_fidelity: "high",
  }

  const response = await postImages("/v1/images/edits", JSON.stringify(edit))

  expect(response.status).toBe(200)
  expect(await response.text()).toBe(UPSTREAM_IMAGE_BODY)
  expect(upstreamRequests).toHaveLength(1)
  expect(upstreamRequests[0]?.path).toBe("/v1/images/edits")
  expect(upstreamRequests[0]?.contentType).toBe("application/json")
  expect(decode(upstreamRequests[0]?.body)).toEqual(edit)
})

test.each(["/v1/images/edits", "/images/edits"])(
  "%s forwards multipart uploads byte for byte with their boundary",
  async (path) => {
    const multipart = multipartEdit({
      model: IMAGE_MODEL.id,
      prompt: "Add a thin black outline around the circle.",
      quality: "low",
    })

    const response = await postImages(path, multipart.bytes, {
      "content-type": multipart.contentType,
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(UPSTREAM_IMAGE_BODY)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.path).toBe("/v1/images/edits")
    expect(upstreamRequests[0]?.contentType).toBe(multipart.contentType)
    expect(Array.from(upstreamRequests[0]?.body ?? [])).toEqual(
      Array.from(multipart.bytes),
    )
  },
)

test("rejects a multipart edit without a model locally", async () => {
  const multipart = multipartEdit({ prompt: "Outline the circle." })

  const response = await postImages("/v1/images/edits", multipart.bytes, {
    "content-type": multipart.contentType,
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "model", type: "invalid_request_error" },
  })
  expect(upstreamRequests).toHaveLength(0)
})

test("rejects image edits that are neither JSON nor multipart locally", async () => {
  const response = await postImages("/v1/images/edits", "model=x", {
    "content-type": "application/x-www-form-urlencoded",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "body", type: "invalid_request_error" },
  })
  expect(upstreamRequests).toHaveLength(0)
})

test.each([
  ["malformed JSON", "{", { code: "invalid_json", param: "body" }],
  [
    "a missing model",
    JSON.stringify({ prompt: "A red circle." }),
    { code: "invalid_request", param: "model" },
  ],
  [
    "a non-object body",
    JSON.stringify(["A red circle."]),
    { code: "invalid_request", param: "body" },
  ],
] as const)(
  "rejects a generation with %s locally",
  async (_case, body, error) => {
    const response = await postImages("/v1/images/generations", body)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { ...error, type: "invalid_request_error" },
    })
    expect(upstreamRequests).toHaveLength(0)
  },
)

test.each([
  ["/v1/images/generations", CHAT_MODEL.id],
  ["/v1/images/edits", GENERATION_ONLY_MODEL.id],
] as const)(
  "%s rejects a cataloged model that does not advertise it",
  async (path, model) => {
    const response = await postImages(
      path,
      JSON.stringify({
        model,
        prompt: "A red circle.",
        images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: "model_not_supported",
        param: "model",
        type: "invalid_request_error",
      },
    })
    expect(upstreamRequests).toHaveLength(0)
  },
)

test("requires an inference credential before image dispatch", async () => {
  await seedProtocolDatabase()
  const response = await server.request("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(GENERATION_REQUEST),
  })

  expect(response.status).toBe(401)
  expect(upstreamRequests).toHaveLength(0)
})

test.each([
  [
    "/v1/images/generations",
    CODEX_GENERATION_REQUEST,
    GENERATION_ONLY_MODEL.id,
  ],
  ["/v1/images/edits", CODEX_EDIT_REQUEST, IMAGE_MODEL.id],
] as const)(
  "%s routes Codex's gpt-image-2 to the first live model serving the route",
  async (path, request, model) => {
    state.models = {
      object: "list",
      data: [CHAT_MODEL, GENERATION_ONLY_MODEL, IMAGE_MODEL],
    }

    const response = await postImages(path, JSON.stringify(request))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(UPSTREAM_IMAGE_BODY)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.path).toBe(path)
    // Only the model value changes; every other field keeps its position.
    expect(new TextDecoder().decode(upstreamRequests[0]?.body)).toBe(
      JSON.stringify({ ...request, model }),
    )
  },
)

test("re-encodes a multipart gpt-image-2 edit with only its model replaced", async () => {
  const multipart = multipartEdit({
    model: "gpt-image-2",
    prompt: "Add a thin black outline around the circle.",
    quality: "low",
  })

  const response = await postImages("/v1/images/edits", multipart.bytes, {
    "content-type": multipart.contentType,
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toHaveLength(1)
  const forwarded = upstreamRequests.at(0)
  const contentType = forwarded?.contentType ?? ""
  const boundaryPrefix = "multipart/form-data; boundary="
  expect(contentType).toStartWith(boundaryPrefix)
  // The header must name the boundary that the re-encoded body uses.
  const form = await Bun.readableStreamToFormData(
    new Blob([new Uint8Array(forwarded?.body ?? [])]).stream(),
    contentType.slice(boundaryPrefix.length),
  )
  expect(Array.from(form.keys())).toEqual([
    "model",
    "prompt",
    "quality",
    "image[]",
  ])
  expect(form.get("model")).toBe(IMAGE_MODEL.id)
  expect(form.get("prompt")).toBe("Add a thin black outline around the circle.")
  expect(form.get("quality")).toBe("low")
  const image = form.get("image[]")
  if (!(image instanceof File)) throw new Error("image[] was not a file")
  expect(image.name).toBe("source.png")
  expect(image.type).toBe("image/png")
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG_BYTES)
})

test.each<[string, Array<Model>, string]>([
  [
    "a live catalog lists gpt-image-2",
    [IMAGE_MODEL, LISTED_CODEX_IMAGE_MODEL],
    "gpt-image-2",
  ],
  ["no live model serves the route", [CHAT_MODEL], "gpt-image-2"],
  [
    "it names another unlisted image model",
    [IMAGE_MODEL],
    "gpt-image-2.5-flare",
  ],
])(
  "forwards the requested model unchanged when %s",
  async (_case, data, model) => {
    state.models = { object: "list", data }
    const request = { ...CODEX_GENERATION_REQUEST, model }

    const response = await postImages(
      "/v1/images/generations",
      JSON.stringify(request),
    )

    expect(response.status).toBe(200)
    expect(upstreamRequests).toHaveLength(1)
    expect(decode(upstreamRequests[0]?.body)).toEqual(request)
  },
)

test.each([
  [
    "a generation naming another live model",
    "/v1/images/generations",
    { ...GENERATION_REQUEST, model: FLARE_MODEL.id },
  ],
  [
    "Codex's gpt-image-2 generation",
    "/v1/images/generations",
    CODEX_GENERATION_REQUEST,
  ],
  ["Codex's gpt-image-2 edit", "/v1/images/edits", CODEX_EDIT_REQUEST],
  [
    "an edit naming another live model",
    "/v1/images/edits",
    { ...CODEX_EDIT_REQUEST, model: FLARE_MODEL.id },
  ],
] as const)(
  "the dashboard's image model serves %s",
  async (_case, path, request) => {
    state.models = {
      object: "list",
      data: [FLARE_MODEL, IMAGE_MODEL, CHAT_MODEL],
    }
    await setImageRoutingModel(IMAGE_MODEL.id)

    const response = await postImages(path, JSON.stringify(request))

    expect(response.status).toBe(200)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.path).toBe(path)
    expect(new TextDecoder().decode(upstreamRequests[0]?.body)).toBe(
      JSON.stringify({ ...request, model: IMAGE_MODEL.id }),
    )
  },
)

test("re-encodes a multipart edit for the dashboard's image model", async () => {
  state.models = {
    object: "list",
    data: [FLARE_MODEL, IMAGE_MODEL, CHAT_MODEL],
  }
  await setImageRoutingModel(IMAGE_MODEL.id)
  const multipart = multipartEdit({
    model: FLARE_MODEL.id,
    prompt: "Outline the circle.",
  })

  const response = await postImages("/v1/images/edits", multipart.bytes, {
    "content-type": multipart.contentType,
  })

  expect(response.status).toBe(200)
  const forwarded = upstreamRequests.at(0)
  const contentType = forwarded?.contentType ?? ""
  const boundaryPrefix = "multipart/form-data; boundary="
  expect(contentType).toStartWith(boundaryPrefix)
  const form = await Bun.readableStreamToFormData(
    new Blob([new Uint8Array(forwarded?.body ?? [])]).stream(),
    contentType.slice(boundaryPrefix.length),
  )
  expect(form.get("model")).toBe(IMAGE_MODEL.id)
  expect(form.get("prompt")).toBe("Outline the circle.")
})

interface RoutingFallbackCase {
  /** Model saved in dashboard settings. */
  configured: string
  data: Array<Model>
  /** Model Copilot should receive. */
  model: string
  path: string
  request: Record<string, unknown>
}

test.each<[string, RoutingFallbackCase]>([
  [
    "a saved model missing from the catalog leaves a named model alone",
    {
      configured: FLARE_MODEL.id,
      data: [IMAGE_MODEL, CHAT_MODEL],
      model: IMAGE_MODEL.id,
      path: "/v1/images/generations",
      request: GENERATION_REQUEST,
    },
  ],
  [
    "a saved model missing from the catalog leaves Codex on the first live model",
    {
      configured: FLARE_MODEL.id,
      data: [IMAGE_MODEL, CHAT_MODEL],
      model: IMAGE_MODEL.id,
      path: "/v1/images/generations",
      request: CODEX_GENERATION_REQUEST,
    },
  ],
  [
    "a generation-only saved model still serves generations",
    {
      configured: GENERATION_ONLY_MODEL.id,
      data: [GENERATION_ONLY_MODEL, IMAGE_MODEL],
      model: GENERATION_ONLY_MODEL.id,
      path: "/v1/images/generations",
      request: CODEX_GENERATION_REQUEST,
    },
  ],
  [
    "a generation-only saved model leaves edits to automatic routing",
    {
      configured: GENERATION_ONLY_MODEL.id,
      data: [GENERATION_ONLY_MODEL, IMAGE_MODEL],
      model: IMAGE_MODEL.id,
      path: "/v1/images/edits",
      request: CODEX_EDIT_REQUEST,
    },
  ],
])("%s", async (_case, { configured, data, model, path, request }) => {
  state.models = { object: "list", data }
  await setImageRoutingModel(configured)

  const response = await postImages(path, JSON.stringify(request))

  expect(response.status).toBe(200)
  expect(decode(upstreamRequests[0]?.body)).toEqual({ ...request, model })
})
