import { describe, expect, test } from "bun:test"

import { parseResponsesWebSocketFrame } from "~/routes/responses/websocket-protocol"

describe("parseResponsesWebSocketFrame", () => {
  test("merges payload fields while keeping the protocol envelope out", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-top",
        input: "hello",
        headers: {
          "X-Interaction-Type": "conversation-subagent",
          "X-Client-Machine-Id": "machine-1",
          "X-Initiator": "user",
          Authorization: "Bearer must-not-pass",
          "Copilot-Session-Token": "must-not-pass",
        },
        initiator: "agent",
        agent_task_id: "task-top",
        parent_agent_id: "parent-top",
        response: {
          model: "gpt-nested",
          stream: true,
          max_output_tokens: 128,
          headers: { must: "not-pass" },
          initiator: "user",
          agent_task_id: "task-nested",
          parent_agent_id: "parent-nested",
          type: "nested-envelope",
        },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {
          agentTaskId: "task-top",
          clientMachineId: "machine-1",
          interactionType: "conversation-subagent",
          parentAgentId: "parent-top",
        },
        initiator: "agent",
        payload: {
          input: "hello",
          max_output_tokens: 128,
          model: "gpt-nested",
          stream: true,
        },
        requestedModel: "gpt-nested",
      },
    })
  })

  test("uses typed header attribution unless a top-level task field overrides it", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        headers: {
          "X-Agent-Task-Id": "task-header",
          "X-Parent-Agent-Id": "parent-header",
          "X-Unreviewed-Header": "must-not-pass",
        },
        agent_task_id: "task-top",
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {
          agentTaskId: "task-top",
          parentAgentId: "parent-header",
        },
        payload: { model: "gpt-current" },
        requestedModel: "gpt-current",
      },
    })
  })

  test("uses a valid header initiator when the top-level override is absent", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        headers: { "X-Initiator": "user" },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {},
        initiator: "user",
        payload: { model: "gpt-current" },
        requestedModel: "gpt-current",
      },
    })
  })

  test("ignores malformed and secret frame headers", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        headers: {
          "Bad\nName": "value",
          "X-Agent-Task-Id": "bad\nvalue",
          Authorization: "Bearer must-not-pass",
          "Copilot-Session-Token": "must-not-pass",
        },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {},
        payload: { model: "gpt-current" },
        requestedModel: "gpt-current",
      },
    })
  })

  test.each([
    [Buffer.from("binary"), "Binary frames not supported"],
    [new Uint8Array([1, 2, 3]), "Binary frames not supported"],
    ["not-json", "Invalid JSON"],
    ["null", "JSON message must be an object"],
    [JSON.stringify([]), "JSON message must be an object"],
    [
      JSON.stringify({ type: "response.processed" }),
      "Unsupported message type",
    ],
    [JSON.stringify({ type: "other" }), "Unsupported message type"],
  ] as const)(
    "returns a recoverable parse error for %p",
    (message, expected) => {
      const result = parseResponsesWebSocketFrame(message)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatchObject({
          status: 400,
          type: "invalid_request_error",
        })
        expect(result.error.message).toContain(expected)
      }
    },
  )

  test.each([
    {
      frame: { stream: false },
      name: "top-level",
    },
    {
      frame: { stream: true, response: { stream: false } },
      name: "nested",
    },
    {
      frame: { stream: false, response: { stream: true } },
      name: "overridden top-level",
    },
  ])("rejects explicit $name stream false", ({ frame }) => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        input: "hello",
        ...frame,
      }),
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_request_error",
        message: "Responses WebSocket requests must stream.",
        status: 400,
        type: "invalid_request_error",
      },
    })
  })

  test.each([null, false, "assistant", 1])(
    "rejects invalid top-level initiator %p",
    (initiator) => {
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          initiator,
        }),
      )

      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid_request_error",
          message: "Responses WebSocket initiator must be user or agent.",
          status: 400,
          type: "invalid_request_error",
        },
      })
    },
  )
})
