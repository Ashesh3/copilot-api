import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
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

type Transport = "json" | "sse" | "websocket"

const CLAUDE = "claude-usage-fixture"
const CHAT = "chat-usage-fixture"
// A custom model on native Responses has no hosted search.
const CUSTOM = "custom-responses-fixture"
const QUESTION = [{ type: "message", role: "user", content: "What changed?" }]
const TRANSPORTS: ReadonlyArray<Transport> = ["json", "sse", "websocket"]
// The gateway adds its own search to a turn without tools; a turn that offers
// only hosted search has the gateway run that search.
const TURNS: ReadonlyArray<[string, JsonRecord]> = [
  ["tool-less", {}],
  [
    "hosted-search-only",
    { tools: [{ type: "web_search", external_web_access: true }] },
  ],
]

beforeEach(async () => {
  await installWebUsageFixture([
    fixtureModel(CLAUDE, "/v1/messages", { vendor: "anthropic" }),
    fixtureModel(CHAT, "/chat/completions"),
    fixtureModel(CUSTOM, "/responses", {
      vendor: "openai",
      custom_model: true,
    }),
  ])
})

afterEach(restoreWebUsageFixture)

function terminalUsage(frames: Array<JsonRecord>): JsonRecord | undefined {
  expect(frames.filter((frame) => frame.type === "error")).toEqual([])
  const terminal = frames.find(
    (frame) =>
      frame.type === "response.completed"
      || frame.type === "response.incomplete",
  )
  return (terminal?.response as { usage?: JsonRecord } | undefined)?.usage
}

async function webSocketUsage(
  body: JsonRecord,
): Promise<JsonRecord | undefined> {
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected upgrade")
  const frames: Array<JsonRecord> = []
  await responsesWebSocket.message(
    {
      data,
      send(frame: string) {
        frames.push(JSON.parse(frame) as JsonRecord)
      },
      close() {},
    },
    JSON.stringify({ type: "response.create", ...body }),
  )
  return terminalUsage(frames)
}

/** The usage a Responses client such as Codex reads from the turn. */
async function clientUsage(
  transport: Transport,
  body: JsonRecord,
): Promise<JsonRecord | undefined> {
  if (transport === "websocket") return await webSocketUsage(body)
  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: transport === "sse" }),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  if (transport === "json")
    return (JSON.parse(text) as { usage?: JsonRecord }).usage
  return terminalUsage(
    text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as JsonRecord),
  )
}

describe("Codex with a Claude model, over the Messages bridge", () => {
  for (const [turn, tools] of TURNS)
    for (const transport of TRANSPORTS)
      test(`a ${turn} turn reports the last round's input, ${transport}`, async () => {
        const usage = await clientUsage(transport, {
          model: CLAUDE,
          input: QUESTION,
          ...tools,
        })

        expect(fixture.upstream).toHaveLength(2)
        expect(usage).toEqual({
          input_tokens: 104_000,
          input_tokens_details: { cached_tokens: 98_000 },
          output_tokens: 350,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 104_350,
        })
        expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
      })
})

describe("Codex with a Chat-only model, over the Chat adapter", () => {
  for (const [turn, tools] of TURNS)
    for (const transport of TRANSPORTS)
      test(`a ${turn} turn reports the last round's input, ${transport}`, async () => {
        const usage = await clientUsage(transport, {
          model: CHAT,
          input: QUESTION,
          ...tools,
        })

        expect(fixture.upstream).toHaveLength(2)
        expect(usage).toEqual({
          input_tokens: 104_000,
          input_tokens_details: { cached_tokens: 100_000 },
          output_tokens: 350,
          total_tokens: 104_350,
        })
        expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
      })
})

describe("Codex with a custom model, on native Responses without hosted search", () => {
  const lastRound = {
    input_tokens: 104_000,
    input_tokens_details: { cached_tokens: 100_000 },
    output_tokens: 350,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 104_350,
  }

  for (const transport of TRANSPORTS)
    test(`a tool-less turn reports the last round's input, ${transport}`, async () => {
      const usage = await clientUsage(transport, {
        model: CUSTOM,
        input: QUESTION,
      })

      expect(fixture.upstream).toHaveLength(2)
      expect(usage).toEqual(lastRound)
      expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
    })

  for (const transport of ["json", "sse"] as const)
    test(`an incomplete final round reports its own input, ${transport}`, async () => {
      fixture.finalStatus = "incomplete"
      const usage = await clientUsage(transport, {
        model: CUSTOM,
        input: QUESTION,
      })

      expect(fixture.upstream).toHaveLength(2)
      expect(usage).toEqual(lastRound)
      expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
    })
})

test("a Google client keeps the final round's usage, and every round is counted", async () => {
  const response = await server.request(
    `/v1beta/models/${CHAT}:generateContent`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "What changed?" }] }],
        tools: [{ googleSearch: {} }],
      }),
    },
  )
  const body = (await response.json()) as { usageMetadata?: JsonRecord }

  expect(response.status).toBe(200)
  expect(fixture.upstream).toHaveLength(2)
  expect(body.usageMetadata).toEqual({
    promptTokenCount: 104_000,
    candidatesTokenCount: 50,
    totalTokenCount: 104_050,
    cachedContentTokenCount: 100_000,
  })
  expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
})
