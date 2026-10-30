import { afterEach, beforeEach, expect, test } from "bun:test"

import type {
  ResponseIncludable,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const requests: Array<Record<string, unknown>> = []

beforeEach(() => {
  requests.length = 0
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    return Promise.resolve(
      Response.json({
        id: "resp_include",
        object: "response",
        model: "gpt-6-astra",
        status: "completed",
        output: [],
      }),
    )
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
})

// Codex sends include values that the local Copilot type does not model.
const includeValues = (...values: Array<string>) =>
  values as Array<ResponseIncludable>

const replayedCall = {
  type: "function_call",
  call_id: "call_replay",
  name: "run_build",
  arguments: "{}",
}
const toolResult = {
  type: "function_call_output",
  call_id: "call_replay",
  output: "BUILD SUCCEEDED",
}
const replayedAnswer = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "The build passed." }],
}
const followup = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Continue." }],
}

for (const prepared of [false, true]) {
  test(`omits Codex output-token replay from Copilot requests (prepared=${prepared})`, async () => {
    const reasoning = {
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    }
    const source: ResponsesPayload = {
      model: "gpt-6-astra",
      input: [
        reasoning,
        { ...replayedCall, encrypted_content: "encrypted-call" },
        toolResult,
        { ...replayedAnswer, encrypted_content: "encrypted-answer" },
        followup,
      ],
      reasoning: { effort: "high", summary: "detailed" },
      include: includeValues(
        "reasoning.encrypted_content",
        "output.encrypted_content",
      ),
    }
    const before = structuredClone(source)
    await seedProtocolDatabase()

    await createResponses(source, {
      initiator: "user",
      vision: false,
      prepared,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].include).toEqual(["reasoning.encrypted_content"])
    expect(requests[0].input).toEqual([
      reasoning,
      replayedCall,
      toolResult,
      replayedAnswer,
      followup,
    ])
    expect(source).toEqual(before)
  })
}

test("keeps Copilot-owned ciphertext and unrelated fields", async () => {
  const retained = [
    {
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    },
    { type: "compaction", encrypted_content: "encrypted-compaction" },
    { type: "context_compaction", encrypted_content: "encrypted-context" },
    { type: "future_item", encrypted_content: "future-ciphertext" },
    {
      type: "function_call",
      call_id: "call_lookup",
      name: "lookup",
      namespace: "functions",
      arguments: "{}",
      encrypted_function_args: [],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "output.encrypted_content" }],
    },
  ]
  const replayed = [
    {
      type: "custom_tool_call",
      call_id: "call_patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
    },
    {
      type: "local_shell_call",
      call_id: "call_shell",
      status: "completed",
      action: { type: "exec", command: ["echo", "ok"] },
    },
    {
      type: "tool_search_call",
      call_id: "call_search",
      status: "completed",
      execution: "client",
      arguments: {},
    },
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "copilot" },
    },
    { type: "image_generation_call", id: "ig_replay", status: "completed" },
    { role: "assistant", content: "Role-only answer." },
  ]
  const tools = [
    {
      type: "function",
      name: "list_items",
      parameters: {
        type: "object",
        properties: {
          include: {
            type: "array",
            items: { enum: ["output.encrypted_content"] },
          },
        },
      },
      strict: false,
    },
  ]
  const streamOptions = { reasoning_summary_delivery: "sequential_cutoff" }
  await seedProtocolDatabase()

  await createResponses(
    {
      model: "gpt-6-astra",
      input: [
        ...retained,
        ...replayed.map((item) => ({
          ...item,
          encrypted_content: "replayed-ciphertext",
        })),
      ],
      tools,
      include: includeValues(
        "web_search_call.action.sources",
        "output.encrypted_content",
        "reasoning.encrypted_content",
        "output.encrypted_content",
      ),
      stream_options: streamOptions,
    },
    { initiator: "user", vision: false, prepared: true },
  )

  expect(requests[0].include).toEqual([
    "web_search_call.action.sources",
    "reasoning.encrypted_content",
  ])
  expect(requests[0].input).toEqual([...retained, ...replayed])
  expect(requests[0].tools).toEqual(tools)
  expect(requests[0].stream_options).toEqual(streamOptions)
})
