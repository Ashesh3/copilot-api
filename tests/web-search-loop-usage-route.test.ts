import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  useProtocolDatabase,
} from "./helpers/protocol-database"
import {
  ALL_ROUNDS,
  fixture,
  fixtureModel,
  installWebUsageFixture,
  type JsonRecord,
  recordedTotals,
  restoreWebUsageFixture,
} from "./helpers/web-usage-fixture"

useProtocolDatabase()

// The older gateway search loops run the MCP search for a client's hosted
// search tool, outside the managed loop. The client sees the final round,
// whose input already holds the conversation; accounting counts every round.

const CLAUDE = "claude-loop-fixture"
const CHAT = "chat-loop-fixture"
// Not an OpenAI model, so it has no hosted search on Responses.
const RESPONSES = "responses-loop-fixture"
const QUESTION = "What changed?"

interface ClientRequest {
  path: string
  body: JsonRecord
}

const messagesRequest =
  (model: string) =>
  (stream: boolean): ClientRequest => ({
    path: "/v1/messages",
    body: {
      model,
      max_tokens: 512,
      stream,
      messages: [{ role: "user", content: QUESTION }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    },
  })

const chatRequest =
  (model: string) =>
  (stream: boolean): ClientRequest => ({
    path: "/v1/chat/completions",
    body: {
      model,
      stream,
      messages: [{ role: "user", content: QUESTION }],
      tools: [{ type: "web_search" }],
    },
  })

interface LoopCase {
  loop: string
  client: string
  request: (stream: boolean) => ClientRequest
  /** The final round's own usage, as the client reads it whole. */
  finalRound: JsonRecord
}

const CASES: ReadonlyArray<LoopCase> = [
  {
    loop: "resolveNativeWebSearch",
    client: "Claude Code on a Claude model",
    request: messagesRequest(CLAUDE),
    finalRound: {
      input_tokens: 1_000,
      cache_read_input_tokens: 98_000,
      cache_creation_input_tokens: 5_000,
      output_tokens: 50,
    },
  },
  {
    loop: "resolveNativeWebSearch",
    client: "a Chat client on a Claude model",
    request: chatRequest(CLAUDE),
    finalRound: {
      prompt_tokens: 104_000,
      prompt_tokens_details: { cached_tokens: 98_000 },
      completion_tokens: 50,
      total_tokens: 104_050,
    },
  },
]

beforeEach(async () => {
  await installWebUsageFixture([
    fixtureModel(CLAUDE, "/v1/messages", { vendor: "anthropic" }),
    fixtureModel(CHAT, "/chat/completions"),
    fixtureModel(RESPONSES, "/responses"),
  ])
})

afterEach(restoreWebUsageFixture)

async function send(request: ClientRequest): Promise<string> {
  const response = await server.request(request.path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request.body),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  return text
}

for (const { loop, client, request, finalRound } of CASES)
  describe(`${loop}: ${client}`, () => {
    test("whole: the client keeps the final round, every round is counted", async () => {
      const body = JSON.parse(await send(request(false))) as JsonRecord

      expect(fixture.upstream).toHaveLength(2)
      expect(body.usage ?? body.usageMetadata).toEqual(finalRound)
      expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
    })

    test("streamed: every round is counted", async () => {
      await send(request(true))

      expect(fixture.upstream).toHaveLength(2)
      expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
    })
  })
