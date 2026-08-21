import { describe, expect, test } from "bun:test"

import { adaptResponsesToChatCandidate } from "~/routes/responses/responses-chat-adapter"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "~/services/copilot/compaction-payload"

describe("Responses Chat fallback candidate", () => {
  test("adapts future items and collision-safe tool history without fatal rejection", async () => {
    const source = {
      model: "gpt-test",
      instructions: "system context",
      input: [
        { type: "future_item", payload: "private-future-value" },
        {
          type: "function_call",
          call_id: "responses_call_0_0",
          name: "one",
          arguments: "not-json",
        },
        { type: "message", role: "future-role", content: "keep me" },
        { type: "function_call", name: "two", arguments: { x: 1 } },
        {
          type: "function_call_output",
          call_id: "responses_call_0_0",
          output: "first",
        },
        {
          type: "function_call_output",
          call_id: "responses_call_0_0",
          output: "duplicate",
        },
      ],
      tools: [
        { type: "custom", name: "apply_patch", format: { type: "grammar" } },
        { type: "future_tool", name: "private-tool" },
      ],
      tool_choice: { type: "future_choice", name: "private-choice" },
      temperature: 0.2,
      top_p: 0.8,
      prompt_cache_key: "private-cache",
      stream: false,
    }

    const candidate = await adaptResponsesToChatCandidate({ source })

    expect(candidate.endpoint).toBe("/chat/completions")
    expect(candidate.check.supported).toBe(true)
    expect(
      candidate.payload.messages.some(
        (message) => message.content === "[Future Responses item]",
      ),
    ).toBe(true)
    expect(
      candidate.payload.messages.some(
        (message) => message.content === "keep me",
      ),
    ).toBe(true)
    expect(
      candidate.payload.messages.some(
        (message) =>
          typeof message.content === "string"
          && message.content.includes("duplicate"),
      ),
    ).toBe(true)
    const ids = candidate.payload.messages.flatMap(
      (message) => message.tool_calls?.map((call) => call.id) ?? [],
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("responses_call_0_0")
    expect(
      candidate.payload.tools?.some(
        (tool) => tool.function.name === "apply_patch",
      ),
    ).toBe(true)
    expect(candidate.payload.tool_choice).toBe("auto")
    expect(candidate.payload.top_p).toBeUndefined()
    expect(JSON.stringify(candidate.check)).not.toContain("private-")
    expect(source.tools[0].type).toBe("custom")
  })

  test("marks only an empty completed Chat candidate fatal", async () => {
    const candidate = await adaptResponsesToChatCandidate({
      source: {
        model: "gpt-test",
        input: [],
        tools: [{ type: "future_tool" }],
      },
    })

    expect(candidate.check.supported).toBe(false)
    expect(candidate.check.findings[0]).toEqual({
      class: "message_shape",
      severity: "fatal",
    })
  })

  test("fits reducible compaction after preserving custom history without mutating source", async () => {
    const huge = "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 1024)
    const source = {
      model: "gpt-test",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_compact",
          name: "exec",
          input: "run",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_compact",
          output: "done",
        },
        {
          type: "function_call",
          call_id: "call_large",
          name: "lookup",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_large", output: huge },
      ],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
      },
    }

    const candidate = await adaptResponsesToChatCandidate({ source })

    expect(
      Buffer.byteLength(JSON.stringify(candidate.payload)),
    ).toBeLessThanOrEqual(COMPACTION_PAYLOAD_MAX_BYTES)
    expect(JSON.stringify(candidate.payload)).toContain("call_compact")
    expect(JSON.stringify(source)).toContain(huge)
  })
})
