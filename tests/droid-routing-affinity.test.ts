import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

// What Droid 1.0 sends to a BYOK model with provider "openai".
const DROID_USER_AGENT = "factory-cli/1.0.0"
const SHARED_MODEL = "droid-shared-model"
const SECOND_ONLY_MODEL = "droid-second-only-model"
const ACCOUNTS = [
  { id: 31_001, token: "droid-first-token", models: [SHARED_MODEL] },
  {
    id: 31_002,
    token: "droid-second-token",
    models: [SHARED_MODEL, SECOND_ONLY_MODEL],
  },
] as const

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalMultiToken = state.isMultiToken
const upstream: Array<{
  affinity: RoutingAffinity | undefined
  authorization: string | null
  model: unknown
}> = []

const fetchMock = mock((_url: string, init?: RequestInit) => {
  const body =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : {}
  upstream.push({
    affinity: getRoutingAffinity(),
    authorization: new Headers(init?.headers).get("authorization"),
    model: body.model,
  })
  return Response.json({
    id: "resp_droid",
    object: "response",
    model: body.model,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_droid",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })
})

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "test",
    vendor: "openai",
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "gpt",
      limits: {},
      object: "model_capabilities",
      supports: { streaming: true, tool_calls: true },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  state.isMultiToken = originalMultiToken
})

beforeEach(() => {
  upstream.length = 0
  fetchMock.mockClear()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = true
  state.models = {
    object: "list",
    data: [model(SHARED_MODEL), model(SECOND_ONLY_MODEL)],
  }
  for (const entry of ACCOUNTS) {
    const account = tokenPool.addAccount(
      `github-${entry.id}`,
      "individual",
      entry.id,
    )
    account.copilotToken = entry.token
    account.healthy = true
    account.models = new Set(entry.models)
    account.modelsData = entry.models.map((id) => model(id))
  }
  tokenPool.rebuildModelIndex()
})

afterEach(() => {
  for (const entry of ACCOUNTS) tokenPool.removeAccountForTest(entry.id)
})

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = { "user-agent": DROID_USER_AGENT },
): Promise<Response> {
  await seedProtocolDatabase()
  return await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model: SHARED_MODEL,
      input: "Reply OK.",
      store: false,
      ...body,
    }),
  })
}

function servedBy(index: number): number | undefined {
  const authorization = upstream.at(index)?.authorization
  return ACCOUNTS.find((entry) => authorization === `Bearer ${entry.token}`)?.id
}

test("routes each Droid session to one account by its prompt cache key", async () => {
  const sessions = Array.from(
    { length: 8 },
    (_, index) => `00000000-0000-4000-8000-00000000000${index}`,
  )
  const owners = new Map<string, number | undefined>()
  for (const session of sessions) {
    for (let turn = 0; turn < 3; turn++) {
      const response = await post({ prompt_cache_key: session })
      expect(response.status).toBe(200)
      expect(upstream.at(-1)?.affinity).toEqual({
        key: session,
        source: "droid_session",
      })
      const owner = servedBy(-1)
      expect(owner).toBeDefined()
      if (turn === 0) owners.set(session, owner)
      else expect(owner).toBe(owners.get(session))
    }
    const repository = createAccountDistributionRepository(
      getStorageRuntime().storage,
    )
    expect(await repository.lookup(session)).toBe(owners.get(session))
  }
  // Sessions are separate conversations, not one shared key.
  expect(new Set(owners.values()).size).toBe(ACCOUNTS.length)
})

test("moves a Droid session to an account that serves its new model", async () => {
  // Start a session on the first account, which lacks the second model.
  let session: string | undefined
  for (let index = 0; index < 16 && !session; index++) {
    const candidate = `11111111-1111-4111-8111-1111111111${10 + index}`
    expect((await post({ prompt_cache_key: candidate })).status).toBe(200)
    if (servedBy(-1) === ACCOUNTS[0].id) session = candidate
  }
  if (!session) throw new Error("Expected a session on the first account")

  // Only the second account serves this model, as with a model that only
  // some pooled accounts have.
  const switched = await post({
    model: SECOND_ONLY_MODEL,
    prompt_cache_key: session,
  })
  expect(switched.status).toBe(200)
  expect(servedBy(-1)).toBe(ACCOUNTS[1].id)
  expect(upstream.at(-1)?.model).toBe(SECOND_ONLY_MODEL)

  // Back on the shared model, the session stays where it now lives.
  expect((await post({ prompt_cache_key: session })).status).toBe(200)
  expect(servedBy(-1)).toBe(ACCOUNTS[1].id)
})

test("does not treat another client's prompt cache key as a session", async () => {
  const clients: Array<Record<string, string>> = [
    { "user-agent": "OpenAI/JS 6.0.0" },
    { "user-agent": "my-app factory-cli/1.0.0" },
    {},
  ]
  for (const headers of clients) {
    upstream.length = 0
    expect(
      (await post({ prompt_cache_key: "shared-cache-key" }, headers)).status,
    ).toBe(200)
    expect(upstream.at(-1)?.affinity).toBeUndefined()
  }
})

test("keeps explicit session identities ahead of Droid's prompt cache key", async () => {
  await post(
    { prompt_cache_key: "droid-cache-key" },
    {
      "user-agent": DROID_USER_AGENT,
      "x-client-session-id": "header-session",
    },
  )
  expect(upstream.at(-1)?.affinity).toEqual({
    key: "header-session",
    source: "copilot_session",
  })

  await post({
    prompt_cache_key: "droid-cache-key",
    client_metadata: { session_id: "metadata-session" },
  })
  expect(upstream.at(-1)?.affinity).toEqual({
    key: "metadata-session",
    source: "codex_metadata",
  })

  await post({ prompt_cache_key: " " })
  expect(upstream.at(-1)?.affinity).toBeUndefined()
})
