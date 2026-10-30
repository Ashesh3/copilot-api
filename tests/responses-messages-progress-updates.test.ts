import { afterEach, expect, mock, test } from "bun:test"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  adaptResponsesToMessagesCandidate,
  anthropicResponseToResponsesResult,
  executePreparedResponsesMessagesBridge,
} from "~/routes/responses/messages-bridge"
import {
  INTERRUPTED_PROGRESS_UPDATE_TEXT,
  resetProgressUpdatesRejectionsForTest,
  THINKING_DISPLAY_UPDATES_BETA,
} from "~/routes/responses/messages-progress-updates"
import { decodeAnthropicReasoningEnvelope } from "~/routes/responses/messages-reasoning-provenance"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

interface CapturedRequest {
  body: Record<string, unknown>
  headers: Headers
}

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalAccountType = state.accountType

const EXEC_TOOL = {
  type: "function" as const,
  name: "exec_command",
  parameters: { type: "object", properties: { cmd: { type: "string" } } },
}

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  state.accountType = originalAccountType
  resetProgressUpdatesRejectionsForTest()
})

function installMessagesModel(id: string): void {
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.models = {
    object: "list",
    data: [
      {
        id,
        name: id,
        object: "model",
        version: "1",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 4096 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }
}

function installUpstream(responses: Array<Response>): Array<CapturedRequest> {
  const captured: Array<CapturedRequest> = []
  globalThis.fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        body: JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      })
      return Promise.resolve(
        responses.shift()
          ?? Response.json({ error: "unexpected request" }, { status: 500 }),
      )
    },
  ) as unknown as typeof fetch
  return captured
}

function anthropicMessage(
  content: Array<Record<string, unknown>>,
  stopReason: AnthropicResponse["stop_reason"],
): AnthropicResponse {
  return {
    id: "msg_updates",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: content as AnthropicResponse["content"],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

function messagesPayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-opus-5.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Fix the failing test" }],
    tools: [
      {
        name: "exec_command",
        input_schema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  }
}

function responseContext(model = "claude-opus-5.5"): ResponsesPayload {
  return { model, input: "Fix the failing test", tools: [EXEC_TOOL] }
}

function reasoningBlocks(item: ResponseOutputItem | undefined): unknown {
  return decodeAnthropicReasoningEnvelope(
    (item as { encrypted_content?: unknown } | undefined)?.encrypted_content,
    "claude-opus-5.5",
  )
}

const TOOL_TURN: Array<AnthropicAssistantContentBlock> = [
  { type: "thinking", thinking: "", signature: "sig-reasoning" },
  {
    type: "thinking",
    thinking: "Running the failing test first.",
    signature: "sig-update",
  },
  {
    type: "tool_use",
    id: "toolu_1",
    name: "exec_command",
    input: { cmd: "bun test" },
  },
]

test("asks Claude 5.5 for readable progress updates and shows them as commentary", async () => {
  installMessagesModel("claude-opus-5.5")
  const captured = installUpstream([
    Response.json(anthropicMessage(TOOL_TURN, "tool_use")),
  ])
  await seedProtocolDatabase()

  const result = await executePreparedResponsesMessagesBridge({
    nativeOptions: {
      anthropicBeta: "interleaved-thinking-2025-05-14",
      requestedModel: "claude-opus-5.5",
    },
    payload: messagesPayload(),
    responseContext: responseContext(),
  })

  expect(captured).toHaveLength(1)
  expect(captured[0]?.body.thinking).toEqual({
    type: "adaptive",
    display: "updates",
  })
  expect(captured[0]?.headers.get("anthropic-beta")).toBe(
    `interleaved-thinking-2025-05-14,${THINKING_DISPLAY_UPDATES_BETA}`,
  )
  expect(result.output.map((item) => item.type)).toEqual([
    "reasoning",
    "reasoning",
    "message",
    "function_call",
  ])
  expect(result.output[0]).toMatchObject({ summary: [] })
  expect(result.output[1]).toMatchObject({ summary: [] })
  expect(result.output[2]).toMatchObject({
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "Running the failing test first." }],
  })
  expect(result.output[3]).toMatchObject({ call_id: "toolu_1" })
  expect(result.output_text).toBe("Running the failing test first.")
  expect(reasoningBlocks(result.output[1])).toEqual([TOOL_TURN[1]])
})

test.each([
  {
    name: "another Claude model",
    compaction: false,
    payload: messagesPayload({ model: "claude-opus-4.7" }),
  },
  {
    name: "a compaction summary",
    compaction: true,
    payload: messagesPayload(),
  },
  {
    name: "disabled thinking",
    compaction: false,
    payload: messagesPayload({ thinking: { type: "disabled" } }),
  },
  {
    name: "forced tool use",
    compaction: false,
    payload: messagesPayload({ tool_choice: { type: "any" } }),
  },
])(
  "does not ask for progress updates for $name",
  async ({ compaction, payload }) => {
    installMessagesModel(payload.model)
    const captured = installUpstream([
      Response.json(
        anthropicMessage(
          [
            { type: "thinking", thinking: "Weighing options.", signature: "s" },
            { type: "text", text: "Done." },
          ],
          "end_turn",
        ),
      ),
    ])
    await seedProtocolDatabase()

    const result = await executePreparedResponsesMessagesBridge({
      compaction,
      nativeOptions: { requestedModel: payload.model },
      payload,
      responseContext: responseContext(payload.model),
    })

    expect(captured[0]?.body.thinking).toEqual(payload.thinking)
    expect(captured[0]?.headers.get("anthropic-beta")).toBeNull()
    expect(result.output).toMatchObject([
      { summary: [{ type: "summary_text", text: "Weighing options." }] },
      { phase: "final_answer", content: [{ text: "Done." }] },
    ])
  },
)

test("resends once without progress updates when Copilot rejects them", async () => {
  installMessagesModel("claude-opus-5.5")
  const captured = installUpstream([
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "thinking.adaptive.display: Input should be 'summarized' or 'omitted'",
        },
      },
      { status: 400 },
    ),
    Response.json(
      anthropicMessage([{ type: "text", text: "Done." }], "end_turn"),
    ),
    Response.json(
      anthropicMessage([{ type: "text", text: "Again." }], "end_turn"),
    ),
  ])
  await seedProtocolDatabase()
  // WebSocket turns disable compatibility retries; this resend is still owned
  // by the bridge because the bridge added the rejected display.
  const nativeOptions = {
    allowCompatibilityRetry: false,
    requestedModel: "claude-opus-5.5",
  }

  const result = await executePreparedResponsesMessagesBridge({
    nativeOptions,
    payload: messagesPayload(),
    responseContext: responseContext(),
  })

  expect(captured).toHaveLength(2)
  expect(captured[0]?.body.thinking).toEqual({
    type: "adaptive",
    display: "updates",
  })
  expect(captured[1]?.body).not.toHaveProperty("thinking")
  expect(captured[1]?.headers.get("anthropic-beta")).toBeNull()
  expect(result.output_text).toBe("Done.")

  const next = await executePreparedResponsesMessagesBridge({
    nativeOptions,
    payload: messagesPayload(),
    responseContext: responseContext(),
  })

  expect(captured).toHaveLength(3)
  expect(captured[2]?.body).not.toHaveProperty("thinking")
  expect(next.output_text).toBe("Again.")
})

test("does not resend unrelated Messages failures", async () => {
  installMessagesModel("claude-opus-5.5")
  const captured = installUpstream([
    Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long" },
      },
      { status: 400 },
    ),
  ])
  await seedProtocolDatabase()

  const error: unknown = await executePreparedResponsesMessagesBridge({
    nativeOptions: { requestedModel: "claude-opus-5.5" },
    payload: messagesPayload(),
    responseContext: responseContext(),
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(captured).toHaveLength(1)
})

test("presents a turn's text as the final answer after commentary updates", () => {
  const result = anthropicResponseToResponsesResult(
    anthropicMessage(
      [
        { type: "thinking", thinking: "", signature: "sig-a" },
        { type: "thinking", thinking: "Checked the logs.", signature: "sig-b" },
        { type: "text", text: "All green." },
      ],
      "end_turn",
    ),
    "claude-opus-5.5",
    responseContext(),
    { progressUpdates: true },
  )

  expect(result.output).toMatchObject([
    { type: "reasoning", summary: [] },
    { type: "reasoning", summary: [] },
    { phase: "commentary", content: [{ text: "Checked the logs." }] },
    { phase: "final_answer", content: [{ text: "All green." }] },
  ])
  expect(result.output_text).toBe("Checked the logs.\n\nAll green.")
})

test("presents the last update as the answer when a turn ends without text", () => {
  const result = anthropicResponseToResponsesResult(
    anthropicMessage(
      [
        { type: "thinking", thinking: "", signature: "sig-a" },
        { type: "thinking", thinking: "Tests pass.", signature: "sig-b" },
        { type: "thinking", thinking: "", signature: "sig-c" },
        { type: "thinking", thinking: "Merged the fix.", signature: "sig-d" },
      ],
      "end_turn",
    ),
    "claude-opus-5.5",
    responseContext(),
    { progressUpdates: true },
  )

  expect(
    result.output
      .filter((item) => item.type === "message")
      .map((item) => [
        item.phase,
        (item.content?.[0] as { text?: string } | undefined)?.text,
      ]),
  ).toEqual([
    ["commentary", "Tests pass."],
    ["final_answer", "Merged the fix."],
  ])
  expect(result.output_text).toBe("Tests pass.\n\nMerged the fix.")
})

test("keeps the interruption notice in signed state without showing it", () => {
  const interrupted = {
    type: "thinking",
    thinking: INTERRUPTED_PROGRESS_UPDATE_TEXT,
    signature: "sig-cut",
  }
  const result = anthropicResponseToResponsesResult(
    anthropicMessage(
      [{ type: "thinking", thinking: "", signature: "sig-a" }, interrupted],
      "max_tokens",
    ),
    "claude-opus-5.5",
    responseContext(),
    { progressUpdates: true },
  )

  expect(result.output.map((item) => item.type)).toEqual([
    "reasoning",
    "reasoning",
  ])
  expect(result.output[1]).toMatchObject({ summary: [] })
  expect(reasoningBlocks(result.output[1])).toEqual([interrupted])
  expect(result.output_text).toBe("")
})

test("replays a progress-update turn exactly as Claude produced it", async () => {
  const result = anthropicResponseToResponsesResult(
    anthropicMessage(TOOL_TURN, "tool_use"),
    "claude-opus-5.5",
    responseContext(),
    { progressUpdates: true },
  )
  const input: Array<ResponseInputItem> = [
    { type: "message", role: "user", content: "Fix the failing test" },
    ...(result.output as Array<ResponseInputItem>),
    { type: "function_call_output", call_id: "toolu_1", output: "1 passed" },
  ]

  const candidate = await adaptResponsesToMessagesCandidate({
    source: { model: "claude-opus-5.5", input, tools: [EXEC_TOOL] },
  })

  expect(candidate.payload.messages).toEqual([
    {
      role: "user",
      content: [{ type: "text", text: "Fix the failing test" }],
    },
    { role: "assistant", content: TOOL_TURN },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "1 passed" },
      ],
    },
  ])
})

test("replays assistant text that differs from the preceding update", async () => {
  const result = anthropicResponseToResponsesResult(
    anthropicMessage(TOOL_TURN, "tool_use"),
    "claude-opus-5.5",
    responseContext(),
    { progressUpdates: true },
  )
  const edited = result.output.map((item) =>
    item.type === "message" ?
      {
        ...item,
        content: [{ type: "output_text", text: "Edited.", annotations: [] }],
      }
    : item,
  )

  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      model: "claude-opus-5.5",
      input: [
        { type: "message", role: "user", content: "Fix the failing test" },
        ...(edited as Array<ResponseInputItem>),
        { type: "function_call_output", call_id: "toolu_1", output: "ok" },
      ],
      tools: [EXEC_TOOL],
    },
  })

  expect(JSON.stringify(candidate.payload.messages)).toContain(
    '{"type":"text","text":"Edited."}',
  )
})
