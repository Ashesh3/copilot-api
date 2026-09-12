import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { getLlmDebugLog, listLlmDebugLogs } from "~/lib/llm-debug-log"
import { clearModelFallbackCache } from "~/lib/model-fallback"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
} from "./helpers/admin-session"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const SOURCE_MODEL = "claude-fable-5.1"
const TARGET_MODEL = "claude-opus-4.8"
const SECOND_GATEWAY_KEY = "second-observation-fixture-key"
const originalFetch = globalThis.fetch
const originalState = { ...state }
const calls: Array<Record<string, unknown>> = []
let reply: (body: Record<string, unknown>) => Response

function nativeModel(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "Anthropic",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/v1/messages"],
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function messageResponse(
  body: Record<string, unknown>,
  options: { refused?: boolean; upstreamFallback?: boolean } = {},
): Response {
  const content: Array<Record<string, unknown>> =
    options.refused ? [] : [{ type: "text", text: "Synthetic review result" }]
  if (options.upstreamFallback) {
    content.unshift({
      type: "fallback",
      from: { model: SOURCE_MODEL },
      to: { model: TARGET_MODEL },
    })
  }
  const message = {
    id: `msg_observation_${calls.length}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: options.refused ? "refusal" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: options.refused ? 0 : 1 },
  }
  if (!body.stream) return Response.json(message)
  const events: Array<{ type: string } & Record<string, unknown>> = [
    {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null },
    },
  ]
  for (const [index, block] of content.entries()) {
    events.push(
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    )
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason },
      usage: { output_tokens: message.usage.output_tokens },
    },
    { type: "message_stop" },
  )
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function payload(model: string, stream = true): Record<string, unknown> {
  return {
    model,
    max_tokens: 128,
    stream,
    messages: [{ role: "user", content: "Review this synthetic fixture" }],
    metadata: {
      user_id: JSON.stringify({
        session_id: "claude-observation-session",
        device_id: "fixture-device",
      }),
    },
  }
}

function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return server.request("/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": PROTOCOL_GATEWAY_KEY,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  calls.length = 0
  Object.assign(state, {
    copilotToken: "observation-fixture-token",
    githubToken: "observation-fixture-token",
    accountType: "individual",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: {
      object: "list",
      data: [nativeModel(SOURCE_MODEL), nativeModel(TARGET_MODEL)],
    },
  })
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  clearModelFallbackCache()
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({ enabled: false, rules: [] }),
  )
  await seedProtocolDatabase({
    gatewayKeys: [PROTOCOL_GATEWAY_KEY, SECOND_GATEWAY_KEY],
  })
  reply = (body) =>
    messageResponse(body, { refused: body.model === SOURCE_MODEL })
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/v1/messages" || typeof init?.body !== "string") {
      throw new Error("Unexpected inference request in fallback fixture")
    }
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push(body)
    return Promise.resolve(reply(body))
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  clearModelFallbackCache()
  await resetTestAdminSession()
})

test.each([false, true])(
  "observes the next client model retry after a native refusal, stream=%s",
  async (stream) => {
    const first = await post(payload(SOURCE_MODEL, stream))
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('"refusal"')
    const source = (await listLlmDebugLogs()).entries.find(
      (entry) => entry.model === SOURCE_MODEL,
    )
    expect(source?.status).toBe("complete")
    expect(source?.fallback).toBeUndefined()

    const retry = await post(payload(TARGET_MODEL, stream))
    expect(retry.status).toBe(200)
    expect(await retry.text()).toContain("Synthetic review result")
    expect(calls.map((body) => body.model)).toEqual([
      SOURCE_MODEL,
      TARGET_MODEL,
    ])
    const target = (await listLlmDebugLogs()).entries.find(
      (entry) => entry.model === TARGET_MODEL,
    )
    const observation = {
      kind: "client",
      fromModel: SOURCE_MODEL,
      targetModel: TARGET_MODEL,
      previousLogId: source?.id,
      reason: "refusal",
      evidence: "inferred",
    }
    expect(target).toMatchObject({ fallbackObservations: [observation] })
    expect(target?.fallback).toBeUndefined()
    expect(await getLlmDebugLog(target?.id ?? "")).toMatchObject({
      fallbackObservations: [observation],
    })

    const nextTurn = await post({
      ...payload(TARGET_MODEL, stream),
      messages: [{ role: "user", content: "Continue the review" }],
    })
    await nextTurn.text()
    const nextCapture = (await listLlmDebugLogs()).entries.find(
      (entry) => entry.requestPreview === "Continue the review",
    )
    expect(nextCapture).toBeDefined()
    expect(nextCapture).not.toHaveProperty("fallbackObservations")
  },
)

const isolatedIdentityCases: Array<{
  name: string
  first: Record<string, string>
  second: Record<string, string>
}> = [
  {
    name: "credential",
    first: {},
    second: { "x-api-key": SECOND_GATEWAY_KEY },
  },
  {
    name: "child thread",
    first: { "thread-id": "child-a" },
    second: { "thread-id": "child-b" },
  },
]

test.each(isolatedIdentityCases)(
  "does not infer across a different $name",
  async ({ first, second }) => {
    await (await post(payload(SOURCE_MODEL), first)).text()
    await (await post(payload(TARGET_MODEL), second)).text()
    const target = (await listLlmDebugLogs()).entries.find(
      (entry) => entry.model === TARGET_MODEL,
    )
    expect(target).not.toHaveProperty("fallbackObservations")
  },
)

test("does not infer a model retry when normalization hides another input change", async () => {
  const first = await post({
    ...payload(SOURCE_MODEL),
    diagnostics: { label: "first request" },
  })
  await first.text()
  await (await post(payload(TARGET_MODEL))).text()
  expect(calls[0]).not.toHaveProperty("diagnostics")
  expect(calls[1]).not.toHaveProperty("diagnostics")
  const target = (await listLlmDebugLogs()).entries.find(
    (entry) => entry.model === TARGET_MODEL,
  )
  expect(target).not.toHaveProperty("fallbackObservations")
})

test("exposes requested fallback policy on a rejected request without claiming execution", async () => {
  reply = () =>
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "fallbacks: Extra inputs are not permitted",
        },
      },
      { status: 400 },
    )
  const response = await post({
    ...payload(SOURCE_MODEL, false),
    fallbacks: [{ model: "claude-opus-5" }],
  })
  expect(response.status).toBe(400)
  await response.text()
  expect(calls).toHaveLength(1)
  const entry = (await listLlmDebugLogs()).entries[0]
  expect(entry).toMatchObject({
    status: "error",
    fallbackObservations: [
      {
        kind: "requested",
        sourceModel: SOURCE_MODEL,
        targetModels: ["claude-opus-5"],
      },
    ],
  })
  expect(entry.fallback).toBeUndefined()
})

test("dashboard list and detail expose explicit upstream fallback evidence", async () => {
  reply = (body) => messageResponse(body, { upstreamFallback: true })
  const response = await post({
    ...payload(SOURCE_MODEL),
    fallbacks: "default",
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"fallback"')
  expect(calls).toHaveLength(1)
  const admin = await createTestAdminSession({ reuseStorage: true })
  const listResponse = await server.request("/dashboard/api/llm-debug", {
    headers: adminHeaders(admin, false),
  })
  expect(listResponse.status).toBe(200)
  const list = (await listResponse.json()) as {
    entries: Array<{ id: string; fallback?: unknown }>
  }
  const expected = [
    { kind: "requested", sourceModel: SOURCE_MODEL, targetModels: "default" },
    { kind: "upstream", fromModel: SOURCE_MODEL, targetModel: TARGET_MODEL },
  ]
  expect(list.entries[0]).toMatchObject({ fallbackObservations: expected })
  expect(list.entries[0].fallback).toBeUndefined()
  const detailResponse = await server.request(
    `/dashboard/api/llm-debug/${list.entries[0].id}`,
    { headers: adminHeaders(admin, false) },
  )
  expect(detailResponse.status).toBe(200)
  expect(await detailResponse.json()).toMatchObject({
    fallbackObservations: expected,
  })
})

test("keeps configured fallback distinct from client policy and injected client notices", async () => {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      nativeClientNotice: true,
      rules: [
        {
          id: "configured-fixture",
          enabled: true,
          sourceModel: SOURCE_MODEL,
          targetModel: TARGET_MODEL,
        },
      ],
    }),
  )
  reply = (body) =>
    body.model === SOURCE_MODEL ?
      new Response("synthetic configured fallback", { status: 422 })
    : messageResponse(body)
  const response = await post(
    { ...payload(SOURCE_MODEL), fallbacks: "default" },
    { "anthropic-beta": "server-side-fallback-2026-07-01" },
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"type":"fallback"')
  expect(calls.map((body) => body.model)).toEqual([SOURCE_MODEL, TARGET_MODEL])
  const target = (await listLlmDebugLogs()).entries.find(
    (entry) => entry.model === TARGET_MODEL,
  )
  expect(target).toMatchObject({
    fallback: {
      reason: "http_422",
      fromModel: SOURCE_MODEL,
      targetModel: TARGET_MODEL,
      cached: false,
    },
    fallbackObservations: [
      { kind: "requested", sourceModel: SOURCE_MODEL, targetModels: "default" },
    ],
  })
})
