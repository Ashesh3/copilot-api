import { expect, test } from "bun:test"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { ResponseInputItem } from "~/services/copilot/create-responses"
import type { ManagedWebRound } from "~/services/web/tool-loop"

import {
  adaptResponsesToMessagesCandidate,
  anthropicResponseToResponsesResult,
} from "~/routes/responses/messages-bridge"
import {
  prepareManagedWebTools,
  runWithWebTools,
} from "~/services/web/tool-context"

import { mergeTurns } from "./helpers/messages-turns"

const MODEL = "claude-opus-4.7"
const SEARCH = "_copilot_web_search"
const USER = { type: "message", role: "user", content: "Compare A and B." }
const NEXT = { type: "message", role: "user", content: "Thanks" }
const SEARCH_A = {
  type: "tool_use",
  id: "toolu_a",
  name: SEARCH,
  input: { query: "release a" },
}
const SEARCH_B = {
  type: "tool_use",
  id: "toolu_b",
  name: SEARCH,
  input: { query: "release b", url: "https://b.example/" },
}
// Text between parallel calls keeps its place in the assistant turn.
const ROUND_CONTENT = [
  { type: "thinking", thinking: "Search both.", signature: "sig-round" },
  { type: "text", text: "Checking A." },
  SEARCH_A,
  { type: "text", text: "And B." },
  SEARCH_B,
]
const ROUND: ManagedWebRound = {
  response: { id: "msg_round", content: ROUND_CONTENT },
  completed: [
    {
      call: { id: "toolu_a", name: SEARCH, input: SEARCH_A.input },
      result: { text: "A notes", isError: false },
    },
    {
      call: { id: "toolu_b", name: SEARCH, input: SEARCH_B.input },
      result: { text: "Web search failed: blocked", isError: true },
    },
  ],
}
const FINAL: AnthropicResponse = {
  id: "msg_final",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "A is newer." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 },
}

function bridgedOutput(): Array<ResponseInputItem> {
  return anthropicResponseToResponsesResult(
    FINAL,
    MODEL,
    { model: MODEL, input: [] },
    { managedRounds: [ROUND] },
  ).output as Array<ResponseInputItem>
}

test("parallel managed searches replay in their original order", async () => {
  const output = bridgedOutput()
  expect(output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "web_search_call",
    "message",
    "web_search_call",
    "message",
  ])
  expect(output[4]).toMatchObject({
    id: "ws_toolu_b",
    action: { type: "open_page", url: "https://b.example/" },
  })

  const candidate = await adaptResponsesToMessagesCandidate({
    source: { model: MODEL, input: [USER, ...output, NEXT] },
  })

  expect(mergeTurns(candidate.payload.messages)).toEqual([
    { role: "user", content: [{ type: "text", text: USER.content }] },
    { role: "assistant", content: ROUND_CONTENT },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "A notes" },
        {
          type: "tool_result",
          tool_use_id: "toolu_b",
          content: "Web search failed: blocked",
          is_error: true,
        },
      ],
    },
    { role: "assistant", content: FINAL.content },
    { role: "user", content: [{ type: "text", text: NEXT.content }] },
  ])
})

test("an unfinished round still answers its call before the next user turn", async () => {
  const first = bridgedOutput().find((item) => item.type === "web_search_call")
  if (!first) throw new Error("Expected a web search call")

  const candidate = await adaptResponsesToMessagesCandidate({
    source: { model: MODEL, input: [USER, first, NEXT] },
  })

  expect(mergeTurns(candidate.payload.messages)).toEqual([
    { role: "user", content: [{ type: "text", text: USER.content }] },
    { role: "assistant", content: [SEARCH_A] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "A notes" },
        { type: "text", text: NEXT.content },
      ],
    },
  ])
})

test("a tool-less turn declares the replayed search tool for the gateway", async () => {
  const source = { model: MODEL, input: [USER, ...bridgedOutput(), NEXT] }

  await runWithWebTools(source, async () => {
    const candidate = await adaptResponsesToMessagesCandidate({ source })
    expect(candidate.payload.tools?.map((tool) => tool.name)).toEqual([SEARCH])
    const prepared = prepareManagedWebTools(candidate.payload, "messages")
    expect([...prepared.managed.keys()]).toEqual([SEARCH])
    expect(prepared.payload.tools).toHaveLength(1)
  })

  const withTools = await adaptResponsesToMessagesCandidate({
    source: {
      ...source,
      tools: [{ type: "function", name: "exec", parameters: {} }],
    },
  })
  expect(withTools.payload.tools?.map((tool) => tool.name)).toEqual(["exec"])
})

test("hosted web_search in a bridged candidate is answered by the gateway", async () => {
  const source = {
    model: MODEL,
    input: [USER],
    tools: [{ type: "web_search" }],
  }

  await runWithWebTools(source, async () => {
    const candidate = await adaptResponsesToMessagesCandidate({ source })
    const prepared = prepareManagedWebTools(candidate.payload, "messages")
    expect([...prepared.managed.keys()]).toEqual(["web_search"])
  })
})

// The replay state is read back only up to 4 MiB.
const REPLAY_LIMIT = 4 * 1024 * 1024
const TRUNCATION_NOTE =
  /\n\n\[Result truncated by the gateway: showing the first (\d+) of (\d+) characters\.\]$/

test.each([
  ["an ASCII", "x"],
  ["a multibyte", "\u{1F600}"],
])(
  "%s result over the replay limit still replays, shortened",
  async (_kind, unit) => {
    const text = unit.repeat(Math.ceil(3_500_000 / unit.length))
    const round: ManagedWebRound = {
      response: { id: "msg_large", content: [SEARCH_A] },
      completed: [
        {
          call: { id: "toolu_a", name: SEARCH, input: SEARCH_A.input },
          result: { text, isError: false },
        },
      ],
    }
    const output = anthropicResponseToResponsesResult(
      FINAL,
      MODEL,
      { model: MODEL, input: [] },
      { managedRounds: [round] },
    ).output as Array<ResponseInputItem>
    const call = output.find((item) => item.type === "web_search_call")
    expect(
      String((call as { encrypted_content?: unknown }).encrypted_content)
        .length,
    ).toBeLessThanOrEqual(REPLAY_LIMIT)

    const candidate = await adaptResponsesToMessagesCandidate({
      source: { model: MODEL, input: [USER, ...output, NEXT] },
    })

    const turns = mergeTurns(candidate.payload.messages)
    expect(turns[1]).toEqual({ role: "assistant", content: [SEARCH_A] })
    const [result] = turns[2].content as Array<Record<string, unknown>>
    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_a",
    })
    const content = String(result.content)
    const note = TRUNCATION_NOTE.exec(content)
    expect(note?.[2]).toBe(String(text.length))
    const kept = content.slice(0, note?.index)
    expect(kept.length).toBe(Number(note?.[1]))
    expect(text.startsWith(kept)).toBe(true)
    // Whole characters only, and most of what the limit allows.
    expect(kept.length % unit.length).toBe(0)
    expect(kept.length).toBeGreaterThan(text.length / 4)
  },
)
