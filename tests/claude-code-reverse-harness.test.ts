import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ResponseStreamEvent } from "~/services/copilot/create-responses"

import { asAnthropicUnknownRole } from "~/routes/messages/anthropic-types"
import { prepareMessagesCandidates } from "~/routes/messages/messages-candidates"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

// Minimal synthetic shapes captured from the installed Claude Code 2.1.281 CLI.
// Credentials, session identifiers, machine paths, and real prompts are excluded.
function createClaudeRequest(): AnthropicMessagesPayload {
  return {
    model: "gpt-5.5",
    max_tokens: 64000,
    stream: true,
    system: [{ type: "text", text: "Follow the local harness instructions." }],
    thinking: { type: "adaptive", display: "omitted" },
    context_management: {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
    output_config: { effort: "xhigh" },
    messages: [
      { role: "user", content: "Read the synthetic fixture." },
      {
        role: asAnthropicUnknownRole("system"),
        content: [{ type: "text", text: "The fixture tools are available." }],
        output_config: { effort: "xhigh" },
      },
      {
        role: asAnthropicUnknownRole("developer"),
        content: "Keep the response concise.",
      },
      { role: "assistant", content: "Ready." },
      { role: "user", content: "Continue." },
    ],
  }
}

test("preserves Claude instruction roles in source order for Responses", () => {
  const source = createClaudeRequest()
  const snapshot = structuredClone(source)

  const payload = translateAnthropicMessagesToResponsesPayload(source)

  expect(payload.instructions).toContain(
    "Follow the local harness instructions.",
  )
  expect(payload.input).toEqual([
    { type: "message", role: "user", content: "Read the synthetic fixture." },
    {
      type: "message",
      role: "system",
      content: [
        { type: "input_text", text: "The fixture tools are available." },
      ],
    },
    {
      type: "message",
      role: "developer",
      content: "Keep the response concise.",
    },
    { type: "message", role: "assistant", content: "Ready." },
    { type: "message", role: "user", content: "Continue." },
  ])
  expect(source).toEqual(snapshot)
})

test("preserves Claude instruction roles in source order for Chat", () => {
  const payload = translateToOpenAI(createClaudeRequest())

  expect(payload.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "system",
    "developer",
    "assistant",
    "user",
  ])
  expect(payload.messages[2].content).toBe("The fixture tools are available.")
  expect(payload.messages[3].content).toBe("Keep the response concise.")
})

test("keeps Claude output format and body effort when building GPT candidates", async () => {
  const source = createClaudeRequest()
  source.output_config = {
    effort: "xhigh",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  }
  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel: {
      id: "gpt-5.5",
      name: "GPT-5.5",
      object: "model",
      version: "1",
      supported_endpoints: ["/responses", "/chat/completions"],
      capabilities: {
        family: "gpt",
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  })

  expect(candidates.responses?.payload.reasoning?.effort).toBe("xhigh")
  expect(candidates.responses?.payload.text?.format).toMatchObject({
    type: "json_schema",
    schema: source.output_config.format?.schema,
  })
  expect(candidates.chat?.payload.reasoning_effort).toBe("xhigh")
  expect(candidates.chat?.payload.response_format).toMatchObject({
    type: "json_schema",
    json_schema: { schema: source.output_config.format?.schema },
  })
})

test("exposes discovered deferred tools eagerly and excludes the Claude sentinel", () => {
  const source = createClaudeRequest()
  source.tools = [
    {
      name: "ToolSearch",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
    {
      name: "DeferredToolPlaceholder",
      description:
        "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    },
    {
      name: "mcp__harness__echo",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      defer_loading: true,
    },
  ]
  source.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_search",
          name: "ToolSearch",
          input: { query: "select:mcp__harness__echo" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_search",
          content: [
            { type: "tool_reference", tool_name: "mcp__harness__echo" },
          ],
        },
        { type: "text", text: "Tool loaded." },
      ],
    },
  ]
  const responses = translateAnthropicMessagesToResponsesPayload(source)
  const chat = translateToOpenAI(source)

  expect(responses.tools?.map((tool) => tool.name)).toEqual([
    "ToolSearch",
    "mcp__harness__echo",
  ])
  expect(chat.tools?.map((tool) => tool.function.name)).toEqual([
    "ToolSearch",
    "mcp__harness__echo",
  ])
  expect(responses.input).toContainEqual({
    type: "function_call_output",
    call_id: "toolu_search",
    output: [
      {
        type: "input_text",
        text: '{"type":"tool_reference","tool_name":"mcp__harness__echo"}',
      },
    ],
    status: "completed",
  })
  expect(chat.messages[1]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "toolu_search" }],
  })
  expect(chat.messages[2]).toEqual({
    role: "tool",
    tool_call_id: "toolu_search",
    content: '{"type":"tool_reference","tool_name":"mcp__harness__echo"}',
  })
  expect(chat.messages[3]).toEqual({ role: "user", content: "Tool loaded." })
})

test("represents a failed tool result as delivered error text beside its image", () => {
  const source = createClaudeRequest()
  source.messages = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read",
          is_error: true,
          content: [
            { type: "text", text: "Fixture read failed." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aW1hZ2U=",
              },
            },
          ],
        },
      ],
    },
  ]
  const responses = translateAnthropicMessagesToResponsesPayload(source)
  const chat = translateToOpenAI(source)

  expect(responses.input).toEqual([
    {
      type: "function_call_output",
      call_id: "toolu_read",
      status: "completed",
      output: [
        { type: "input_text", text: "[Tool execution failed]" },
        { type: "input_text", text: "Fixture read failed." },
        {
          type: "input_image",
          image_url: "data:image/png;base64,aW1hZ2U=",
          detail: "auto",
        },
      ],
    },
  ])
  expect(chat.messages[1]).toEqual({
    role: "tool",
    tool_call_id: "toolu_read",
    content: [
      { type: "text", text: "[Tool execution failed]" },
      { type: "text", text: "Fixture read failed." },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aW1hZ2U=" },
      },
    ],
  })
})

test("does not replay native Claude opaque signatures as GPT Chat state", () => {
  const source = createClaudeRequest()
  source.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Synthetic readable summary.",
          signature: "native-Claude-signature",
        },
      ],
    },
  ]

  const assistant = translateToOpenAI(source).messages[1]

  expect(assistant).not.toHaveProperty("reasoning_opaque")
  expect(JSON.stringify(assistant)).toContain("Synthetic readable summary.")
})

test.each(["native@not-a-response-id", "capi_anthropic_v1:opaque@rs_123"])(
  "does not replay a foreign signature as GPT Responses state: %s",
  (signature) => {
    const source = createClaudeRequest()
    source.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Synthetic readable summary.",
            signature,
          },
        ],
      },
    ]

    const payload = translateAnthropicMessagesToResponsesPayload(source)

    expect(JSON.stringify(payload.input)).not.toContain("encrypted_content")
    expect(JSON.stringify(payload.input)).toContain(
      "Synthetic readable summary.",
    )
  },
)

test("round-trips streamed GPT reasoning and a fragmented tool call through Claude history", () => {
  const stream = createResponsesStreamState()
  const upstream: Array<ResponseStreamEvent> = [
    {
      type: "response.output_item.done",
      sequence_number: 0,
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_harness",
        summary: [
          { type: "summary_text", text: "Synthetic readable summary." },
        ],
        encrypted_content: "synthetic-gpt-state",
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_harness",
        call_id: "call_harness",
        name: "mcp__harness__echo",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 2,
      item_id: "fc_harness",
      output_index: 1,
      delta: '{"text":',
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc_harness",
      output_index: 1,
      delta: '"synthetic"}',
    },
  ]
  const events = upstream.flatMap((event) => {
    const translated = translateResponsesStreamEvent(event, stream)
    if (translated.kind !== "events") throw new Error("Expected stream events")
    return translated.events
  })
  const call = events.find(
    (event) =>
      event.type === "content_block_start"
      && event.content_block.type === "tool_use",
  )
  const signature = events.find(
    (event) =>
      event.type === "content_block_delta"
      && event.delta.type === "signature_delta",
  )
  if (
    call?.type !== "content_block_start"
    || call.content_block.type !== "tool_use"
    || signature?.type !== "content_block_delta"
    || signature.delta.type !== "signature_delta"
  ) {
    throw new Error("Missing streamed tool or reasoning state")
  }
  const argumentsJson = events
    .flatMap((event) =>
      (
        event.type === "content_block_delta"
        && event.delta.type === "input_json_delta"
      ) ?
        [event.delta.partial_json]
      : [],
    )
    .join("")
  const source = createClaudeRequest()
  source.messages = [
    ...source.messages.slice(0, 2),
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Synthetic readable summary.",
          signature: signature.delta.signature,
        },
        {
          ...call.content_block,
          input: JSON.parse(argumentsJson) as Record<string, unknown>,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call.content_block.id,
          content: "SYNTHETIC_MCP_OK",
        },
      ],
    },
    {
      role: asAnthropicUnknownRole("system"),
      content: [{ type: "text", text: "Continue with the fixture result." }],
    },
  ]

  const followup = translateAnthropicMessagesToResponsesPayload(source)

  expect(followup.input).toContainEqual({
    type: "reasoning",
    id: "rs_harness",
    summary: [{ type: "summary_text", text: "Synthetic readable summary." }],
    encrypted_content: "synthetic-gpt-state",
  })
  expect(followup.input).toContainEqual({
    type: "function_call",
    call_id: "call_harness",
    name: "mcp__harness__echo",
    arguments: '{"text":"synthetic"}',
    status: "completed",
  })
  expect(followup.input).toContainEqual({
    type: "function_call_output",
    call_id: "call_harness",
    output: "SYNTHETIC_MCP_OK",
    status: "completed",
  })
  expect(Array.isArray(followup.input) && followup.input.at(-1)).toEqual({
    type: "message",
    role: "system",
    content: [
      { type: "input_text", text: "Continue with the fixture result." },
    ],
  })
})
