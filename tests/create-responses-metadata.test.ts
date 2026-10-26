import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

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
        id: "resp_metadata",
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

const retainedMetadata = {
  turn_id: "turn_metadata",
  create_time: 1792987358.4661546,
  content_item_kinds: ["text"],
  future_metadata: { preserved: true },
}
const contentItemMetadata = [{ provenance: { type: "harness", hook: false } }]

for (const prepared of [false, true]) {
  test(`removes only unsupported Copilot input metadata (prepared=${prepared})`, async () => {
    const source: ResponsesPayload = {
      model: "gpt-6-astra",
      input: [
        {
          type: "message",
          id: "msg_metadata",
          role: "developer",
          content: [{ type: "input_text", text: "Keep the instructions." }],
          internal_chat_message_metadata_passthrough: {
            ...retainedMetadata,
            content_item_metadata: contentItemMetadata,
          },
        },
        {
          type: "function_call_output",
          call_id: "call_metadata",
          output: "Keep the tool result.",
          internal_chat_message_metadata_passthrough: {
            ...retainedMetadata,
            content_item_metadata: contentItemMetadata,
          },
        },
      ],
    }
    const before = structuredClone(source)
    await seedProtocolDatabase()

    await createResponses(source, {
      initiator: "user",
      vision: false,
      prepared,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].input).toEqual([
      {
        type: "message",
        id: "msg_metadata",
        role: "developer",
        content: [{ type: "input_text", text: "Keep the instructions." }],
        internal_chat_message_metadata_passthrough: retainedMetadata,
      },
      {
        type: "function_call_output",
        call_id: "call_metadata",
        output: "Keep the tool result.",
        internal_chat_message_metadata_passthrough: retainedMetadata,
      },
    ])
    expect(source).toEqual(before)
  })
}

test("preserves similarly named fields outside direct input metadata", async () => {
  const content = {
    type: "input_text",
    text: "Keep extension data.",
    content_item_metadata: contentItemMetadata,
    internal_chat_message_metadata_passthrough: {
      content_item_metadata: contentItemMetadata,
    },
  }
  const input = [
    {
      type: "message",
      role: "user",
      content: [content],
      content_item_metadata: contentItemMetadata,
      internal_chat_message_metadata_passthrough: retainedMetadata,
    },
    {
      type: "function_call_output",
      call_id: "call_nested_metadata",
      output: [content],
    },
  ]
  const tools = [
    {
      type: "function",
      name: "keep_metadata",
      parameters: {
        type: "object",
        properties: {
          content_item_metadata: { type: "string" },
          internal_chat_message_metadata_passthrough: { type: "object" },
        },
      },
    },
  ]
  await seedProtocolDatabase()

  await createResponses(
    {
      model: "gpt-6-astra",
      input,
      tools,
      content_item_metadata: contentItemMetadata,
    },
    { initiator: "user", vision: false, prepared: true },
  )

  expect(requests[0].input).toEqual(input)
  expect(requests[0].tools).toEqual(tools)
  expect(requests[0].content_item_metadata).toEqual(contentItemMetadata)
})

test("retains empty and non-object metadata without inventing input fields", async () => {
  const metadataValues = [
    null,
    "opaque metadata",
    42,
    [{ content_item_metadata: contentItemMetadata }],
    {},
  ]
  const unchanged = metadataValues.map((metadata) => ({
    type: "message",
    role: "user",
    content: "Keep this message.",
    internal_chat_message_metadata_passthrough: metadata,
  }))
  const withoutMetadata = {
    type: "message",
    role: "user",
    content: "Plain input.",
  }
  await seedProtocolDatabase()

  await createResponses(
    {
      model: "gpt-6-astra",
      input: [
        ...unchanged,
        withoutMetadata,
        {
          ...withoutMetadata,
          internal_chat_message_metadata_passthrough: {
            content_item_metadata: contentItemMetadata,
          },
        },
      ],
    },
    { initiator: "user", vision: false, prepared: true },
  )

  expect(requests[0].input).toEqual([
    ...unchanged,
    withoutMetadata,
    { ...withoutMetadata, internal_chat_message_metadata_passthrough: {} },
  ])
})
