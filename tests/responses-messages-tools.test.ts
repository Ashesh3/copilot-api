import { expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  adaptResponsesToMessagesCandidate,
  anthropicResponseToResponsesResult,
} from "~/routes/responses/messages-bridge"
import { decodeAnthropicReasoningEnvelope } from "~/routes/responses/messages-reasoning-provenance"

function response(
  content: AnthropicResponse["content"],
  model = "claude-opus-5.5",
): AnthropicResponse {
  return {
    id: "msg_bridge",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 5 },
  }
}

function blocks(payload: AnthropicMessagesPayload) {
  return payload.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  )
}

test("preserves distinct executable tools with the same name across namespaces", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: "Run the requested tools",
    tools: [
      { type: "function", name: "run", description: "root tool" },
      ...["alpha", "beta"].map((namespace) => ({
        type: "namespace",
        name: namespace,
        tools: [{ type: "function", name: "run", description: namespace }],
      })),
    ],
  }
  const snapshot = structuredClone(source)
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  const tools = candidate.payload.tools ?? []
  expect(tools).toHaveLength(3)
  expect(new Set(tools.map((tool) => tool.name)).size).toBe(3)
  expect(tools.find((tool) => tool.description === "root tool")?.name).toBe(
    "run",
  )
  for (const namespace of ["alpha", "beta"]) {
    const wireTool = tools.find((tool) => tool.description === namespace)
    expect(wireTool?.name).toMatch(/^[\w-]{1,64}$/)
    const result = anthropicResponseToResponsesResult(
      response([
        {
          type: "tool_use",
          id: `call_${namespace}`,
          name: String(wireTool?.name),
          input: { value: namespace },
        },
      ]),
      "public-model",
      source,
    )
    expect(result.model).toBe("public-model")
    expect(result.output).toHaveLength(1)
    expect(result.output[0]).toMatchObject({
      type: "function_call",
      namespace,
      name: "run",
      call_id: `call_${namespace}`,
      arguments: JSON.stringify({ value: namespace }),
    })
  }
  expect(source).toEqual(snapshot)
})

test("preserves ordered shared namespace instructions with leaf descriptions and custom grammar", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: "Read and edit files",
    tools: [
      { type: "function", name: "standalone", description: "Root tool only" },
      {
        type: "namespace",
        name: "functions",
        description:
          "All paths are relative to the workspace. Never pass absolute paths.",
        tools: [
          { type: "function", name: "read_file", description: "Read a file" },
          {
            type: "namespace",
            name: "editor",
            description: "Apply one complete patch per invocation.",
            tools: [
              {
                type: "custom",
                name: "apply_patch",
                description: "Edit a file",
                format: {
                  type: "grammar",
                  syntax: "lark",
                  definition: "start: PATCH",
                },
              },
            ],
          },
        ],
      },
    ],
  }
  const original = structuredClone(source)
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  const descriptions =
    candidate.payload.tools?.map((tool) => String(tool.description)) ?? []
  expect(descriptions).toContain("Root tool only")
  expect(descriptions).toContain(
    "All paths are relative to the workspace. Never pass absolute paths.\n\nRead a file",
  )
  const custom =
    descriptions.find((description) => description.includes("start: PATCH"))
    ?? ""
  expect(
    custom.startsWith(
      "All paths are relative to the workspace. Never pass absolute paths.\n\nApply one complete patch per invocation.\n\nEdit a file\n\n",
    ),
  ).toBe(true)
  expect(custom).toContain("start: PATCH")
  expect(source).toEqual(original)
})

test("wraps custom grammar input and restores the exact raw tool call", async () => {
  const rawInput =
    "*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch"
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: "Apply the patch",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Edit files with a patch",
        format: { type: "grammar", syntax: "lark", definition: "start: PATCH" },
      },
    ],
    tool_choice: { type: "custom", name: "apply_patch" },
  }
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  const tool = candidate.payload.tools?.[0]
  expect(tool?.input_schema).toMatchObject({
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  })
  expect(tool?.description).toContain("Edit files with a patch")
  expect(tool?.description).toContain("start: PATCH")
  expect(candidate.payload.tool_choice).toEqual({
    type: "tool",
    name: String(tool?.name),
  })
  const result = anthropicResponseToResponsesResult(
    response([
      {
        type: "tool_use",
        id: "call_patch",
        name: String(tool?.name),
        input: { input: rawInput },
      },
    ]),
    source.model,
    source,
  )
  expect(result.output).toHaveLength(1)
  expect(result.output[0]).toMatchObject({
    type: "custom_tool_call",
    call_id: "call_patch",
    name: "apply_patch",
    input: rawInput,
  })
  expect(result.output[0]).not.toHaveProperty("arguments")
})

test("loads additional_tools and keeps custom call history paired with typed output", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "custom", name: "exec", description: "Run JavaScript" },
              { type: "function", name: "wait", description: "Wait for exec" },
            ],
          },
        ],
      },
      { role: "user", content: "Run the command" },
      {
        type: "custom_tool_call",
        call_id: "call_exec",
        namespace: "functions",
        name: "exec",
        input: "text(await tools.exec_command({cmd:'pwd'}));",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_exec",
        output: [
          { type: "input_text", text: "first result" },
          { type: "input_text", text: "second result" },
        ],
      },
    ],
  }
  const snapshot = structuredClone(source)
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  expect(candidate.payload.tools).toHaveLength(2)
  const tool = candidate.payload.tools?.find((entry) =>
    String(entry.description).includes("Run JavaScript"),
  )
  expect(blocks(candidate.payload)).toContainEqual({
    type: "tool_use",
    id: "call_exec",
    name: String(tool?.name),
    input: { input: "text(await tools.exec_command({cmd:'pwd'}));" },
  })
  expect(blocks(candidate.payload)).toContainEqual({
    type: "tool_result",
    tool_use_id: "call_exec",
    content: [
      { type: "text", text: "first result" },
      { type: "text", text: "second result" },
    ],
  })
  expect(JSON.stringify(candidate.payload)).not.toContain(
    "[Future Responses item]",
  )
  expect(source).toEqual(snapshot)
})

test("maps client tool search and makes discovered namespaces executable on continuation", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    tools: [
      {
        type: "tool_search",
        execution: "client",
        description: "Find a deferred tool",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ],
    tool_choice: { type: "tool_search" },
    input: [
      { role: "user", content: "Find and call a tool" },
      {
        type: "tool_search_call",
        execution: "client",
        call_id: "call_search",
        arguments: { query: "spawn agent", limit: 1 },
      },
      {
        type: "tool_search_output",
        execution: "client",
        call_id: "call_search",
        tools: [
          {
            type: "namespace",
            name: "multi_agent_v1",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                description: "Start an agent",
                defer_loading: true,
              },
            ],
          },
        ],
      },
    ],
  }
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  expect(candidate.payload.tools).toHaveLength(2)
  const search = candidate.payload.tools?.find(
    (tool) => tool.description === "Find a deferred tool",
  )
  const discovered = candidate.payload.tools?.find(
    (tool) => tool.description === "Start an agent",
  )
  expect(candidate.payload.tool_choice).toMatchObject({ name: search?.name })
  expect(blocks(candidate.payload)).toContainEqual({
    type: "tool_use",
    id: "call_search",
    name: String(search?.name),
    input: { query: "spawn agent", limit: 1 },
  })
  expect(
    blocks(candidate.payload).find((block) => block.type === "tool_result"),
  ).toMatchObject({ tool_use_id: "call_search" })
  const result = anthropicResponseToResponsesResult(
    response([
      {
        type: "tool_use",
        id: "search_next",
        name: String(search?.name),
        input: { query: "wait" },
      },
      {
        type: "tool_use",
        id: "spawn_next",
        name: String(discovered?.name),
        input: { message: "hello" },
      },
    ]),
    source.model,
    source,
  )
  expect(result.output[0]).toMatchObject({
    type: "tool_search_call",
    call_id: "search_next",
    execution: "client",
    arguments: { query: "wait" },
  })
  expect(result.output[1]).toMatchObject({
    type: "function_call",
    namespace: "multi_agent_v1",
    name: "spawn_agent",
    arguments: '{"message":"hello"}',
  })
})

test("avoids a client tool name that collides with a generated namespace alias", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: "Run tools",
    tools: [
      {
        type: "namespace",
        name: "space",
        tools: [{ type: "function", name: "run" }],
      },
    ],
  }
  const original = await adaptResponsesToMessagesCandidate({ source })
  const reservedName = original.payload.tools?.[0]?.name
  expect(typeof reservedName).toBe("string")
  source.tools?.push({
    type: "function",
    name: reservedName,
    description: "existing root tool",
  })
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  const names = candidate.payload.tools?.map((tool) => tool.name)
  expect(new Set(names).size).toBe(2)
  expect(names).toContain(reservedName)
  expect((await adaptResponsesToMessagesCandidate({ source })).payload).toEqual(
    candidate.payload,
  )
})

test("round-trips signed and redacted Claude thinking without treating GPT ciphertext as a signature", async () => {
  const native = response([
    {
      type: "thinking",
      thinking: "first thought",
      signature: "claude-signature",
    },
    { type: "redacted_thinking", data: "opaque-redacted-data" },
    { type: "text", text: "Continue" },
  ])
  const translated = anthropicResponseToResponsesResult(native, "public-model")
  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      model: native.model,
      input: [
        ...(translated.output as unknown as Array<ResponseInputItem>),
        { role: "user", content: "Next" },
      ],
    },
  })
  expect(blocks(candidate.payload)).toContainEqual({
    type: "thinking",
    thinking: "first thought",
    signature: "claude-signature",
  })
  expect(blocks(candidate.payload)).toContainEqual({
    type: "redacted_thinking",
    data: "opaque-redacted-data",
  })
  const foreign = await adaptResponsesToMessagesCandidate({
    source: {
      model: native.model,
      input: [
        {
          type: "reasoning",
          encrypted_content: "gpt-encrypted-state",
          summary: [{ type: "summary_text", text: "readable context" }],
        },
      ],
    },
  })
  expect(
    blocks(foreign.payload).some((block) => block.type === "thinking"),
  ).toBe(false)
  expect(JSON.stringify(foreign.payload)).toContain("readable context")
  expect(JSON.stringify(foreign.payload)).not.toContain("gpt-encrypted-state")
})

test("does not replay provider reasoning envelopes for a different Claude model", async () => {
  const translated = anthropicResponseToResponsesResult(
    response([
      {
        type: "thinking",
        thinking: "readable summary",
        signature: "signed-for-opus",
      },
    ]),
    "public-model",
  )
  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      model: "claude-sonnet-4.6",
      input: translated.output as unknown as Array<ResponseInputItem>,
    },
  })
  expect(
    blocks(candidate.payload).some((block) => block.type === "thinking"),
  ).toBe(false)
  expect(JSON.stringify(candidate.payload)).toContain("readable summary")
  expect(JSON.stringify(candidate.payload)).not.toContain("signed-for-opus")
})

test("binds thinking to the routed model when the provider responds with a different model alias", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: "hello",
  }
  const translated = anthropicResponseToResponsesResult(
    response(
      [
        {
          type: "thinking",
          thinking: "preserve thought",
          signature: "opus-signature",
        },
      ],
      "claude-opus-5-5-dated",
    ),
    "public-model",
    source,
  )
  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      ...source,
      input: translated.output as unknown as Array<ResponseInputItem>,
    },
  })
  expect(blocks(candidate.payload)).toContainEqual({
    type: "thinking",
    thinking: "preserve thought",
    signature: "opus-signature",
  })
})

test("preserves custom tool image results as typed Messages tool content", async () => {
  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      model: "claude-opus-5.5",
      tools: [{ type: "custom", name: "screenshot" }],
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_image",
          name: "screenshot",
          input: "capture",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_image",
          output: [
            { type: "input_text", text: "Captured screen" },
            { type: "input_image", image_url: "data:image/png;base64,AQID" },
          ],
        },
      ],
    },
  })
  expect(blocks(candidate.payload)).toContainEqual({
    type: "tool_result",
    tool_use_id: "call_image",
    content: [
      { type: "text", text: "Captured screen" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AQID" },
      },
    ],
  })
})

test("does not emit an executable custom call when Claude returns a non-string input", async () => {
  const source: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: "Run the tool",
    tools: [{ type: "custom", name: "exec" }],
  }
  const candidate = await adaptResponsesToMessagesCandidate({ source })
  const translated = anthropicResponseToResponsesResult(
    response([
      {
        type: "tool_use",
        id: "bad_custom",
        name: String(candidate.payload.tools?.[0]?.name),
        input: { input: { cmd: "unexpected object" } },
      },
    ]),
    source.model,
    source,
  )
  expect(translated.output.map((item) => item.type)).toEqual(["message"])
  expect(translated.output_text).toContain("unexpected object")
})

test.each([
  "capi_anthropic_v1:not valid base64",
  "capi_anthropic_v1:"
    + Buffer.from(
      '{"model":"claude-opus-5.5","blocks":[{"type":"thinking","thinking":"untrusted","signature":10}]}',
    ).toString("base64url"),
  "capi_anthropic_v1:" + "a".repeat(1024 * 1024),
])(
  "gracefully discards a malformed or oversized reasoning envelope",
  (value) => {
    expect(
      decodeAnthropicReasoningEnvelope(value, "claude-opus-5.5"),
    ).toBeUndefined()
  },
)

test.each(["spawn_agent", "send_message", "followup_task"])(
  "marks translated collaboration %s messages as plaintext and preserves their continuation",
  async (name) => {
    const source: ResponsesPayload = {
      model: "claude-opus-5.5",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              tools: [
                {
                  type: "function",
                  name,
                  parameters: {
                    type: "object",
                    properties: {
                      message: { type: "string", encrypted: true },
                      target: { type: "string" },
                    },
                  },
                },
              ],
            },
          ],
        },
        { role: "user", content: "Send the task message" },
      ],
    }
    const original = structuredClone(source)
    const candidate = await adaptResponsesToMessagesCandidate({ source })
    const tool = candidate.payload.tools?.[0]
    expect(tool?.input_schema).toEqual({
      type: "object",
      properties: {
        message: { type: "string" },
        target: { type: "string" },
      },
    })
    const translated = anthropicResponseToResponsesResult(
      response([
        {
          type: "tool_use",
          id: "call_collaboration",
          name: String(tool?.name),
          input: {
            target: "/root/worker",
            message: "Plaintext task\nsecond line",
          },
        },
      ]),
      source.model,
      source,
    )
    expect(translated.output[0]).toMatchObject({
      type: "function_call",
      namespace: "collaboration",
      name,
      call_id: "call_collaboration",
      encrypted_function_args: [],
      arguments: String.raw`{"target":"/root/worker","message":"Plaintext task\nsecond line"}`,
    })
    const continuation = await adaptResponsesToMessagesCandidate({
      source: {
        ...source,
        input: [
          ...(source.input as Array<ResponseInputItem>),
          ...(translated.output as unknown as Array<ResponseInputItem>),
          {
            type: "function_call_output",
            call_id: "call_collaboration",
            output: "delivered",
          },
        ],
      },
    })
    expect(blocks(continuation.payload)).toContainEqual({
      type: "tool_use",
      id: "call_collaboration",
      name: String(tool?.name),
      input: { target: "/root/worker", message: "Plaintext task\nsecond line" },
    })
    expect(blocks(continuation.payload)).toContainEqual({
      type: "tool_result",
      tool_use_id: "call_collaboration",
      content: "delivered",
    })
    expect(source).toEqual(original)
  },
)

test.each([
  { namespace: "unrelated", name: "send_message", encrypted: true },
  { namespace: "collaboration", name: "another_tool", encrypted: true },
  { namespace: "collaboration", name: "send_message", encrypted: false },
])(
  "does not add collaboration plaintext markers to unrelated tools",
  async ({ namespace, name, encrypted }) => {
    const source: ResponsesPayload = {
      model: "claude-opus-5.5",
      input: "Call tool",
      tools: [
        {
          type: "namespace",
          name: namespace,
          tools: [
            {
              type: "function",
              name,
              parameters: {
                type: "object",
                properties: { message: { type: "string", encrypted } },
              },
            },
          ],
        },
      ],
    }
    const candidate = await adaptResponsesToMessagesCandidate({ source })
    const tool = candidate.payload.tools?.[0]
    expect(tool?.input_schema).toMatchObject({
      properties: { message: { encrypted } },
    })
    const translated = anthropicResponseToResponsesResult(
      response([
        {
          type: "tool_use",
          id: "call_unrelated",
          name: String(tool?.name),
          input: { message: "text" },
        },
      ]),
      source.model,
      source,
    )
    expect(translated.output[0]).not.toHaveProperty("encrypted_function_args")
  },
)
