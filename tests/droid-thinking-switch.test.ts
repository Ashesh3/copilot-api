import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"
import { resetThinkingProvenanceForTest } from "~/services/copilot/thinking-provenance"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

// Factory Droid keeps signed thinking when a session moves between Claude
// models, because both use its "anthropic" provider. The upstream fixture
// verifies a signature only on the model and account that issued it, as
// Copilot does when it keeps each caller on one provider deployment.
const originalFetch = globalThis.fetch
const issuedBy = new Map<string, string>()
const upstreamBodies: Array<Record<string, unknown>> = []
const upstreamAccounts: Array<string | null> = []
const FIRST_ACCOUNT_ID = 97_201
const POOLED_ACCOUNT_IDS = [FIRST_ACCOUNT_ID, 97_202]
let issued = 0

function modelEntry(id: string): ModelsResponse["data"][number] {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/v1/messages"],
    capabilities: {
      family: id,
      limits: { max_output_tokens: 128_000 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function signedStream(model: string, signature: string, text: string): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${signature}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: text },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ]
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
}

function replayedSignatures(body: Record<string, unknown>): Array<string> {
  const messages = body.messages as Array<{ role: string; content: unknown }>
  return messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content) ?
      (message.content as Array<Record<string, unknown>>).flatMap((block) =>
        block.type === "thinking" ? [String(block.signature)] : [],
      )
    : [],
  )
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  ) as Record<string, unknown>
  upstreamBodies.push(body)
  const model = String(body.model)
  const account = new Headers(init?.headers).get("authorization")
  upstreamAccounts.push(account)
  const issuer = JSON.stringify([model, account])
  if (replayedSignatures(body).some((sig) => issuedBy.get(sig) !== issuer)) {
    return Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    )
  }
  issued += 1
  const signature = `sig-${model}-${issued}`
  issuedBy.set(signature, issuer)
  return new Response(signedStream(model, signature, `${model} reasoned.`), {
    headers: { "content-type": "text/event-stream" },
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  issuedBy.clear()
  upstreamBodies.length = 0
  upstreamAccounts.length = 0
  issued = 0
  resetThinkingProvenanceForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [modelEntry("claude-opus-5.5"), modelEntry("claude-sonnet-5.5")],
  }
  await seedProtocolDatabase()
})

afterEach(() => {
  for (const id of POOLED_ACCOUNT_IDS) tokenPool.removeAccountForTest(id)
  tokenPool.rebuildModelIndex()
  state.isMultiToken = false
})

async function droidRequest(
  model: string,
  messages: Array<Record<string, unknown>>,
): Promise<Response> {
  return await server.request("/v1/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "factory-cli/1.0.0",
      "x-api-key": PROTOCOL_GATEWAY_KEY,
    },
    body: JSON.stringify({
      model,
      max_tokens: 128_000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
      messages,
    }),
  })
}

async function droidTurn(
  model: string,
  messages: Array<Record<string, unknown>>,
): Promise<string> {
  const response = await droidRequest(model, messages)
  expect(response.status).toBe(200)
  return await response.text()
}

function thinking(model: string, signature: string) {
  return {
    type: "thinking",
    thinking: `${model} reasoned.`,
    signature,
  }
}

test("keeps Claude-verifiable thinking when a Droid session switches models", async () => {
  const opusStream = await droidTurn("claude-opus-5.5", [
    { role: "user", content: "Plan the change." },
  ])
  expect(opusStream).toContain("sig-claude-opus-5.5-1")
  const opusTurn = {
    role: "assistant",
    content: [
      thinking("claude-opus-5.5", "sig-claude-opus-5.5-1"),
      { type: "text", text: "Plan ready." },
    ],
  }
  const readableOpus = {
    type: "text",
    text: "<thinking>\nclaude-opus-5.5 reasoned.\n</thinking>",
  }

  // The first Sonnet turn is rejected once, then replays Opus's thinking as text.
  const sonnetStream = await droidTurn("claude-sonnet-5.5", [
    { role: "user", content: "Plan the change." },
    opusTurn,
    { role: "user", content: "Now implement it." },
  ])
  expect(sonnetStream).toContain("sig-claude-sonnet-5.5-2")
  expect(upstreamBodies).toHaveLength(3)
  expect(upstreamBodies[2]).toHaveProperty("messages.1.content", [
    readableOpus,
    { type: "text", text: "Plan ready." },
  ])

  // Later turns rewrite Opus's thinking up front and keep Sonnet's signed.
  await droidTurn("claude-sonnet-5.5", [
    { role: "user", content: "Plan the change." },
    opusTurn,
    { role: "user", content: "Now implement it." },
    {
      role: "assistant",
      content: [
        thinking("claude-sonnet-5.5", "sig-claude-sonnet-5.5-2"),
        { type: "tool_use", id: "toolu_read", name: "Read", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_read", content: "done" },
      ],
    },
  ])
  expect(upstreamBodies).toHaveLength(4)
  expect(upstreamBodies[3]).toHaveProperty("messages.1.content.0", readableOpus)
  expect(upstreamBodies[3]).toHaveProperty(
    "messages.3.content.0",
    thinking("claude-sonnet-5.5", "sig-claude-sonnet-5.5-2"),
  )
})

async function installPooledAccounts(): Promise<void> {
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  for (const id of POOLED_ACCOUNT_IDS) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = `token-${id}`
    account.healthy = true
    account.models = new Set(["claude-sonnet-5.5"])
    account.modelsData = [modelEntry("claude-sonnet-5.5")]
  }
  state.isMultiToken = true
  tokenPool.rebuildModelIndex()
  await seedProtocolDatabase()
}

test("keeps the answering account's thinking when a compacted Droid session moves accounts", async () => {
  await installPooledAccounts()
  const plan = { role: "user", content: "Plan the change." }

  await droidTurn("claude-sonnet-5.5", [plan])
  const [firstAccount] = upstreamAccounts
  const firstId = POOLED_ACCOUNT_IDS.find(
    (id) => firstAccount === `Bearer token-${id}`,
  )
  const otherId = POOLED_ACCOUNT_IDS.find((id) => id !== firstId)
  if (firstId === undefined || otherId === undefined)
    throw new Error("Expected the session on a pooled account")
  const otherAccount = `Bearer token-${otherId}`
  const firstTurn = {
    role: "assistant",
    content: [thinking("claude-sonnet-5.5", "sig-claude-sonnet-5.5-1")],
  }
  const readableFirst = {
    type: "text",
    text: "<thinking>\nclaude-sonnet-5.5 reasoned.\n</thinking>",
  }
  const implement = { role: "user", content: "Now implement it." }
  // The session's pinned prefix keeps it on its account. When that account
  // leaves the pool, the session reports it instead of moving.
  tokenPool.deleteAccount(firstId)
  await seedProtocolDatabase()
  const stuck = await droidRequest("claude-sonnet-5.5", [
    plan,
    firstTurn,
    implement,
  ])
  expect(stuck.status).toBe(409)
  expect(await stuck.json()).toMatchObject({
    error: { code: "conversation_account_unavailable" },
  })

  // Compaction replaces the first turn with a summary: a new identity, which
  // the pool places on the remaining account.
  const summary = { role: "user", content: "Summary: the plan is ready." }
  await droidTurn("claude-sonnet-5.5", [summary, firstTurn, implement])
  await droidTurn("claude-sonnet-5.5", [
    summary,
    firstTurn,
    implement,
    {
      role: "assistant",
      content: [
        thinking("claude-sonnet-5.5", "sig-claude-sonnet-5.5-2"),
        { type: "tool_use", id: "toolu_read", name: "Read", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_read", content: "done" },
      ],
    },
  ])

  expect(upstreamAccounts).toEqual([
    firstAccount,
    otherAccount,
    otherAccount,
    otherAccount,
    otherAccount,
  ])
  expect(upstreamBodies[2]).toHaveProperty("messages.1.content", [
    readableFirst,
  ])
  expect(upstreamBodies[4]).toHaveProperty("messages.1.content", [
    readableFirst,
  ])
  expect(upstreamBodies[4]).toHaveProperty(
    "messages.3.content.0",
    thinking("claude-sonnet-5.5", "sig-claude-sonnet-5.5-2"),
  )
})
