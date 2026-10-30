import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { setResponseProgressIntervalForTest } from "~/routes/responses/pending-response"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  apiKeyAuth: state.apiKeyAuth,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  models: state.models,
}
const sourceModel = "claude-source"
const targetModel = "claude-target"
const requests: Array<Record<string, unknown>> = []

beforeEach(() => {
  requests.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setResponseProgressIntervalForTest(5)
  state.apiKeyAuth = "ws-client-secret"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [sourceModel, targetModel].map((id) => ({
      id,
      name: id,
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 4096 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })),
  } satisfies ModelsResponse
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setResponseProgressIntervalForTest()
})

/** Each upstream Messages call answers after `delayMs` with the next body. */
function installSlowUpstream(
  bodies: Array<Record<string, unknown>>,
  delayMs = 40,
): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON request body")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    const body = bodies.shift()
    if (!body) throw new Error("Unexpected upstream request")
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return Response.json(body)
  }) as typeof fetch
}

function message(options: {
  id: string
  model: string
  stopReason: "end_turn" | "refusal"
  text: string
}): Record<string, unknown> {
  const { id, model, stopReason, text } = options
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  }
}

async function createSocket() {
  let data: ResponsesWebSocketData | undefined
  await seedProtocolDatabase().then(() =>
    tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: {
          authorization: "Bearer ws-client-secret",
          "session-id": crypto.randomUUID(),
        },
      }),
      {
        upgrade(_request, options) {
          data = (options as { data: ResponsesWebSocketData }).data
          return true
        },
      },
    ),
  )
  if (!data) throw new Error("Expected authenticated WebSocket upgrade")
  const sent: Array<Record<string, unknown>> = []
  return {
    data,
    sent,
    send(frame: string) {
      sent.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
}

async function sendTurn(ws: Awaited<ReturnType<typeof createSocket>>) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: sourceModel,
      max_output_tokens: 128,
      input: "Explain the change",
    }),
  )
}

function progressFramesBeforeResponse(sent: Array<Record<string, unknown>>) {
  const created = sent.findIndex((frame) => frame.type === "response.created")
  return sent.slice(0, created)
}

test("keeps a slow Messages turn alive with frames Codex counts", async () => {
  installSlowUpstream([
    message({
      id: "msg_slow",
      model: sourceModel,
      stopReason: "end_turn",
      text: "Done",
    }),
  ])
  const ws = await createSocket()

  await sendTurn(ws)

  const progress = progressFramesBeforeResponse(ws.sent)
  expect(progress.length).toBeGreaterThanOrEqual(2)
  expect(progress).toEqual(
    progress.map(() => ({ type: "response.in_progress" })),
  )
  const rest = ws.sent.slice(progress.length)
  expect(rest.map((frame) => frame.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ])
  expect(rest.at(-1)).toMatchObject({
    response: { id: "msg_slow", output_text: "Done" },
  })
})

test("still falls back after progress frames when the slow model refuses", async () => {
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: false,
    nativeClientNotice: false,
    rules: [{ id: "ws", sourceModel, targetModel, enabled: true }],
  })
  installSlowUpstream([
    message({
      id: "msg_refused",
      model: sourceModel,
      stopReason: "refusal",
      text: "",
    }),
    message({
      id: "msg_target",
      model: targetModel,
      stopReason: "end_turn",
      text: "Answered by the target",
    }),
  ])
  const ws = await createSocket()

  await sendTurn(ws)

  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    targetModel,
  ])
  const progress = progressFramesBeforeResponse(ws.sent)
  expect(progress.length).toBeGreaterThanOrEqual(2)
  expect(
    ws.sent.filter((frame) => frame.type === "response.created"),
  ).toHaveLength(1)
  expect(ws.sent.at(-1)).toMatchObject({
    type: "response.completed",
    response: { output_text: "Answered by the target" },
  })
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
})
