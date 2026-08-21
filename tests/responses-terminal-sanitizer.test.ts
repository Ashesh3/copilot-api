import { expect, test } from "bun:test"

import { sanitizeResponsesStreamEvent } from "~/services/copilot/responses-terminal-sanitizer"

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
