import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  parseResponsesWebSocketFrame,
  resolveResponsesContinuation,
} from "~/routes/responses/websocket-protocol"

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

describe("resolveResponsesContinuation", () => {
  test("starts a new thread when previous_response_id is omitted", () => {
    const payload: ResponsesPayload = {
      model: "gpt-current",
      input: "hello",
    }

    expect(resolveResponsesContinuation(new Map(), payload)).toEqual({
      ok: true,
      payload: { model: "gpt-current", input: "hello" },
    })
    expect(payload).toEqual({ model: "gpt-current", input: "hello" })
  })

  test("immutably rehydrates a known connection-local response id", () => {
    const snapshot: ResponsesPayload = {
      model: "gpt-current",
      instructions: "stable",
      input: [{ role: "user", content: "first" }],
      tools: [{ type: "function", name: "run" }],
    }
    const payload: ResponsesPayload = {
      model: "gpt-current",
      previous_response_id: "resp_1",
      input: [{ role: "user", content: "second" }],
    }

    const result = resolveResponsesContinuation(
      new Map([["resp_1", snapshot]]),
      payload,
    )

    expect(result).toEqual({
      ok: true,
      payload: {
        model: "gpt-current",
        instructions: "stable",
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
        previous_response_id: undefined,
        tools: [{ type: "function", name: "run" }],
        generate: undefined,
      },
    })
    expect(snapshot).toEqual({
      model: "gpt-current",
      instructions: "stable",
      input: [{ role: "user", content: "first" }],
      tools: [{ type: "function", name: "run" }],
    })
    expect(payload).toEqual({
      model: "gpt-current",
      previous_response_id: "resp_1",
      input: [{ role: "user", content: "second" }],
    })
  })

  test("returns previous_response_not_found for a stale local id", () => {
    expect(
      resolveResponsesContinuation(new Map(), {
        model: "gpt-current",
        input: "delta",
        previous_response_id: "resp_stale",
      }),
    ).toEqual({
      ok: false,
      code: "previous_response_not_found",
      message:
        "The previous response is not available on this WebSocket connection.",
      status: 400,
    })
  })

  test.each([
    [null, "previous_response_id must be a string"],
    ["", "previous_response_id must not be empty"],
    [17, "previous_response_id must be a string"],
  ] as const)("rejects malformed previous_response_id %p", (value, message) => {
    expect(
      resolveResponsesContinuation(new Map(), {
        model: "gpt-current",
        input: "delta",
        previous_response_id: value,
      } as ResponsesPayload),
    ).toEqual({
      ok: false,
      code: "invalid_request_error",
      message,
      status: 400,
    })
  })
})

describe("parseResponsesWebSocketFrame hostile input", () => {
  test.each([
    { name: "null", type: null as unknown },
    { name: "number", type: 7 as unknown },
    { name: "array", type: [] as unknown },
    { name: "object", type: {} as unknown },
    { name: "shadowed toString", type: { toString: null } as unknown },
    {
      name: "shadowed valueOf and toString",
      type: { toString: {}, valueOf: {} } as unknown,
    },
  ])("rejects hostile $name message types without coercion", ({ type }) => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({ type, model: "gpt-current" }),
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "bad_request",
        message: "Unsupported message type",
        status: 400,
        type: "invalid_request_error",
      },
    })
  })
})

describe("parseResponsesWebSocketFrame attribution precedence", () => {
  test.each(["agent", "user"] as const)(
    "uses top-level initiator %s over the header envelope",
    (initiator) => {
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          headers: { "X-Initiator": initiator === "agent" ? "user" : "agent" },
          initiator,
        }),
      )

      expect(result).toMatchObject({ ok: true, value: { initiator } })
    },
  )

  test.each([null, false, "assistant", 1])(
    "rejects invalid present top-level initiator %p instead of retaining header",
    (initiator) => {
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          headers: { "X-Initiator": "agent" },
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

  test.each([
    {
      agent_task_id: "",
      expected: { parentAgentId: "parent-header" },
      name: "blank task id",
    },
    {
      agent_task_id: 7,
      expected: { parentAgentId: "parent-header" },
      name: "non-string task id",
    },
    {
      agent_task_id: "x".repeat(1025),
      expected: { parentAgentId: "parent-header" },
      name: "oversized task id",
    },
    {
      agent_task_id: "bad\nvalue",
      expected: { parentAgentId: "parent-header" },
      name: "control-character task id",
    },
    {
      expected: {
        agentTaskId: "task-header",
        parentAgentId: "parent-header",
      },
      name: "absent task id",
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "blank parent id",
      parent_agent_id: " ",
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "non-string parent id",
      parent_agent_id: false,
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "oversized parent id",
      parent_agent_id: "x".repeat(1025),
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "control-character parent id",
      parent_agent_id: "bad\rvalue",
    },
  ])(
    "applies explicit top-level precedence for $name",
    ({ expected, ...topLevel }) => {
      const { name: _name, ...frameFields } = topLevel
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          headers: {
            "X-Agent-Task-Id": "task-header",
            "X-Parent-Agent-Id": "parent-header",
          },
          ...frameFields,
        }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.attribution).toEqual(expected)
    },
  )
})
