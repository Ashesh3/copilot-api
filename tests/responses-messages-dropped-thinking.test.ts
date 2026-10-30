import { afterEach, expect, spyOn, test } from "bun:test"

import { state } from "~/lib/state"
import { executePreparedResponsesMessagesBridge } from "~/routes/responses/messages-bridge"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalToken = state.copilotToken

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  state.copilotToken = originalToken
})

function installModel(): void {
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-4.7",
        name: "claude-opus-4.7",
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

async function runTurn(extra: Record<string, unknown>) {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        id: "msg_dropped",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
        ...extra,
      }),
    )) as unknown as typeof fetch
  await seedProtocolDatabase()
  return await executePreparedResponsesMessagesBridge({
    nativeOptions: { requestedModel: "claude-opus-4.7" },
    payload: {
      model: "claude-opus-4.7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Continue" }],
    },
    responseContext: { model: "claude-opus-4.7", input: "Continue" },
  })
}

test("reports replayed thinking that Messages dropped", async () => {
  installModel()
  const info = spyOn(console, "info").mockImplementation(() => {})
  try {
    const result = await runTurn({
      input_transformations: [
        {
          type: "thinking_dropped",
          path: "messages.1.content.0",
          reason: "prefix_binding_mismatch",
        },
        {
          type: "thinking_dropped",
          path: "messages.3.content.0",
          reason: "prefix_binding_mismatch",
        },
      ],
    })

    expect(result.output_text).toBe("Done.")
    const lines = info.mock.calls.map((call) => String(call[0]))
    expect(
      lines.filter((line) => line.includes("thinking_dropped")),
    ).toHaveLength(1)
    expect(lines.join("\n")).toContain(
      "claude-opus-4.7 dropped 2 replayed thinking block(s): prefix_binding_mismatch",
    )
  } finally {
    info.mockRestore()
  }
})

test("stays quiet when Messages keeps every replayed block", async () => {
  installModel()
  const info = spyOn(console, "info").mockImplementation(() => {})
  try {
    await runTurn({ input_transformations: [] })

    expect(
      info.mock.calls.some((call) =>
        String(call[0]).includes("thinking_dropped"),
      ),
    ).toBe(false)
  } finally {
    info.mockRestore()
  }
})
