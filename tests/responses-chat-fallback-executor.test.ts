import { expect, test } from "bun:test"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { resolvePreparedResponsesWebSearchCalls } from "~/routes/responses/chat-fallback-completion"

function completion(callId?: string): ChatCompletionResponse {
  return {
    id: "chat",
    object: "chat.completion",
    created: 1,
    model: "model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: callId ? null : "done",
          ...(callId ?
            {
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"q"}' },
                },
              ],
            }
          : {}),
        },
        finish_reason: callId ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
  }
}

test("continues web search from every factory processed payload", async () => {
  const seen: Array<ChatCompletionsPayload> = []
  const processedMarkers = ["processed-one", "processed-two"]
  let call = 0
  const initialPayload: ChatCompletionsPayload = {
    model: "model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  }
  const factory = (payload: ChatCompletionsPayload) => {
    seen.push(structuredClone(payload))
    const marker = processedMarkers[call]
    const processedPayload = {
      ...payload,
      messages: [
        ...payload.messages,
        { role: "system" as const, content: marker },
      ],
    }
    call += 1
    return Promise.resolve({
      processedPayload,
      response: call === 1 ? completion("call-two") : completion(),
    })
  }

  const result = await resolvePreparedResponsesWebSearchCalls({
    initial: {
      processedPayload: initialPayload,
      response: completion("call-one"),
    },
    completionFactory: factory,
    webSearch: () => Promise.resolve("result"),
  })

  expect(result.choices[0]?.message.content).toBe("done")
  expect(seen).toHaveLength(2)
  expect(JSON.stringify(seen[1])).toContain("processed-one")
})
