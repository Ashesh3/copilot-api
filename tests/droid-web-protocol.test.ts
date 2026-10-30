import { describe, expect, test } from "bun:test"

import {
  decodeDroidWebCarrier,
  DROID_WEB_CARRIER_LABEL,
  DROID_WEB_CARRIER_PREFIX,
  droidWebToolKind,
  encodeDroidWebCarrier,
  expandDroidMessagesCarriers,
  expandDroidResponsesCarriers,
  type DroidWebCarrier,
} from "~/services/web/droid-web-protocol"

// Droid 1.0 declarations, as captured from droid.exe on the wire.
const webSearch = {
  type: "function",
  name: "WebSearch",
  description: "Performs a web search.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      numResults: { type: "integer" },
      text: { type: "boolean" },
    },
    required: ["query"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  },
  strict: false,
}
const fetchUrl = {
  type: "function",
  name: "FetchUrl",
  description: "Fetch an HTTP(S) URL and return Markdown.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", format: "uri" } },
    required: ["url"],
    additionalProperties: false,
  },
  strict: false,
}

const NARRATION = 'Searching the web (copilot-api): "bun 1.4" → sources: bun.sh'
const responsesCarrier: DroidWebCarrier = {
  calls: [{ id: "call_ws", name: "WebSearch", input: '{"query":"bun 1.4"}' }],
  results: [{ id: "call_ws", text: "Web Search Results", isError: false }],
  narration: NARRATION,
}
const messagesCarrier: DroidWebCarrier = {
  calls: [{ id: "toolu_ws", name: "WebSearch", input: { query: "bun 1.4" } }],
  results: [{ id: "toolu_ws", text: "Web Search Results", isError: false }],
  narration: NARRATION,
}
const reasoning = (id: string, encrypted: string) => ({
  type: "reasoning",
  id,
  summary: [],
  encrypted_content: encrypted,
})
const assistantText = (id: string, text: string) => ({
  type: "message",
  id,
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
})
const thinking = (text: string, signature: string) => ({
  type: "thinking",
  thinking: text,
  signature,
})

describe("Droid web tool detection", () => {
  test("recognizes Droid's WebSearch and FetchUrl on both wires", () => {
    expect(droidWebToolKind(webSearch)).toBe("search")
    expect(droidWebToolKind(fetchUrl)).toBe("fetch")
    expect(
      droidWebToolKind({
        name: "WebSearch",
        input_schema: webSearch.parameters,
      }),
    ).toBe("search")
    expect(
      droidWebToolKind({ name: "FetchUrl", input_schema: fetchUrl.parameters }),
    ).toBe("fetch")
    expect(
      droidWebToolKind({
        type: "function",
        name: "WebSearch",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string" },
            searchQueries: { type: "array" },
          },
          required: ["objective", "searchQueries"],
        },
      }),
    ).toBe("search")
  })

  test("leaves other clients' tools of the same names alone", () => {
    // Claude Code's tools differ in schema; they stay client-owned.
    expect(
      droidWebToolKind({
        name: "WebSearch",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            allowed_domains: { type: "array" },
          },
          required: ["query"],
        },
      }),
    ).toBeUndefined()
    expect(
      droidWebToolKind({
        name: "FetchUrl",
        input_schema: {
          type: "object",
          properties: { url: { type: "string" }, prompt: { type: "string" } },
          required: ["url", "prompt"],
        },
      }),
    ).toBeUndefined()
    expect(droidWebToolKind({ ...webSearch, name: "web_search" })).toBe(
      undefined,
    )
    expect(droidWebToolKind({ type: "web_search" })).toBeUndefined()
  })
})

describe("Droid web carriers", () => {
  test("round-trip and reject anything the gateway did not issue", () => {
    const encoded = encodeDroidWebCarrier(responsesCarrier)
    expect(encoded.startsWith(DROID_WEB_CARRIER_PREFIX)).toBe(true)
    expect(decodeDroidWebCarrier(encoded)).toEqual(responsesCarrier)
    expect(decodeDroidWebCarrier("enc_real_reasoning")).toBeUndefined()
    expect(
      decodeDroidWebCarrier(`${DROID_WEB_CARRIER_PREFIX}not-json`),
    ).toBeUndefined()
    // A result without its call would leave an unpaired tool result.
    const unpaired = encodeDroidWebCarrier({
      ...responsesCarrier,
      results: [{ id: "other", text: "x", isError: false }],
    })
    expect(decodeDroidWebCarrier(unpaired)).toBeUndefined()
  })
})

describe("Responses carrier expansion", () => {
  test("restores the exact upstream history from Droid's replay", () => {
    const carrier = reasoning(
      "rs_capi_droid_1",
      encodeDroidWebCarrier(responsesCarrier),
    )
    // Droid joins adjacent text: the model's commentary plus the narration.
    const replay: Array<unknown> = [
      { role: "user", content: [{ type: "input_text", text: "Find it" }] },
      reasoning("rs_1", "enc_1"),
      assistantText("msg_1", `Let me search.${NARRATION}`),
      carrier,
      reasoning("rs_2", "enc_2"),
      assistantText("msg_synth_0", "Bun 1.4 shipped."),
    ]
    expect(expandDroidResponsesCarriers(replay)).toEqual([
      replay[0],
      replay[1],
      assistantText("msg_1", "Let me search."),
      {
        type: "function_call",
        call_id: "call_ws",
        name: "WebSearch",
        arguments: '{"query":"bun 1.4"}',
      },
      {
        type: "function_call_output",
        call_id: "call_ws",
        output: "Web Search Results",
      },
      replay[4],
      replay[5],
    ])
  })

  test("puts hidden results after the client calls Droid moved behind them", () => {
    const replay: Array<unknown> = [
      reasoning("rs_1", "enc_1"),
      assistantText("msg_capi_droid_1", NARRATION),
      reasoning("rs_capi_droid_1", encodeDroidWebCarrier(responsesCarrier)),
      {
        type: "function_call",
        call_id: "call_ls",
        name: "LS",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_ls", output: "a.txt" },
    ]
    expect(expandDroidResponsesCarriers(replay)).toEqual([
      replay[0],
      {
        type: "function_call",
        call_id: "call_ws",
        name: "WebSearch",
        arguments: '{"query":"bun 1.4"}',
      },
      replay[3],
      {
        type: "function_call_output",
        call_id: "call_ws",
        output: "Web Search Results",
      },
      replay[4],
    ])
  })

  test("drops an unreadable carrier and keeps ordinary input untouched", () => {
    const plain: Array<unknown> = [reasoning("rs_1", "enc_1")]
    expect(expandDroidResponsesCarriers(plain)).toBe(plain)
    expect(
      expandDroidResponsesCarriers([
        reasoning("rs_1", "enc_1"),
        reasoning("rs_capi_droid_x", `${DROID_WEB_CARRIER_PREFIX}AAAA`),
      ]),
    ).toEqual([reasoning("rs_1", "enc_1")])
  })
})

describe("Messages carrier expansion", () => {
  const carrierBlock = thinking(
    DROID_WEB_CARRIER_LABEL,
    encodeDroidWebCarrier(messagesCarrier),
  )
  const hiddenUse = {
    type: "tool_use",
    id: "toolu_ws",
    name: "WebSearch",
    input: { query: "bun 1.4" },
  }
  const hiddenResult = {
    type: "tool_result",
    tool_use_id: "toolu_ws",
    content: "Web Search Results",
  }
  const ls = { type: "tool_use", id: "toolu_ls", name: "LS", input: {} }
  const lsResult = {
    type: "tool_result",
    tool_use_id: "toolu_ls",
    content: "a",
  }

  test("splits a continued turn back into its tool round trip", () => {
    const messages: Array<unknown> = [
      { role: "user", content: "Find it" },
      {
        role: "assistant",
        content: [
          thinking("Plan.", "sig_1"),
          { type: "text", text: "Let me search." },
          { type: "text", text: NARRATION },
          carrierBlock,
          thinking("Found it.", "sig_2"),
          { type: "text", text: "Listing files." },
          ls,
        ],
      },
      { role: "user", content: [lsResult] },
    ]
    expect(expandDroidMessagesCarriers(messages)).toEqual([
      messages[0],
      {
        role: "assistant",
        content: [
          thinking("Plan.", "sig_1"),
          { type: "text", text: "Let me search." },
          hiddenUse,
        ],
      },
      { role: "user", content: [hiddenResult] },
      {
        role: "assistant",
        content: [
          thinking("Found it.", "sig_2"),
          { type: "text", text: "Listing files." },
          ls,
        ],
      },
      messages[2],
    ])
  })

  test("keeps a mixed round in one turn with all its results", () => {
    const messages: Array<unknown> = [
      { role: "user", content: "Find it" },
      {
        role: "assistant",
        content: [
          thinking("Plan.", "sig_1"),
          { type: "text", text: NARRATION },
          carrierBlock,
          ls,
        ],
      },
      { role: "user", content: [lsResult] },
    ]
    expect(expandDroidMessagesCarriers(messages)).toEqual([
      messages[0],
      {
        role: "assistant",
        content: [thinking("Plan.", "sig_1"), hiddenUse, ls],
      },
      { role: "user", content: [hiddenResult, lsResult] },
    ])
  })

  test("adds the results when a carrier ends the history", () => {
    const messages: Array<unknown> = [
      { role: "user", content: "Find it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: NARRATION },
          { ...carrierBlock, cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "user", content: "Thanks, continue." },
    ]
    expect(expandDroidMessagesCarriers(messages)).toEqual([
      messages[0],
      {
        role: "assistant",
        content: [{ ...hiddenUse, cache_control: { type: "ephemeral" } }],
      },
      {
        role: "user",
        content: [hiddenResult, { type: "text", text: "Thanks, continue." }],
      },
    ])
    expect(expandDroidMessagesCarriers(messages.slice(0, 2))).toEqual([
      messages[0],
      {
        role: "assistant",
        content: [{ ...hiddenUse, cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: [hiddenResult] },
    ])
  })

  test("leaves histories without carriers as they are", () => {
    const messages: Array<unknown> = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [thinking("t", "sig_real")] },
    ]
    expect(expandDroidMessagesCarriers(messages)).toBe(messages)
  })
})
