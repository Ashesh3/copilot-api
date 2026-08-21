import { expect, test } from "bun:test"

import type { PreparedChatCompletionsSource } from "~/routes/chat-completions/chat-contract"
import type { Model } from "~/services/copilot/get-models"

import {
  getModelEndpointSupport,
  selectEvaluatedCopilotCandidate,
} from "~/lib/endpoint-routing"
import {
  orderPreparedChatCandidates,
  prepareChatCandidates,
} from "~/routes/chat-completions/chat-candidates"
import {
  createCopilotGoogleChatCompletion,
  type GoogleChatCompletionFactory,
} from "~/routes/google-ai/chat-completion"
import { prepareGoogleRequest } from "~/routes/google-ai/google-request-normalization"
import { adaptGoogleToChatCandidate } from "~/routes/google-ai/request-translation"

const model = {
  id: "test-model",
  name: "test-model",
  vendor: "openai",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions", "/responses"],
  capabilities: {
    family: "test",
    limits: { max_context_window_tokens: 1000, max_output_tokens: 100 },
    supports: {},
  },
} as Model

test("builds only advertised Chat candidates and preserves source findings once", async () => {
  const google = await adaptGoogleToChatCandidate({
    source: prepareGoogleRequest({
      contents: [{ role: "future", parts: [{ text: "hello" }] }],
    }),
    finalModel: model.id,
    stream: false,
  })
  const candidates = await prepareChatCandidates({
    source: google.payload as unknown as PreparedChatCompletionsSource,
    sourceFindings: google.check.findings,
    selectedModel: model,
    nativeMessagesOptions: {},
    support: getModelEndpointSupport(model),
  })
  expect(candidates.chat?.endpoint).toBe("/chat/completions")
  expect(candidates.responses?.endpoint).toBe("/responses")
  expect(candidates.messages).toBeUndefined()
  expect(candidates.chat?.check.findings).toContainEqual({
    class: "message_role",
    severity: "adapted",
  })
  expect(
    candidates.chat?.check.findings.filter(
      (finding) => finding.class === "message_role",
    ),
  ).toHaveLength(1)
})

test("reuses shared candidate ordering and selector returns exact candidate", async () => {
  const google = await adaptGoogleToChatCandidate({
    source: prepareGoogleRequest({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
    finalModel: model.id,
    stream: false,
  })
  const candidates = await prepareChatCandidates({
    source: google.payload as unknown as PreparedChatCompletionsSource,
    sourceFindings: google.check.findings,
    selectedModel: model,
    nativeMessagesOptions: {},
    support: { ...getModelEndpointSupport(model), chat: false },
  })
  const ordered = orderPreparedChatCandidates({
    candidates,
    selectedModel: model,
    source: google.payload as unknown as PreparedChatCompletionsSource,
  })
  const selected = selectEvaluatedCopilotCandidate({
    source: "chat",
    support: { ...getModelEndpointSupport(model), chat: false },
    candidates: ordered,
  })
  expect("candidate" in selected).toBe(true)
  if ("candidate" in selected) {
    const responses = candidates.responses
    if (!responses) throw new Error("Expected Responses candidate")
    expect(selected.candidate).toBe(responses)
    expect(selected.candidate.payload).toBe(responses.payload)
  }
})

test("exports a narrow provider completion factory contract", async () => {
  const calls: Array<unknown> = []
  const factory: GoogleChatCompletionFactory = (payload, options) => {
    calls.push({ payload, signal: options.signal })
    return Promise.resolve({
      processedPayload: structuredClone(payload),
      response: {
        id: "id",
        object: "chat.completion",
        created: 1,
        model: "upstream",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      },
    })
  }
  const payload = {
    model: "public",
    messages: [{ role: "user" as const, content: "hello" }],
  }
  const result = await factory(payload, {})
  expect(calls).toEqual([{ payload, signal: undefined }])
  expect(result.processedPayload).not.toBe(payload)
  expect(typeof createCopilotGoogleChatCompletion).toBe("function")
})
