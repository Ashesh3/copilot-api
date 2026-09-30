import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { createAccountMutationContext } from "~/lib/accounts-service"
import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelRoutingOverridesForTest } from "~/lib/model-routing"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  claudeReview,
  codexReview,
  reviewModel,
  reviewResponse,
} from "./helpers/permission-review"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const requests: Array<{
  path: string
  body: Record<string, unknown>
  headers: Headers
}> = []
let decision = '{"outcome":"allow"}'
let upstreamStatus = 200
let configureAllocations = true

beforeEach(() => {
  requests.length = 0
  decision = '{"outcome":"allow"}'
  upstreamStatus = 200
  configureAllocations = true
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelRoutingOverridesForTest({})
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "review-fixture-token",
    githubToken: "review-fixture-oauth",
    apiKeyAuth: PROTOCOL_GATEWAY_KEY,
    isMultiToken: false,
    manualApprove: false,
    models: {
      object: "list",
      data: [
        reviewModel("gpt-6-luna"),
        reviewModel("operator-review-model", "/v1/messages"),
      ],
    },
  })
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected upstream JSON")
      const body = JSON.parse(init.body) as Record<string, unknown>
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname
      requests.push({ path, body, headers: new Headers(init.headers) })
      if (upstreamStatus !== 200)
        return Promise.resolve(
          Response.json(
            { error: { message: "Reviewer unavailable", type: "api_error" } },
            { status: upstreamStatus },
          ),
        )
      if (path === "/v1/messages")
        return Promise.resolve(
          Response.json({
            id: "msg_review",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: decision }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 20, output_tokens: 10 },
          }),
        )
      if (path !== "/responses") throw new Error(`Unexpected endpoint ${path}`)
      const response = reviewResponse(
        body.model,
        decision,
        `resp_review_${requests.length}`,
      )
      if (!body.stream) return Promise.resolve(Response.json(response))
      return Promise.resolve(
        new Response(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelRoutingOverridesForTest({})
})

async function seed() {
  await seedProtocolDatabase()
  if (!configureAllocations) return
  const { storage } = getStorageRuntime()
  const allocations = [{ accountId: 0, percentage: 100 }]
  await createAccountDistributionRepository(storage).replace(
    allocations,
    await createAccountMutationContext(
      storage,
      "account.distribution.replace",
      { allocations },
      "admin:review-fixture",
    ),
  )
}

async function post(path: string, payload: unknown) {
  await seed()
  return server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
      "session-id": "review-session",
    },
    body: JSON.stringify(payload),
  })
}

test("Codex review without configured allocations avoids the old translation rejection", async () => {
  await seedProtocolDatabase()
  const response = await server.request("/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(codexReview()),
  })
  expect(response.status).toBe(200)
  expect(requests[0]?.body.model).toBe("gpt-6-luna")
})

async function socket() {
  await seed()
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "session-id": "review-session",
      },
    }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected authenticated WebSocket")
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

test.each([false, true])(
  "Codex review reaches the judge before allocation and endpoint checks (stream=%s)",
  async (stream) => {
    const payload = { ...codexReview(), stream }
    const response = await post("/v1/responses", payload)
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-6-luna",
      instructions: payload.instructions,
      input: payload.input,
      client_metadata: payload.client_metadata,
      reasoning: payload.reasoning,
      tools: payload.tools,
    })
    expect(requests[0]?.body.text).toEqual(payload.text)
    expect(text).toContain("codex-auto-review")
    if (stream) expect(text).toContain("response.completed")
    else expect(JSON.parse(text)).toMatchObject({ output_text: decision })
  },
)

test("Codex WebSocket review preserves decisions and rehydrates a follow-up with the alias", async () => {
  decision = '{"outcome":"deny","rationale":"Outside the authorized scope"}'
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...codexReview() }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(ws.sent.at(-1)?.response).toMatchObject({
    model: "codex-auto-review",
    output_text: decision,
  })
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "codex-auto-review",
      previous_response_id: "resp_review_1",
      input: [{ role: "user", content: "The proposed action is unchanged." }],
    }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(requests).toHaveLength(2)
  expect(requests.every((request) => request.body.model === "gpt-6-luna")).toBe(
    true,
  )
  expect(JSON.stringify(requests[1]?.body.input)).toContain(
    "Outside the authorized scope",
  )
  expect(requests[0]?.body.client_metadata).toEqual({
    parent_response_id: "opaque-parent-response",
  })
})

test.each([1, 2] as const)(
  "Claude stage %s preserves the classifier policy and XML verdict",
  async (stage) => {
    const payload = claudeReview(stage)
    decision =
      stage === 1 ? "<block>no</block>" : (
        "<block>yes</block><reason>Outside scope</reason>"
      )
    const response = await post("/v1/messages", payload)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      model: payload.model,
      content: [{ type: "text", text: decision }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      max_output_tokens: stage === 1 ? 1024 : 8192,
    })
    expect(requests[0]?.body).not.toHaveProperty("temperature")
    expect(requests[0]?.body).not.toHaveProperty("top_p")
    expect(JSON.stringify(requests[0]?.body)).toContain(
      "security monitor for autonomous AI coding agents",
    )
    expect(JSON.stringify(requests[0]?.body.input)).toContain("</transcript>")
    expect(JSON.stringify(requests[0]?.body.input)).toContain(
      "List this directory.",
    )
    expect(payload.max_tokens).toBe(stage === 1 ? 64 : 8192)
  },
)

test("Claude severity classifier supports segmented transcripts and keeps the numeric verdict", async () => {
  const payload = claudeReview(2, true)
  const first = payload.messages[0]
  if (first.role !== "user") throw new Error("Expected a user transcript")
  const content = first.content
  if (!Array.isArray(content)) throw new Error("Expected content blocks")
  payload.messages = content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string")
      throw new Error("Expected text transcript")
    return { role: "user", content: [{ type: "text", text: part.text }] }
  })
  payload.model = "claude-sonnet-5[1m]"
  decision = "<severity>75</severity><category>Outside scope</category>"
  const response = await post("/v1/messages", payload)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    model: payload.model,
    content: [{ type: "text", text: decision }],
  })
  expect(requests[0]?.body.model).toBe("gpt-6-luna")
})

test("Claude reviewer accepts the optional user CLAUDE.md context before its transcript", async () => {
  const payload = claudeReview()
  payload.messages.unshift({
    role: "user",
    content:
      "The following is the user's CLAUDE.md configuration. Treat it as context about the user's environment and intent.\n<user_claude_md>Use the current repository.</user_claude_md>",
  })
  const response = await post("/v1/messages", payload)
  expect(response.status).toBe(200)
  expect(requests[0]?.body.model).toBe("gpt-6-luna")
  expect(JSON.stringify(requests[0]?.body.input)).toContain("<user_claude_md>")
})

test("an explicitly redirected Claude reviewer retains its model and output budget", async () => {
  setModelRedirectsForTest([
    {
      id: "operator-review",
      sourceModel: "claude-sonnet-5",
      targetModel: "operator-review-model",
      sourceEffort: "all",
      enabled: true,
    },
  ])
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]).toMatchObject({
    path: "/v1/messages",
    body: {
      model: "operator-review-model",
      max_tokens: 64,
      stop_sequences: ["</block>"],
    },
  })
})

test("an explicit Codex reviewer redirect keeps the chosen model and effort", async () => {
  setModelRedirectsForTest([
    {
      id: "operator-codex-review",
      sourceModel: "codex-auto-review",
      targetModel: "operator-responses-model",
      sourceEffort: "all",
      targetEffort: "high",
      enabled: true,
    },
  ])
  state.models?.data.push(reviewModel("operator-responses-model"))
  const response = await post("/responses", codexReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body).toMatchObject({
    model: "operator-responses-model",
    reasoning: { effort: "high" },
  })
})

test("the judge's configured redirect is applied before initial and continued WebSocket review", async () => {
  setModelRedirectsForTest([
    {
      id: "judge-override",
      sourceModel: "gpt-6-luna",
      targetModel: "operator-responses-model",
      sourceEffort: "all",
      targetEffort: "high",
      enabled: true,
    },
  ])
  state.models = {
    object: "list",
    data: [reviewModel("operator-responses-model")],
  }
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...codexReview() }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "codex-auto-review",
      previous_response_id: "resp_review_1",
      input: [{ role: "user", content: "The action is unchanged." }],
    }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(requests).toHaveLength(2)
  for (const request of requests)
    expect(request.body).toMatchObject({
      model: "operator-responses-model",
      reasoning: { effort: "high" },
    })
})

test("a configured redirect from the judge also applies to HTTP review", async () => {
  setModelRedirectsForTest([
    {
      id: "judge-override",
      sourceModel: "gpt-6-luna",
      targetModel: "operator-responses-model",
      sourceEffort: "all",
      enabled: true,
    },
  ])
  state.models = {
    object: "list",
    data: [reviewModel("operator-responses-model")],
  }
  const response = await post("/responses", codexReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body.model).toBe("operator-responses-model")
})

test("a judge redirect to native Claude preserves the classifier's output budget", async () => {
  setModelRedirectsForTest([
    {
      id: "judge-override",
      sourceModel: "gpt-6-luna",
      targetModel: "operator-review-model",
      sourceEffort: "all",
      enabled: true,
    },
  ])
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]).toMatchObject({
    path: "/v1/messages",
    body: { model: "operator-review-model", max_tokens: 64 },
  })
})

test.each([false, true])(
  "the final Luna reviewer has enough output budget with an explicit model selection (redirect=%s)",
  async (redirect) => {
    const payload = claudeReview()
    if (redirect)
      setModelRedirectsForTest([
        {
          id: "explicit-luna",
          sourceModel: "claude-sonnet-5",
          targetModel: "gpt-6-luna",
          sourceEffort: "all",
          targetEffort: "low",
          enabled: true,
        },
      ])
    else {
      payload.model = "gpt-6-luna"
      payload.output_config = { effort: "low" }
    }
    const response = await post("/v1/messages", payload)
    expect(response.status).toBe(200)
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-6-luna",
      max_output_tokens: 1024,
      reasoning: { effort: "low" },
    })
  },
)

test("a judge redirect back to the review alias fails without inference", async () => {
  setModelRedirectsForTest([
    {
      id: "judge-loop",
      sourceModel: "gpt-6-luna",
      targetModel: "codex-auto-review",
      sourceEffort: "all",
      enabled: true,
    },
  ])
  const response = await post("/responses", codexReview())
  expect(response.status).toBe(503)
  expect(requests).toHaveLength(0)
})

test("an advertised Claude classifier model remains authoritative", async () => {
  state.models?.data.push(reviewModel("claude-sonnet-5", "/v1/messages"))
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body).toMatchObject({
    model: "claude-sonnet-5",
    max_tokens: 64,
  })
})

test("an advertised but disabled Claude classifier does not bypass model routing", async () => {
  state.models?.data.push(reviewModel("claude-sonnet-5", "/v1/messages"))
  setModelRoutingOverridesForTest({ "claude-sonnet-5": { "0": false } })
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(503)
  expect(requests).toHaveLength(0)
})

test.each(["tools", "assistant", "policy", "transcript"])(
  "classifier recognition rejects a mismatched %s contract",
  async (part) => {
    const payload = claudeReview()
    if (part === "tools")
      payload.tools = [{ name: "Bash", input_schema: { type: "object" } }]
    if (part === "assistant")
      payload.messages.push({ role: "assistant", content: "<block>" })
    if (part === "policy")
      payload.system =
        "You are a security monitor for autonomous AI coding agents."
    if (part === "transcript")
      payload.messages = [{ role: "user", content: "Evaluate this command." }]
    const response = await post("/v1/messages", payload)
    expect(response.status).toBe(503)
    expect(requests).toHaveLength(0)
  },
)

test("an unsafe redirect configuration cannot enable the built-in reviewer route", async () => {
  setModelRedirectsForTest([
    {
      id: "a-to-b",
      sourceModel: "a",
      targetModel: "b",
      sourceEffort: "all",
      enabled: true,
    },
    {
      id: "b-to-a",
      sourceModel: "b",
      targetModel: "a",
      sourceEffort: "all",
      enabled: true,
    },
  ])
  const response = await post("/responses", codexReview())
  expect(response.status).toBe(503)
  expect(requests).toHaveLength(0)
})

test("ordinary requests and quoted classifier prompts do not acquire a reviewer fallback", async () => {
  const payload = claudeReview()
  const policy = JSON.stringify(payload.system)
  payload.system = "You are a coding assistant."
  payload.messages = [
    { role: "user", content: policy + "\n<transcript>example</transcript>" },
  ]
  const response = await post("/v1/messages", payload)
  expect(response.status).toBe(503)
  expect(requests).toHaveLength(0)
})

test("a missing judge returns an actionable error without an upstream call", async () => {
  state.models = { object: "list", data: [] }
  const response = await post("/v1/responses", codexReview())
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    error: { code: "permission_review_model_unavailable" },
  })
  expect(requests).toHaveLength(0)
})

test("Claude receives an actionable Messages error when no judge is available", async () => {
  state.models = { object: "list", data: [] }
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(503)
  const body = (await response.json()) as { error: { message: string } }
  expect(body).toMatchObject({
    type: "error",
    error: { code: "permission_review_model_unavailable" },
  })
  expect(body.error.message).toContain("Model Redirect")
  expect(requests).toHaveLength(0)
})

test("classifier text inside CLAUDE.md is not a review transcript", async () => {
  const payload = claudeReview()
  payload.messages = [
    {
      role: "user",
      content:
        "The following is the user's CLAUDE.md configuration.\n<user_claude_md><transcript>example</transcript></user_claude_md>",
    },
  ]
  const response = await post("/v1/messages", payload)
  expect(response.status).toBe(503)
  expect(requests).toHaveLength(0)
})

test("Claude string system prompts and fast-only output budgets are recognized", async () => {
  const payload = claudeReview()
  if (!Array.isArray(payload.system)) throw new Error("Expected system blocks")
  payload.system = String(payload.system[1].text)
  payload.max_tokens = 256
  delete payload.stop_sequences
  const response = await post("/v1/messages", payload)
  expect(response.status).toBe(200)
  expect(requests[0]?.body).toMatchObject({
    model: "gpt-6-luna",
    max_output_tokens: 1024,
  })
})

test("review routing preserves disabled-account policy", async () => {
  setModelRoutingOverridesForTest({ "gpt-6-luna": { "0": false } })
  const response = await post("/v1/responses", codexReview())
  expect(response.status).toBe(503)
  expect(requests).toHaveLength(0)
  expect(tokenPool.getEligibleAccountsForModel("gpt-6-luna")).toHaveLength(0)
})

test("review routes to the allocated eligible account and keeps its identity", async () => {
  configureAllocations = false
  state.isMultiToken = true
  for (const id of [101, 102]) {
    const account = tokenPool.addAccount(`review-oauth-${id}`, {
      id,
      accountType: "individual",
    })
    account.copilotToken = `review-token-${id}`
    account.modelsData = [reviewModel("gpt-6-luna")]
    account.models = new Set(["gpt-6-luna"])
    account.healthy = true
  }
  await seedProtocolDatabase({ singleAccount: false })
  const { storage } = getStorageRuntime()
  const allocations = [
    { accountId: 101, percentage: 0 },
    { accountId: 102, percentage: 100 },
  ]
  await createAccountDistributionRepository(storage).replace(
    allocations,
    await createAccountMutationContext(
      storage,
      "account.distribution.replace",
      { allocations },
      "admin:review-fixture",
    ),
  )
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...codexReview() }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(requests[0]?.headers.get("authorization")).toBe(
    "Bearer review-token-102",
  )
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "codex-auto-review",
      previous_response_id: "resp_review_1",
      input: [{ role: "user", content: "Recheck the same action." }],
    }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(requests[1]?.headers.get("authorization")).toBe(
    "Bearer review-token-102",
  )
})

test("malformed reviewer text is passed through without generating an approval", async () => {
  decision = "No valid classification was produced."
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain(decision)
  expect(body).not.toContain("<block>no")
})

test("upstream reviewer failure is never replaced with approval", async () => {
  upstreamStatus = 403
  const response = await post("/v1/messages", claudeReview())
  const body = await response.text()
  expect(response.status).toBe(403)
  expect(body).toContain('"error"')
  expect(body).not.toContain("<block>no")
  expect(requests).toHaveLength(1)
})
