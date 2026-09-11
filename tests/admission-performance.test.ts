import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import type { SqlSession } from "~/lib/storage/types"
import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model } from "~/services/copilot/get-models"

import { getAccountsService } from "~/lib/accounts-service"
import { apiKeyGuard } from "~/lib/api-key-guard"
import {
  resolveCredential,
  resolveRequestCredential,
} from "~/lib/credential-resolver"
import { resetIpAllowlistForTest } from "~/lib/ip-allowlist"
import { resetIpSecurityForTest } from "~/lib/ip-blocker"
import { hashOAuthSecret, OAuthStore } from "~/lib/oauth-store"
import { createAuthMiddleware } from "~/lib/request-auth"
import { state } from "~/lib/state"
import { getStoreRevision } from "~/lib/storage/operations"
import { getStorageRuntime } from "~/lib/storage/runtime"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const gateway = "admission-fixture-gateway"
const managed = "admission-fixture-managed.jwt"
const oauth = "cc_at_admission-fixture-oauth"
const clientIp = "198.51.100.20"
const originalState = { ...state }
const originalFetch = globalThis.fetch
const model: Model = {
  id: "gpt-5.4",
  name: "Fixture",
  object: "model",
  version: "1",
  supported_endpoints: ["/responses"],
  capabilities: {
    family: "gpt",
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
}
let sql: Array<string>
let reads: number
let writes: number
let upstreamCalls: number
let restoreCounters: () => void

function countSession(session: SqlSession): SqlSession {
  return {
    query: (statement) => {
      sql.push(statement.sql)
      return session.query(statement)
    },
    execute: (statement) => {
      sql.push(statement.sql)
      return session.execute(statement)
    },
  }
}

function resetCounters() {
  sql = []
  reads = 0
  writes = 0
}

function fakeResponse(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== "api.githubcopilot.com" || url.pathname !== "/responses")
    throw new Error("Unexpected upstream request")
  upstreamCalls++
  if (typeof init?.body !== "string") throw new Error("Expected JSON payload")
  const payload: unknown = JSON.parse(init.body)
  const result = {
    id: `resp_admission_${upstreamCalls}`,
    object: "response",
    model: model.id,
    status: "completed",
    output: [],
    output_text: "",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  if (
    payload
    && typeof payload === "object"
    && "stream" in payload
    && !payload.stream
  )
    return Promise.resolve(Response.json(result))
  const frame = {
    type: "response.completed",
    sequence_number: 0,
    response: result,
  }
  return Promise.resolve(
    new Response(
      `event: response.completed\ndata: ${JSON.stringify(frame)}\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    ),
  )
}

beforeEach(async () => {
  resetIpSecurityForTest()
  resetIpAllowlistForTest()
  state.copilotToken = "admission-fixture-upstream"
  state.githubToken = "admission-fixture-upstream"
  state.copilotApiBaseUrl = "https://api.githubcopilot.com"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = { object: "list", data: [model] }
  globalThis.fetch = fakeResponse as typeof fetch
  upstreamCalls = 0
  await seedProtocolDatabase({
    gatewayKeys: [gateway],
    inferenceKeys: [managed],
  })
  const runtime = getStorageRuntime()
  await runtime.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_oauth_families(id,created_at,expires_at) VALUES('admission-family',0,1)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_oauth_access(digest,family_id,principal_id,client_id,scopes_json,created_at,expires_at) VALUES(?,'admission-family','admission:oauth','fixture-client','[\"user:inference\",\"user:profile\"]',0,1)",
      args: [hashOAuthSecret(oauth)],
    },
    {
      sql: "INSERT INTO capi_ip_allowlist(ip,enabled,source,created_at,updated_at,last_seen_at) VALUES(?,1,'authenticated',0,0,1)",
      args: [clientIp],
    },
  ])
  await runtime.snapshot.refreshIfChanged()
  await getAccountsService().refreshRuntime()
  await getAccountsService().whenIdle()
  const read = runtime.storage.read.bind(runtime.storage)
  const transaction = runtime.storage.transaction.bind(runtime.storage)
  const readSpy = spyOn(runtime.storage, "read").mockImplementation((work) => {
    reads++
    return read((session) => work(countSession(session)))
  })
  const transactionSpy = spyOn(
    runtime.storage,
    "transaction",
  ).mockImplementation((work) => {
    writes++
    return transaction((session) => work(countSession(session)))
  })
  restoreCounters = () => {
    readSpy.mockRestore()
    transactionSpy.mockRestore()
  }
  resetCounters()
})

afterEach(() => {
  restoreCounters()
  resetIpSecurityForTest()
  resetIpAllowlistForTest()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

function request(credential: string, path = "/v1/models") {
  return new Request(`http://localhost${path}`, {
    headers: {
      authorization: `Bearer ${credential}`,
      "x-copilot-peer-ip": clientIp,
    },
  })
}

async function upgradedSocket(credential: string) {
  let data: ResponsesWebSocketData | undefined
  const status = await tryUpgradeResponsesWebSocket(
    request(credential, "/v1/responses"),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  expect(status).toBe("upgraded")
  if (!data) throw new Error("WebSocket upgrade did not capture its state")
  const frames: Array<Record<string, unknown>> = []
  return {
    data,
    frames,
    send: (frame: string) => {
      frames.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
}

test.each([
  { kind: "gateway", key: gateway, queryCount: 3, readCount: 3 },
  { kind: "managed", key: managed, queryCount: 2, readCount: 2 },
  { kind: "OAuth", key: oauth, queryCount: 5, readCount: 4 },
])(
  "$kind classification performs each credential lookup once",
  async ({ key, queryCount, readCount }) => {
    expect(await resolveCredential(key, ["user:inference"])).not.toBeNull()
    expect(sql).toHaveLength(queryCount)
    expect(reads).toBe(readCount)
    expect(writes).toBe(0)
  },
)

test.each([
  { kind: "gateway", key: gateway, queryCount: 5, readCount: 5 },
  { kind: "managed", key: managed, queryCount: 4, readCount: 4 },
  { kind: "OAuth", key: oauth, queryCount: 7, readCount: 6 },
])(
  "HTTP $kind admission performs one revision, credential and IP check",
  async ({ key, queryCount, readCount }) => {
    const response = await server.fetch(request(key))
    expect(response.status).toBe(200)
    expect(sql).toHaveLength(queryCount)
    expect(reads).toBe(readCount)
    expect(writes).toBe(0)
    expect(
      sql.filter((statement) =>
        statement.includes("WHERE key = 'config_revision'"),
      ),
    ).toHaveLength(1)
    expect(
      sql.filter((statement) =>
        statement.includes("FROM capi_ip_allowlist WHERE ip = ?"),
      ),
    ).toHaveLength(1)
  },
)

test.each([
  { kind: "gateway", key: gateway, queryCount: 4, readCount: 4 },
  { kind: "managed", key: managed, queryCount: 3, readCount: 3 },
  { kind: "OAuth", key: oauth, queryCount: 6, readCount: 5 },
])(
  "WebSocket $kind turn completes with one fresh admission",
  async ({ key, queryCount, readCount }) => {
    const ws = await upgradedSocket(key)
    resetCounters()
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: model.id,
        input: "hello",
      }),
    )
    expect(ws.frames.some((frame) => frame.type === "response.completed")).toBe(
      true,
    )
    expect(sql).toHaveLength(queryCount)
    expect(reads).toBe(readCount)
    expect(writes).toBe(0)
    expect(upstreamCalls).toBe(1)
  },
)

test("OAuth revocation without a revision change rejects the next HTTP request and existing socket turn", async () => {
  const ws = await upgradedSocket(oauth)
  const repeatedRequest = request(oauth)
  expect((await server.fetch(repeatedRequest)).status).toBe(200)
  const frame = JSON.stringify({
    type: "response.create",
    model: model.id,
    input: "hello",
  })
  await responsesWebSocket.message(ws, frame)
  expect(ws.frames.some((value) => value.type === "response.completed")).toBe(
    true,
  )
  const storage = getStorageRuntime().storage
  const revision = await getStoreRevision(storage)
  await new OAuthStore({ storage }).revokeToken(oauth)
  expect(await getStoreRevision(storage)).toBe(revision)
  expect((await server.fetch(repeatedRequest)).status).toBe(401)
  ws.frames.length = 0
  await responsesWebSocket.message(ws, frame)
  expect(
    ws.frames.some((value) => value.type === "error" && value.status === 401),
  ).toBe(true)
  expect(upstreamCalls).toBe(1)
})

test("managed disable and gateway deletion are observed across new admissions", async () => {
  for (const key of [managed, gateway])
    expect((await server.fetch(request(key))).status).toBe(200)
  await getStorageRuntime().storage.atomicBatch([
    { sql: "UPDATE capi_inference_credentials SET enabled=0", args: [] },
    { sql: "DELETE FROM capi_gateway_secrets", args: [] },
    { sql: "DELETE FROM capi_gateway_credentials", args: [] },
  ])
  for (const key of [managed, gateway])
    expect((await server.fetch(request(key))).status).toBe(401)
})

test("inference admission does not widen scopes or replace injected custom authentication", async () => {
  const scoped = new Hono()
    .use("*", apiKeyGuard)
    .use("*", createAuthMiddleware())
    .get("/protected", async (c) =>
      c.json({
        profile: await resolveRequestCredential(c.req.raw, ["user:profile"]),
      }),
    )
  expect(
    await (await scoped.fetch(request(managed, "/protected"))).json(),
  ).toEqual({ profile: null })
  const custom = new Hono()
    .use("*", apiKeyGuard)
    .use(
      "*",
      createAuthMiddleware({ getApiKeys: () => ["separate-custom-key"] }),
    )
    .get("/protected", (c) => c.json({ ok: true }))
  expect((await custom.fetch(request(gateway, "/protected"))).status).toBe(401)
  const independent = new Hono()
    .use("*", createAuthMiddleware())
    .get("/protected", (c) => c.json({ ok: true }))
  expect((await independent.fetch(request(gateway, "/protected"))).status).toBe(
    200,
  )
  expect(
    (await independent.fetch(request("unknown", "/protected"))).status,
  ).toBe(401)
})

test("the second guard rechecks a credential changed by intervening middleware", async () => {
  const app = new Hono()
    .use("*", apiKeyGuard)
    .use("*", async (c, next) => {
      c.req.raw.headers.set("authorization", "Bearer unknown")
      await next()
    })
    .use("*", createAuthMiddleware())
    .get("/protected", (c) => c.json({ ok: true }))
  expect((await app.fetch(request(gateway, "/protected"))).status).toBe(401)
})
