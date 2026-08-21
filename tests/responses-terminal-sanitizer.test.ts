import { expect, test } from "bun:test"

import {
  createStreamIdTracker,
  fixStreamIds,
} from "~/routes/responses/stream-id-sync"
import { sanitizeResponsesStreamEvent } from "~/services/copilot/responses-terminal-sanitizer"

test("preserves a sparse completed terminal and fills its missing type", () => {
  const event = Object.freeze({
    event: "response.completed",
    data: JSON.stringify({
      sequence_number: 7,
      response: { id: "resp_sparse", future_status_detail: "accepted" },
    }),
  })

  const sanitized = sanitizeResponsesStreamEvent(event)

  expect(sanitized).not.toBe(event)
  expect(sanitized.event).toBe("response.completed")
  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.completed",
    sequence_number: 7,
    response: { id: "resp_sparse", future_status_detail: "accepted" },
  })
})

test("preserves future terminal fields and output item types", () => {
  const terminal = {
    type: "response.completed",
    sequence_number: 8,
    future_event_field: { enabled: true },
    response: {
      id: "resp_future",
      object: "response",
      status: "completed",
      future_response_field: ["kept"],
      output: [
        {
          id: "future_1",
          type: "future_tool_call",
          namespace: "future.tools",
          future_item_field: { version: 2 },
        },
      ],
      output_text: "unchanged",
      usage: { future_usage_field: 11 },
      error: null,
      incomplete_details: null,
    },
  }

  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify(terminal),
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual(terminal)
})

test.each(["response.failed", "response.incomplete"])(
  "preserves partial output for %s",
  (eventType) => {
    const terminal = {
      type: eventType,
      sequence_number: 9,
      response: {
        id: `resp_${eventType}`,
        status: eventType === "response.failed" ? "failed" : "incomplete",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "partial" }],
          },
          { type: "future_tool_call", state: "partial" },
        ],
        output_text: "partial",
        error: { code: "future_error", message: "upstream detail" },
        incomplete_details: { reason: "future_limit" },
      },
    }

    const sanitized = sanitizeResponsesStreamEvent({
      event: eventType,
      data: JSON.stringify(terminal),
    })

    expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual(terminal)
  },
)

test("stream ID synchronization repairs terminal item IDs without data loss", () => {
  const tracker = createStreamIdTracker()
  const added = JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "item_stable", type: "future_tool_call" },
  })
  fixStreamIds(added, "response.output_item.added", tracker)

  const synchronized = JSON.parse(
    fixStreamIds(
      JSON.stringify({
        type: "response.completed",
        future_event_field: true,
        response: {
          output: [
            {
              id: "item_changed",
              type: "future_tool_call",
              future_item_field: "kept",
            },
          ],
          future_response_field: "kept",
        },
      }),
      "response.completed",
      tracker,
    ),
  ) as Record<string, unknown>

  expect(synchronized).toEqual({
    type: "response.completed",
    future_event_field: true,
    response: {
      output: [
        {
          id: "item_stable",
          type: "future_tool_call",
          future_item_field: "kept",
        },
      ],
      future_response_field: "kept",
    },
  })
})

test("preserves a safe function call namespace in completed output", () => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp_namespaced_call",
        object: "response",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_spawn_agent",
            name: "spawn_agent",
            namespace: "collaboration",
            arguments: '{"task_name":"inspect"}',
            status: "completed",
          },
        ],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
      },
    }),
  })

  const completed = JSON.parse(sanitized.data ?? "{}") as {
    response?: { output?: Array<Record<string, unknown>> }
  }

  expect(completed.response?.output).toEqual([
    {
      type: "function_call",
      call_id: "call_spawn_agent",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments: '{"task_name":"inspect"}',
      status: "completed",
    },
  ])
})
