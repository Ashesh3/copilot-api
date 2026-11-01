import { expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { createResponsesChatToolTranslation } from "~/routes/responses/messages-tool-map"

test.each([
  {
    callId: "call_search",
    expectedId: "tsc_call_search",
    expectedCallId: "call_search",
  },
  {
    callId: undefined,
    expectedId: "tsc_call_fallback",
    expectedCallId: "call_fallback",
  },
])(
  "Chat tool search emits native-compatible item ID $expectedId",
  ({ callId, expectedId, expectedCallId }) => {
    const source: ResponsesPayload = {
      model: "chat-model",
      input: "Find audit tools",
      tools: [
        {
          type: "tool_search",
          execution: "client",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    }
    const snapshot = structuredClone(source)
    const translation = createResponsesChatToolTranslation(source)
    const searchName = translation.source.tools?.[0]?.name
    if (typeof searchName !== "string") {
      throw new TypeError("Missing translated tool search")
    }

    const restored = translation.toolMap.restoreToolCall(
      {
        ...(callId ? { id: callId } : {}),
        function: {
          name: searchName,
          arguments: '{"query":"audit","limit":2}',
        },
      },
      "call_fallback",
    )

    expect(restored).toEqual({
      id: expectedId,
      type: "tool_search_call",
      call_id: expectedCallId,
      status: "completed",
      execution: "client",
      arguments: { query: "audit", limit: 2 },
    })
    expect(source).toEqual(snapshot)
  },
)
