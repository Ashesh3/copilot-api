import { expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  rehydrateContinuationPayloadFromSnapshot,
  resolveResponsesContinuation,
} from "~/routes/responses/websocket-protocol"
import {
  finalizeNativeResponsesRequest,
  finalizeResponsesRequest,
  prepareResponsesRequest,
} from "~/services/copilot/responses-contract"
import { withoutLegacyWebResults } from "~/services/web/legacy-history"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

function legacyResult(name = "_copilot_web_search", outcome = "result") {
  return {
    type: "message",
    id: "web_result_call_fixture",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: `[Web tool ${name} ${outcome}]\nPUBLIC_FIXTURE\n[End web tool result]`,
        annotations: [],
      },
    ],
  }
}

const genuineHistory = [
  { role: "user", content: "Read a public page" },
  {
    type: "reasoning",
    id: "rs_fixture",
    encrypted_content: "opaque-signed-state",
    summary: [],
  },
  {
    type: "function_call",
    id: "fc_fixture",
    call_id: "call_client",
    name: "read_file",
    arguments: '{"path":"README"}',
  },
  {
    type: "function_call_output",
    call_id: "call_client",
    output: "public file content",
  },
  {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Actual answer", annotations: [] }],
  },
]

const requestPaths = [
  {
    name: "initial Responses preparation",
    prepare: (payload: ResponsesPayload) =>
      prepareResponsesRequest(payload).source,
  },
  {
    name: "native Responses finalization",
    prepare: (payload: ResponsesPayload) =>
      finalizeNativeResponsesRequest(
        { source: payload, normalizationClasses: [] },
        { model: payload.model, implicitDefault: false },
      ).body,
  },
  {
    name: "legacy Responses finalization",
    prepare: (payload: ResponsesPayload) =>
      finalizeResponsesRequest(payload, { implicitDefault: false }).body,
  },
]

for (const path of requestPaths) {
  test(`${path.name} preserves an absent input field`, () => {
    expect(path.prepare({ model: "fixture" })).not.toHaveProperty("input")
  })

  test.each([
    { name: "_copilot_web_search", outcome: "result" },
    { name: "_copilot_web_search_12", outcome: "failed" },
    { name: "web_search", outcome: "result" },
    { name: "web_search", outcome: "failed" },
  ])(`${path.name} removes exact legacy $name $outcome artifacts`, (call) => {
    const payload: ResponsesPayload = {
      model: "fixture",
      input: [
        genuineHistory[0],
        legacyResult(call.name, call.outcome),
        ...genuineHistory.slice(1),
      ],
    }
    const original = structuredClone(payload)
    expect(path.prepare(payload).input).toEqual(genuineHistory)
    expect(payload).toEqual(original)
  })

  test(`${path.name} preserves lookalikes and genuine history beside an artifact`, () => {
    const message = legacyResult()
    const part = message.content[0]
    const lookalikes = [
      { ...message, id: "msg_genuine" },
      { ...message, id: "web_result_" },
      { ...message, type: "reasoning" },
      { ...message, role: "user" },
      { ...message, status: "in_progress" },
      { ...message, phase: "final_answer" },
      { ...message, content: [{ ...part, type: "input_text" }] },
      {
        ...message,
        content: [
          {
            ...part,
            annotations: [
              { type: "url_citation", url: "https://example.test" },
            ],
          },
        ],
      },
      { ...message, content: [{ ...part, logprobs: [] }] },
      {
        ...message,
        content: [
          part,
          { type: "output_text", text: "Keep me", annotations: [] },
        ],
      },
      { ...message, content: [{ ...part, text: `Quoted: ${part.text}` }] },
      { ...message, content: [{ ...part, text: `${part.text}\n` }] },
      {
        ...message,
        content: [
          { ...part, text: part.text.replace("\n[End web tool result]", "") },
        ],
      },
      legacyResult("_copilot_web_search_other"),
      legacyResult("_copilot_web_search_0"),
      legacyResult("_copilot_web_search_01"),
      legacyResult("read_file"),
      legacyResult("web_search_1"),
      legacyResult("_copilot_web_search", "error"),
    ]
    const retained = [
      ...genuineHistory,
      ...lookalikes.map((item) => structuredClone(item)),
    ]
    const payload: ResponsesPayload = {
      model: "fixture",
      input: [message, ...retained],
    }
    const original = structuredClone(payload)
    expect(path.prepare(payload).input).toEqual(retained)
    expect(payload).toEqual(original)
  })
}

test("legacy cleanup preserves unchanged input references and never descends into genuine items", () => {
  const nested = {
    type: "function_call_output",
    call_id: "call_nested",
    output: [legacyResult()],
  }
  const history = Object.freeze([...genuineHistory, nested])
  expect(withoutLegacyWebResults(history)).toBe(history)
  expect(withoutLegacyWebResults(nested)).toBe(nested)
  expect(withoutLegacyWebResults("plain input")).toBe("plain input")
  expect(withoutLegacyWebResults<unknown>(undefined)).toBeUndefined()
  expect(withoutLegacyWebResults(null)).toBeNull()
})

test("legacy cleanup filters a new array while retaining every genuine item by identity", () => {
  const legacy = legacyResult()
  legacy.content[0].text =
    "[Web tool _copilot_web_search result]\n\n[End web tool result]"
  const history = Object.freeze([
    legacy,
    ...genuineHistory,
    legacyResult("web_search", "failed"),
  ])
  const original = structuredClone(history)
  const cleaned = withoutLegacyWebResults(history)
  expect(cleaned).not.toBe(history)
  expect(cleaned).toEqual(genuineHistory)
  for (const [index, item] of genuineHistory.entries())
    expect(cleaned[index]).toBe(item)
  expect(history).toEqual(original)
})

test("WebSocket rehydration removes legacy artifacts from both snapshot and incoming history", () => {
  const snapshot: ResponsesPayload = {
    model: "fixture",
    input: [genuineHistory[0], legacyResult(), ...genuineHistory.slice(1)],
    client_metadata: { session_id: "same-session" },
  }
  const next = { role: "user", content: "Continue" }
  const payload: ResponsesPayload = {
    model: "fixture",
    previous_response_id: "resp_previous",
    input: [legacyResult("web_search", "failed"), next],
  }
  const original = structuredClone({ snapshot, payload })
  const result = rehydrateContinuationPayloadFromSnapshot(snapshot, payload)
  expect(result.input).toEqual([...genuineHistory, next])
  expect(result.client_metadata).toEqual({ session_id: "same-session" })
  expect(result).not.toHaveProperty("previous_response_id")
  expect({ snapshot, payload }).toEqual(original)
})

test("cached WebSocket continuation cannot reintroduce a removed legacy artifact", () => {
  const snapshot: ResponsesPayload = {
    model: "fixture",
    input: [legacyResult(), ...genuineHistory],
  }
  const snapshots = new Map([["resp_previous", snapshot]])
  const payload: ResponsesPayload = {
    model: "fixture",
    previous_response_id: "resp_previous",
    input: "Follow up",
  }
  const original = structuredClone(snapshot)
  const result = resolveResponsesContinuation(snapshots, payload)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.payload.input).toEqual([
    ...genuineHistory,
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Follow up" }],
    },
  ])
  expect(snapshots.get("resp_previous")).toEqual(original)
})
