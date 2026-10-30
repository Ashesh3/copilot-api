import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { server } from "../src/server"
import { resetExtendedCacheTtlRefusalForTest } from "../src/services/copilot/extended-cache-ttl"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const upstreamBodies: Array<string> = []
const upstreamAuthorization: Array<string | null> = []
// Bearer values of accounts that accept long-lived prompt caching.
const extendedTtlAccounts = new Set<string>()
const POOLED_ACCOUNTS = {
  refusing: { id: 97_101, token: "ttl-refusing-token" },
  accepting: { id: 97_102, token: "ttl-accepting-token" },
} as const

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-cache-model",
      name: "Claude Cache Model",
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
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

// Copilot refuses long-lived prompt caching for accounts without it.
const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? init.body : ""
  const authorization = new Headers(init?.headers).get("authorization")
  upstreamBodies.push(body)
  upstreamAuthorization.push(authorization)
  if (
    body.includes('"ttl":"1h"')
    && !extendedTtlAccounts.has(authorization ?? "")
  ) {
    return Response.json(
      {
        error: {
          message:
            "Long-lived prompt caching (cache_control with a ttl other than 5m) is not supported.",
          code: "unsupported_value",
        },
      },
      { status: 400 },
    )
  }
  return Response.json({
    id: "msg_cache",
    type: "message",
    role: "assistant",
    model: "claude-cache-model",
    content: [{ type: "text", text: "cached" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamBodies.length = 0
  upstreamAuthorization.length = 0
  extendedTtlAccounts.clear()
  resetExtendedCacheTtlRefusalForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = models
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  resetExtendedCacheTtlRefusalForTest()
  for (const { id } of Object.values(POOLED_ACCOUNTS)) {
    tokenPool.removeAccountForTest(id)
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = false
})

async function postMessages(sessionId?: string): Promise<Response> {
  return await server.request("/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
      ...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      model: "claude-cache-model",
      max_tokens: 64,
      system: [
        {
          type: "text",
          text: "Instructions.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    }),
  })
}

test("falls back to the default cache lifetime once Copilot refuses 1h", async () => {
  await seedProtocolDatabase()
  const first = await postMessages()
  const second = await postMessages()

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(await second.json()).toMatchObject({
    content: [{ type: "text", text: "cached" }],
  })
  expect(upstreamBodies.map((body) => body.includes('"ttl":"1h"'))).toEqual([
    true,
    false,
    false,
  ])
  for (const body of upstreamBodies.slice(1)) {
    expect(body).toContain('"ttl":"5m"')
  }
})

/** Pool two accounts serving the model; returns a session bound to each. */
function installPooledAccounts(): Record<keyof typeof POOLED_ACCOUNTS, string> {
  for (const { id, token } of Object.values(POOLED_ACCOUNTS)) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set(["claude-cache-model"])
    account.modelsData = models.data
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const sessionFor = (accountId: number): string => {
    const sessionId = Array.from(
      { length: 1000 },
      (_, index) => `ttl-session-${index}`,
    ).find(
      (candidate) =>
        tokenPool.getAccountForModelBySession("claude-cache-model", candidate)
          ?.id === accountId,
    )
    if (!sessionId) throw new TypeError(`No session for account ${accountId}`)
    return sessionId
  }
  return {
    refusing: sessionFor(POOLED_ACCOUNTS.refusing.id),
    accepting: sessionFor(POOLED_ACCOUNTS.accepting.id),
  }
}

test("keeps 1h caching on pooled accounts that did not refuse it", async () => {
  const sessions = installPooledAccounts()
  await seedProtocolDatabase()
  extendedTtlAccounts.add(`Bearer ${POOLED_ACCOUNTS.accepting.token}`)

  for (const sessionId of [
    sessions.refusing,
    sessions.accepting,
    sessions.refusing,
  ]) {
    expect((await postMessages(sessionId)).status).toBe(200)
  }

  expect(
    upstreamBodies.map((body, index) => [
      upstreamAuthorization[index],
      body.includes('"ttl":"1h"'),
    ]),
  ).toEqual([
    [`Bearer ${POOLED_ACCOUNTS.refusing.token}`, true],
    [`Bearer ${POOLED_ACCOUNTS.refusing.token}`, false],
    [`Bearer ${POOLED_ACCOUNTS.accepting.token}`, true],
    [`Bearer ${POOLED_ACCOUNTS.refusing.token}`, false],
  ])
})
