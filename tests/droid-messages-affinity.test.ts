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

import { resolveDroidMessagesRoutingAffinity } from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"
import { resetThinkingProvenanceForTest } from "~/services/copilot/thinking-provenance"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

// Droid's Claude workers use its "anthropic" provider, which sends no session
// identity. The fixture accepts a thinking signature only on the model and
// account that issued it, as Copilot does.
const MODEL = "claude-opus-5.5"
const ACCOUNT_IDS = [98_301, 98_302]
const DROID_USER_AGENT = "factory-cli/1.0.0"
const originalFetch = globalThis.fetch
const issuedBy = new Map<string, string>()
const upstream: Array<{ account: string | null; rejected: boolean }> = []
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

function signedStream(signature: string): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${signature}`,
        type: "message",
        role: "assistant",
        model: MODEL,
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
      delta: { type: "thinking_delta", thinking: "Reasoned." },
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
  const account = new Headers(init?.headers).get("authorization")
  const rejected = replayedSignatures(body).some(
    (signature) => issuedBy.get(signature) !== account,
  )
  upstream.push({ account, rejected })
  if (rejected) {
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
  const signature = `sig-${issued}`
  issuedBy.set(signature, account ?? "")
  return new Response(signedStream(signature), {
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
  upstream.length = 0
  issued = 0
  resetThinkingProvenanceForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.models = { object: "list", data: [modelEntry(MODEL)] }
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  for (const id of ACCOUNT_IDS) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = `token-${id}`
    account.healthy = true
    account.models = new Set([MODEL])
    account.modelsData = [modelEntry(MODEL)]
  }
  state.isMultiToken = true
  tokenPool.rebuildModelIndex()
  await seedProtocolDatabase()
})

afterEach(() => {
  for (const id of ACCOUNT_IDS) tokenPool.removeAccountForTest(id)
  state.isMultiToken = false
  resetThinkingProvenanceForTest()
})

const SYSTEM = [
  { type: "text", text: "You are Droid, an AI software engineering agent." },
  {
    type: "text",
    text: "Comments: add one only when needed.",
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
]

/** A first user turn: start-up reminders, then the session's first prompt. */
function firstTurn(prompt: string): Array<Record<string, unknown>> {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>Current date: 2026-10-30.</system-reminder>",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: prompt }] },
  ]
}

function signedThinking(signature: string): Record<string, unknown> {
  return { type: "thinking", thinking: "Reasoned.", signature }
}

async function turn(
  messages: Array<Record<string, unknown>>,
  userAgent: string,
): Promise<string> {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": userAgent,
      "x-api-key": PROTOCOL_GATEWAY_KEY,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 128_000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
      system: SYSTEM,
      messages,
    }),
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  const signature = /"signature":"(sig-\d+)"/u.exec(text)?.[1]
  if (!signature) throw new Error("Expected a signed thinking block")
  return signature
}

/** Three turns of one session; returns the accounts that answered them. */
async function session(
  prompt: string,
  userAgent = DROID_USER_AGENT,
): Promise<Array<string | null>> {
  const start = upstream.length
  const opening = firstTurn(prompt)
  const first = await turn(opening, userAgent)
  const afterTool = [
    ...opening,
    {
      role: "assistant",
      content: [
        signedThinking(first),
        { type: "tool_use", id: "toolu_ls", name: "LS", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_ls",
          content: "note.txt",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]
  const second = await turn(afterTool, userAgent)
  await turn(
    [
      ...afterTool,
      {
        role: "assistant",
        content: [signedThinking(second), { type: "text", text: "Done." }],
      },
      { role: "user", content: "Now run the tests." },
    ],
    userAgent,
  )
  return upstream.slice(start).map((call) => call.account)
}

test("keeps each Droid Claude session on one account, spread across the pool", async () => {
  const owners = new Map<string, string | null>()
  for (let index = 0; index < 6; index++) {
    const prompt = `Implement feature ${index} of the mission.`
    const accounts = await session(prompt)
    // Every turn, and every replayed signature, stays on the session's account.
    expect(new Set(accounts).size).toBe(1)
    owners.set(prompt, accounts[0])

    const key = resolveDroidMessagesRoutingAffinity(
      new Headers({ "user-agent": DROID_USER_AGENT }),
      { model: MODEL, system: SYSTEM, messages: firstTurn(prompt) },
    )?.key
    if (!key) throw new Error("Expected a Droid session identity")
    const owner = await createAccountDistributionRepository(
      getStorageRuntime().storage,
    ).lookup(key)
    expect(`Bearer token-${owner}`).toBe(accounts[0] ?? "")
  }
  expect(upstream.some((call) => call.rejected)).toBe(false)
  expect(new Set(owners.values())).toEqual(
    new Set(ACCOUNT_IDS.map((id) => `Bearer token-${id}`)),
  )
})

test("leaves other Messages clients without a session identity", async () => {
  for (let index = 0; index < 3; index++) {
    const accounts = await session(`Task ${index}.`, "claude-cli/2.0.0")
    expect(accounts).toEqual([
      `Bearer token-${ACCOUNT_IDS[0]}`,
      `Bearer token-${ACCOUNT_IDS[0]}`,
      `Bearer token-${ACCOUNT_IDS[0]}`,
    ])
  }
})
