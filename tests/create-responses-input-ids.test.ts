import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import {
  recoverReasoningItemIds,
  resetRejectedReasoningStateForTest,
} from "~/services/copilot/responses-reasoning-state"
import { createRetryBudget } from "~/services/copilot/transport-retry"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const requests: Array<Record<string, unknown>> = []
const responses: Array<Response> = []
const ownershipMessage = "input item ID does not belong to this connection"

function rejection(message = ownershipMessage, status = 401): Response {
  return Response.json({ error: { message, code: "" } }, { status })
}

function success(): Response {
  return Response.json({
    id: "resp_factory",
    object: "response",
    model: "gpt-6.1-sol",
    status: "completed",
    output: [],
  })
}

function history(): ResponsesPayload {
  return {
    model: "gpt-6.1-sol",
    input: [
      {
        type: "message",
        id: "msg_synth_0",
        role: "assistant",
        content: [{ type: "output_text", text: "Starting the mission." }],
        phase: "commentary",
      },
      {
        type: "reasoning",
        id: "opaque-reasoning-id",
        summary: [{ type: "summary_text", text: "Keep the reasoning." }],
        encrypted_content: "encrypted-reasoning",
      },
      {
        type: "custom_tool_call",
        call_id: "call_script",
        name: "Script",
        input: "return 1",
      },
      { type: "custom_tool_call_output", call_id: "call_script", output: "1" },
      { role: "user", content: "Continue." },
    ],
  }
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  resetRejectedReasoningStateForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    const response = responses.shift()
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  resetRejectedReasoningStateForTest()
})

for (const prepared of [false, true]) {
  test(`recovers rejected reasoning IDs without discarding ciphertext (prepared=${prepared})`, async () => {
    await seedProtocolDatabase()
    const source = history()
    const before = structuredClone(source)
    responses.push(rejection(), success())

    await createResponses(source, {
      initiator: "user",
      vision: false,
      prepared,
      allowCompatibilityRetry: false,
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].input).toEqual(before.input)
    const expected = structuredClone(requests[0])
    const input = expected.input as Array<Record<string, unknown>>
    delete input[1].id
    expect(requests[1]).toEqual(expected)
    expect(source).toEqual(before)
  })
}

test("recovers ciphertext only after removing rejected reasoning IDs", async () => {
  await seedProtocolDatabase()
  const source = history()
  const before = structuredClone(source)
  responses.push(
    rejection(),
    rejection("input item does not belong to this connection"),
    success(),
  )

  await createResponses(source, { initiator: "user", vision: false })

  expect(requests).toHaveLength(3)
  const expected = structuredClone(requests[0])
  const input = expected.input as Array<Record<string, unknown>>
  delete input[1].id
  expect(requests[1]).toEqual(expected)
  delete input[1].encrypted_content
  expect(requests[2]).toEqual(expected)
  expect(source).toEqual(before)
})

test("omits rejected reasoning IDs with cached refused ciphertext on later turns", async () => {
  await seedProtocolDatabase()
  const source = history()
  const before = structuredClone(source)
  responses.push(
    rejection(),
    rejection("input item does not belong to this connection"),
    success(),
    success(),
  )

  await createResponses(source, { initiator: "user", vision: false })
  await createResponses(source, { initiator: "user", vision: false })

  expect(requests).toHaveLength(4)
  expect(requests[3]).toEqual(requests[2])
  expect(source).toEqual(before)
})

test("does not remove accepted IDs or treat an ID rejection as refused ciphertext", async () => {
  await seedProtocolDatabase()
  const source = history()
  responses.push(rejection(), success(), success())

  await createResponses(source, { initiator: "user", vision: false })
  await createResponses(source, { initiator: "user", vision: false })

  expect(requests).toHaveLength(3)
  expect(requests[2].input).toEqual(source.input)
})

test("does not loop or discard ciphertext when the ID rejection persists", async () => {
  await seedProtocolDatabase()
  responses.push(rejection(), rejection())

  const error = await createResponses(history(), {
    initiator: "user",
    vision: false,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests).toHaveLength(2)
  expect(requests[1].input).toContainEqual({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Keep the reasoning." }],
    encrypted_content: "encrypted-reasoning",
  })
})

test("preserves reference-only and unrelated IDs", async () => {
  await seedProtocolDatabase()
  const retained = [
    { type: "item_reference", id: "reference-id" },
    { type: "reasoning", id: "reasoning-reference", summary: [] },
    { type: "compaction", id: "compaction-id", encrypted_content: "compact" },
  ]
  const source = history()
  if (!Array.isArray(source.input)) throw new Error("Expected input items")
  source.input.push(...retained)
  responses.push(rejection(), success())

  await createResponses(source, { initiator: "user", vision: false })

  const input = requests[1].input as Array<Record<string, unknown>>
  expect(input.slice(-retained.length)).toEqual(retained)
})

test("does not retry ID-only references with no self-contained reasoning state", async () => {
  await seedProtocolDatabase()
  responses.push(rejection())

  const error = await createResponses(
    {
      model: "gpt-6.1-sol",
      input: [
        { type: "item_reference", id: "reference-id" },
        { type: "reasoning", id: "reasoning-reference", summary: [] },
      ],
    },
    { initiator: "user", vision: false },
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests).toHaveLength(1)
})

test("honors an exhausted shared retry budget", async () => {
  await seedProtocolDatabase()
  responses.push(rejection())
  const retryBudget = createRetryBudget({ extraSends: 0 })

  const error = await createResponses(history(), {
    initiator: "user",
    vision: false,
    retryBudget,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests).toHaveLength(1)
  expect(retryBudget.remaining).toBe(0)
})

test.each([
  { message: "input item does not belong to this connection" },
  { message: "previous_response_id does not belong to this connection" },
  { message: "Bad credentials" },
  { message: ownershipMessage, code: "internal_error" },
  { message: ownershipMessage, type: "server_error" },
])(
  "does not treat another rejection as a reasoning ID error: %j",
  async (error) => {
    const source = history()
    const before = structuredClone(source)
    const response = Response.json({ error }, { status: 400 })

    expect(await recoverReasoningItemIds(source, response)).toBeUndefined()
    expect(source).toEqual(before)
    expect(response.bodyUsed).toBe(false)
  },
)

test("does not recover malformed or server error responses", async () => {
  for (const response of [
    new Response("Bad Request", { status: 400 }),
    rejection(ownershipMessage, 500),
    rejection(ownershipMessage, 200),
  ]) {
    expect(await recoverReasoningItemIds(history(), response)).toBeUndefined()
  }
})

for (const prepared of [false, true]) {
  test(`repairs saved bridge tool-search IDs before native replay (prepared=${prepared})`, async () => {
    await seedProtocolDatabase()
    const source: ResponsesPayload = {
      model: "gpt-6-astra",
      input: [
        {
          type: "tool_search_call",
          id: "ts_toolu_legacy_search",
          call_id: "toolu_legacy_search",
          status: "completed",
          execution: "client",
          arguments: { query: "find a file", limit: 1 },
        },
        {
          type: "tool_search_output",
          call_id: "toolu_legacy_search",
          execution: "client",
          tools: [{ type: "function", name: "find_file", parameters: {} }],
        },
        {
          type: "tool_search_call",
          id: "ts_call_legacy_search",
          call_id: "call_legacy_search",
          status: "completed",
          execution: "client",
          arguments: { query: "read a file" },
        },
        {
          type: "tool_search_output",
          call_id: "call_legacy_search",
          execution: "client",
          tools: [{ type: "function", name: "read_file", parameters: {} }],
        },
        { role: "user", content: "Continue with Astra." },
      ],
    }
    const before = structuredClone(source)
    responses.push(success())

    await createResponses(source, {
      initiator: "user",
      vision: false,
      nativeResponses: true,
      prepared,
      allowCompatibilityRetry: false,
    })

    expect(requests).toHaveLength(1)
    const expected = structuredClone(before.input) as Array<
      Record<string, unknown>
    >
    expected[0].id = "tsc_toolu_legacy_search"
    expected[2].id = "tsc_call_legacy_search"
    expect(requests[0].input).toEqual(expected)
    expect(source).toEqual(before)
  })
}

test("preserves native search IDs and items without a matching legacy bridge identity", async () => {
  await seedProtocolDatabase()
  const search = {
    type: "tool_search_call",
    call_id: "call_search",
    status: "completed",
    execution: "client",
    arguments: { query: "find tools" },
  }
  const input = [
    { ...search, id: "tsc_native_search" },
    { ...search, id: "ts_unrelated" },
    { ...search, id: "ts_call_search", execution: "server" },
    { ...search, id: "ts_", call_id: "" },
    {
      type: "tool_search_call",
      id: "ts_missing_call_id",
      execution: "client",
      arguments: {},
    },
    { ...search },
    { type: "item_reference", id: "ts_call_search" },
    {
      type: "function_call",
      id: "ts_call_search",
      call_id: "call_search",
      name: "find_file",
      arguments: "{}",
    },
    {
      type: "tool_search_output",
      id: "ts_call_search",
      call_id: "call_search",
      execution: "client",
      tools: [],
    },
  ]
  const source: ResponsesPayload = { model: "gpt-6-astra", input }
  const before = structuredClone(source)
  responses.push(success())

  await createResponses(source, {
    initiator: "user",
    vision: false,
    nativeResponses: true,
    prepared: true,
  })

  expect(requests).toHaveLength(1)
  expect(requests[0].input).toEqual(before.input)
  expect(source).toEqual(before)
})
