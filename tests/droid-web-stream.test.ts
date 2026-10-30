/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import { describe, expect, test } from "bun:test"

import type { WebEvent, WebResponse } from "~/services/web/tool-loop"

import {
  decodeDroidWebCarrier,
  DROID_WEB_CARRIER_LABEL,
  expandDroidMessagesCarriers,
  expandDroidResponsesCarriers,
} from "~/services/web/droid-web-protocol"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

type JsonRecord = Record<string, unknown>

const webSearch = {
  type: "function",
  name: "WebSearch",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, numResults: { type: "integer" } },
    required: ["query"],
  },
}
const ls = {
  type: "function",
  name: "LS",
  parameters: { type: "object", properties: {} },
}
const anthropicTools = [
  { name: "WebSearch", input_schema: webSearch.parameters },
  { name: "LS", input_schema: ls.parameters },
]
const RESULT = 'Web Search Results for: "bun 1.4"\n\nSee https://bun.sh/blog'
const NARRATION = 'Searching the web (copilot-api): "bun 1.4" → sources: bun.sh'

async function* events(values: Array<JsonRecord>): AsyncGenerator<WebEvent> {
  for (const value of values)
    yield { event: String(value.type), data: JSON.stringify(value) }
}

async function collect(result: WebResponse): Promise<Array<JsonRecord>> {
  if (!isWebStream(result)) throw new Error("Expected a stream")
  const output: Array<JsonRecord> = []
  for await (const event of result)
    if (event.data && event.data !== "[DONE]")
      output.push(JSON.parse(event.data) as JsonRecord)
  return output
}

const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "enc_1",
}
const searchCall = {
  type: "function_call",
  id: "fc_1",
  status: "completed",
  call_id: "call_ws",
  name: "WebSearch",
  arguments: '{"query":"bun 1.4"}',
}
const lsCall = {
  type: "function_call",
  id: "fc_2",
  status: "completed",
  call_id: "call_ls",
  name: "LS",
  arguments: "{}",
}
const answer = {
  type: "message",
  id: "msg_2",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: "Bun 1.4 shipped.", annotations: [] }],
}

function responsesRound(
  id: string,
  output: Array<JsonRecord>,
): Array<JsonRecord> {
  const values: Array<JsonRecord> = [
    { type: "response.created", response: { id, status: "in_progress" } },
  ]
  for (const [index, item] of output.entries()) {
    values.push({
      type: "response.output_item.added",
      output_index: index,
      item,
    })
    if (item.type === "message")
      values.push({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: "Bun 1.4 shipped.",
      })
    values.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    })
  }
  values.push({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    },
  })
  return values.map((value, index) => ({ ...value, sequence_number: index }))
}

function droid<T>(
  payload: JsonRecord,
  protocol: "messages" | "responses",
  work: () => T,
): T {
  return runWithWebTools(payload, work, { droid: true, protocol })
}

describe("Droid carrier mode on streamed Responses", () => {
  test("runs WebSearch with visible narration and a replayable carrier", async () => {
    const payload = {
      model: "gpt-fixture",
      input: [{ role: "user", content: "Find bun 1.4" }],
      tools: [webSearch, ls],
      stream: true,
    }
    const sent: Array<JsonRecord> = []
    const output = await droid(payload, "responses", async () =>
      collect(
        await runManagedWebRequest({
          protocol: "responses",
          nativeResponses: true,
          payload,
          send: async (body) => {
            sent.push(body)
            return events(
              sent.length === 1 ?
                responsesRound("resp_1", [reasoningItem, searchCall])
              : responsesRound("resp_2", [answer]),
            )
          },
          execute: async () => ({ text: RESULT, isError: false }),
        }),
      ),
    )

    expect(JSON.stringify(output)).not.toContain('"name":"WebSearch"')
    expect(output.filter((e) => e.type === "response.created")).toHaveLength(1)
    const done = output.filter((e) => e.type === "response.output_item.done")
    expect(
      done.map((e) => [e.output_index, (e.item as JsonRecord).type]),
    ).toEqual([
      [0, "reasoning"],
      [1, "message"],
      [2, "reasoning"],
      [3, "message"],
    ])
    const narration = done[1].item as JsonRecord
    expect(narration.content).toEqual([
      { type: "output_text", text: NARRATION, annotations: [] },
    ])
    expect(
      output
        .filter(
          (e) =>
            e.type === "response.output_text.delta" && e.output_index === 1,
        )
        .map((e) => e.delta)
        .join(""),
    ).toBe(NARRATION)
    const carrier = done[2].item as JsonRecord
    expect(carrier.summary).toEqual([])
    expect(decodeDroidWebCarrier(carrier.encrypted_content)).toEqual({
      calls: [
        { id: "call_ws", name: "WebSearch", input: '{"query":"bun 1.4"}' },
      ],
      results: [{ id: "call_ws", text: RESULT, isError: false }],
      narration: NARRATION,
    })
    const sequence = output.map((e) => Number(e.sequence_number))
    expect(sequence).toEqual(sequence.map((_, index) => index))
    const completed = output.at(-1) as { type: string; response: JsonRecord }
    expect(completed.type).toBe("response.completed")
    expect(
      (completed.response.output as Array<JsonRecord>).map((item) => item.id),
    ).toEqual(["rs_1", narration.id, carrier.id, "msg_2"])
    // Droid's context is the last round's prompt; output covers both rounds.
    expect(completed.response.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 8,
    })

    // The model saw its own call and the result in the continuation...
    const continued = sent[1].input as Array<JsonRecord>
    expect(continued.slice(1)).toEqual([
      reasoningItem,
      searchCall,
      { type: "function_call_output", call_id: "call_ws", output: RESULT },
    ])
    // ...and gets the same history back when Droid replays the turn.
    const replay = [
      payload.input[0],
      ...(completed.response.output as Array<JsonRecord>),
      { role: "user", content: "Thanks" },
    ]
    const { id: _id, status: _status, ...call } = searchCall
    expect(expandDroidResponsesCarriers(replay)).toEqual([
      payload.input[0],
      reasoningItem,
      call,
      { type: "function_call_output", call_id: "call_ws", output: RESULT },
      answer,
      { role: "user", content: "Thanks" },
    ])
  })

  test("hands a mixed round's client call to Droid after running WebSearch", async () => {
    const payload = {
      model: "gpt-fixture",
      input: "Find bun 1.4 and list files",
      tools: [webSearch, ls],
    }
    let sends = 0
    const output = await droid(payload, "responses", async () =>
      collect(
        await runManagedWebRequest({
          protocol: "responses",
          nativeResponses: true,
          payload,
          send: async () => {
            sends++
            return events(
              responsesRound("resp_1", [reasoningItem, searchCall, lsCall]),
            )
          },
          execute: async () => ({ text: RESULT, isError: false }),
        }),
      ),
    )
    expect(sends).toBe(1)
    const completed = output.at(-1) as { response: JsonRecord }
    const items = completed.response.output as Array<JsonRecord>
    expect(items.map((item) => item.type)).toEqual([
      "reasoning",
      "function_call",
      "message",
      "reasoning",
    ])
    expect(items[1]).toEqual(lsCall)
    // Droid stores client calls last, then replays them with their outputs.
    const replay = [
      items[0],
      items[2],
      items[3],
      {
        type: "function_call",
        call_id: "call_ls",
        name: "LS",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_ls", output: "a.txt" },
    ]
    expect(expandDroidResponsesCarriers(replay)).toEqual([
      reasoningItem,
      {
        type: "function_call",
        call_id: "call_ws",
        name: "WebSearch",
        arguments: '{"query":"bun 1.4"}',
      },
      replay[3],
      { type: "function_call_output", call_id: "call_ws", output: RESULT },
      replay[4],
    ])
  })

  test("returns whole responses with the same narration and carrier", async () => {
    const payload = { model: "gpt-fixture", input: "Find", tools: [webSearch] }
    let sends = 0
    const result = (await droid(payload, "responses", async () =>
      runManagedWebRequest({
        protocol: "responses",
        nativeResponses: true,
        payload,
        send: async () => {
          sends++
          return {
            id: `resp_${sends}`,
            status: "completed",
            output: sends === 1 ? [reasoningItem, searchCall] : [answer],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          }
        },
        execute: async () => ({ text: RESULT, isError: false }),
      }),
    )) as JsonRecord
    const items = result.output as Array<JsonRecord>
    expect(items.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "reasoning",
      "message",
    ])
    expect(decodeDroidWebCarrier(items[2].encrypted_content)?.narration).toBe(
      NARRATION,
    )
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 8 })
  })
})

function messagesRound(
  blocks: Array<JsonRecord>,
  stop: string,
): Array<JsonRecord> {
  const values: Array<JsonRecord> = [
    {
      type: "message_start",
      message: {
        id: "msg_up",
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ]
  for (const [index, block] of blocks.entries()) {
    if (block.type === "tool_use") {
      values.push(
        {
          type: "content_block_start",
          index,
          content_block: { ...block, input: {} },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      )
    } else if (block.type === "thinking") {
      values.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        },
      )
    } else
      values.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      )
    values.push({ type: "content_block_stop", index })
  }
  values.push(
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  )
  return values
}

const signedThinking = {
  type: "thinking",
  thinking: "Plan.",
  signature: "sig_1",
}
const searchUse = {
  type: "tool_use",
  id: "toolu_ws",
  name: "WebSearch",
  input: { query: "bun 1.4" },
}
const lsUse = { type: "tool_use", id: "toolu_ls", name: "LS", input: {} }

function blocksOf(output: Array<JsonRecord>): Map<number, JsonRecord> {
  const blocks = new Map<number, JsonRecord>()
  for (const event of output) {
    const index = Number(event.index)
    if (event.type === "content_block_start")
      blocks.set(index, structuredClone(event.content_block as JsonRecord))
    const delta = event.delta as JsonRecord | undefined
    const block = blocks.get(index)
    if (event.type !== "content_block_delta" || !delta || !block) continue
    for (const field of ["text", "thinking", "signature"]) {
      const piece = delta[field]
      const previous = block[field]
      if (typeof piece === "string")
        block[field] = (typeof previous === "string" ? previous : "") + piece
    }
  }
  return blocks
}

describe("Droid carrier mode on streamed Messages", () => {
  test("runs WebSearch with a narration block and a labelled carrier", async () => {
    const payload = {
      model: "claude-fixture",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Find bun 1.4" }],
      tools: anthropicTools,
      stream: true,
    }
    const sent: Array<JsonRecord> = []
    const output = await droid(payload, "messages", async () =>
      collect(
        await runManagedWebRequest({
          protocol: "messages",
          payload,
          send: async (body) => {
            sent.push(body)
            return events(
              sent.length === 1 ?
                messagesRound([signedThinking, searchUse], "tool_use")
              : messagesRound(
                  [{ type: "text", text: "Bun 1.4 shipped." }],
                  "end_turn",
                ),
            )
          },
          execute: async () => ({ text: RESULT, isError: false }),
        }),
      ),
    )
    expect(output.filter((e) => e.type === "message_start")).toHaveLength(1)
    expect(output.filter((e) => e.type === "message_stop")).toHaveLength(1)
    const blocks = blocksOf(output)
    expect([...blocks.keys()]).toEqual([0, 1, 2, 3])
    expect(blocks.get(0)).toEqual(signedThinking)
    expect(blocks.get(1)).toEqual({ type: "text", text: NARRATION })
    const carrier = blocks.get(2) as JsonRecord
    expect(carrier.thinking).toBe(DROID_WEB_CARRIER_LABEL)
    expect(decodeDroidWebCarrier(carrier.signature)).toEqual({
      calls: [
        { id: "toolu_ws", name: "WebSearch", input: { query: "bun 1.4" } },
      ],
      results: [{ id: "toolu_ws", text: RESULT, isError: false }],
      narration: NARRATION,
    })
    expect(blocks.get(3)).toEqual({ type: "text", text: "Bun 1.4 shipped." })
    const delta = output.find((e) => e.type === "message_delta") as JsonRecord
    expect(delta.delta).toMatchObject({ stop_reason: "end_turn" })
    expect(delta.usage).toMatchObject({ input_tokens: 10, output_tokens: 8 })

    const turn = [
      { role: "assistant", content: [signedThinking, searchUse] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ws", content: RESULT },
        ],
      },
    ]
    expect((sent[1].messages as Array<unknown>).slice(1)).toEqual(turn)
    // Droid's replay of the streamed blocks expands to the same turns.
    expect(
      expandDroidMessagesCarriers([
        payload.messages[0],
        { role: "assistant", content: [...blocks.values()] },
        { role: "user", content: "Thanks" },
      ]),
    ).toEqual([
      payload.messages[0],
      ...turn,
      {
        role: "assistant",
        content: [{ type: "text", text: "Bun 1.4 shipped." }],
      },
      { role: "user", content: "Thanks" },
    ])
  })

  test("lets a continuation round call Droid's own tools", async () => {
    const payload = {
      model: "claude-fixture",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Find and list" }],
      tools: anthropicTools,
      stream: true,
    }
    let sends = 0
    const output = await droid(payload, "messages", async () =>
      collect(
        await runManagedWebRequest({
          protocol: "messages",
          payload,
          send: async () => {
            sends++
            return events(
              sends === 1 ?
                messagesRound([searchUse], "tool_use")
              : messagesRound(
                  [{ type: "text", text: "Listing." }, lsUse],
                  "tool_use",
                ),
            )
          },
          execute: async () => ({ text: RESULT, isError: false }),
        }),
      ),
    )
    const blocks = blocksOf(output)
    expect([...blocks.values()].map((block) => block.type)).toEqual([
      "text",
      "thinking",
      "text",
      "tool_use",
    ])
    expect(blocks.get(3)).toMatchObject({ id: "toolu_ls", name: "LS" })
    const delta = output.find((e) => e.type === "message_delta") as JsonRecord
    expect(delta.delta).toMatchObject({ stop_reason: "tool_use" })
  })

  test("never runs a call cut off by max_tokens", async () => {
    const payload = {
      model: "claude-fixture",
      max_tokens: 16,
      messages: [{ role: "user", content: "Find" }],
      tools: anthropicTools,
      stream: true,
    }
    let executed = 0
    const output = await droid(payload, "messages", async () =>
      collect(
        await runManagedWebRequest({
          protocol: "messages",
          payload,
          send: async () =>
            events(messagesRound([signedThinking, searchUse], "max_tokens")),
          execute: async () => {
            executed++
            return { text: RESULT, isError: false }
          },
        }),
      ),
    )
    expect(executed).toBe(0)
    expect([...blocksOf(output).values()]).toEqual([signedThinking])
    const delta = output.find((e) => e.type === "message_delta") as JsonRecord
    expect(delta.delta).toMatchObject({ stop_reason: "max_tokens" })
  })
})

describe("Droid's tool-less calls", () => {
  const gatewaySearch = {
    type: "tool_use",
    id: "toolu_gw",
    name: "_copilot_web_search",
    input: { query: "bun 1.4" },
  }

  test("still run the usual gateway search when streamed", async () => {
    const payload = {
      model: "claude-fixture",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Name this chat" }],
      stream: true,
    }
    let sends = 0
    let executed = 0
    const output = await droid(payload, "messages", async () =>
      collect(
        await runManagedWebRequest({
          protocol: "messages",
          payload,
          send: async () => {
            sends++
            return events(
              sends === 1 ?
                messagesRound([gatewaySearch], "tool_use")
              : messagesRound([{ type: "text", text: "Bun 1.4" }], "end_turn"),
            )
          },
          execute: async () => {
            executed++
            return { text: RESULT, isError: false }
          },
        }),
      ),
    )
    expect([sends, executed]).toEqual([2, 1])
    expect([...blocksOf(output).values()]).toEqual([
      { type: "text", text: "Bun 1.4" },
    ])
  })

  test("still run the usual gateway search when buffered", async () => {
    const payload = { model: "gpt-fixture", input: "Name this chat" }
    let sends = 0
    const result = (await droid(payload, "responses", async () =>
      runManagedWebRequest({
        protocol: "responses",
        nativeResponses: true,
        payload,
        send: async () => {
          sends++
          return {
            id: `resp_${sends}`,
            status: "completed",
            output:
              sends === 1 ?
                [
                  {
                    type: "function_call",
                    call_id: "call_gw",
                    name: "_copilot_web_search",
                    arguments: '{"query":"bun 1.4"}',
                  },
                ]
              : [answer],
          }
        },
        execute: async () => ({ text: RESULT, isError: false }),
      }),
    )) as JsonRecord
    expect(sends).toBe(2)
    expect(result.output).toEqual([answer])
  })
})
