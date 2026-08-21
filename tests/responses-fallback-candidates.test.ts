import { expect, test } from "bun:test"

import {
  prepareResponsesCandidates,
  selectResponsesCandidate,
} from "~/routes/responses/fallback-candidates"

const selectedModel = {
  id: "gpt-test",
  name: "test",
  object: "model" as const,
  version: "1",
  supported_endpoints: ["/chat/completions", "/responses", "/v1/messages"],
  capabilities: {
    family: "gpt",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities" as const,
    supports: {},
    tokenizer: "o200k_base",
    type: "chat" as const,
  },
}

test("builds independent endpoint-correlated Responses candidates", async () => {
  const source = {
    source: {
      model: "gpt-source",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [{ type: "future_tool", marker: "source-only" }],
      store: false,
    },
    normalizationClasses: [],
  }
  const nativeBody = {
    body: {
      model: "gpt-test",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [{ type: "future_tool", marker: "native-only" }],
      store: false,
    },
    normalizationClasses: [],
  }

  const candidates = await prepareResponsesCandidates({
    preservedSource: source,
    adaptationSource: { ...source.source, model: "gpt-test" },
    nativeBody,
    selectedModel,
  })

  expect(candidates.native.payload).toEqual(nativeBody.body)
  expect(candidates.native.payload).not.toBe(nativeBody.body)
  expect(candidates.chat.payload.tools).toBeUndefined()
  expect(candidates.messages.payload.tools).toBeUndefined()
  ;(candidates.native.payload.tools?.[0] as Record<string, unknown>).marker =
    "changed"
  expect(nativeBody.body.tools[0].marker).toBe("native-only")
  expect(source.source.tools[0].marker).toBe("source-only")

  const selection = selectResponsesCandidate({ candidates, selectedModel })
  if ("code" in selection) throw new Error("selection unexpectedly failed")
  expect(selection.candidate).toBe(candidates.native)
  expect(selection.candidate.payload).toBe(candidates.native.payload)
})

test("selects the cheapest viable translated candidate when native is unavailable", async () => {
  const source = {
    source: {
      model: "gpt-test",
      input: [{ type: "message", role: "user", content: "hello" }],
      store: false,
    },
    normalizationClasses: [],
  }
  const model = {
    ...selectedModel,
    supported_endpoints: ["/chat/completions", "/v1/messages"],
  }
  const candidates = await prepareResponsesCandidates({
    preservedSource: source,
    adaptationSource: source.source,
    nativeBody: { body: source.source, normalizationClasses: [] },
    selectedModel: model,
  })

  const selection = selectResponsesCandidate({
    candidates,
    selectedModel: model,
  })
  if ("code" in selection) throw new Error("selection unexpectedly failed")
  expect(selection.candidate.endpoint).toBe("/chat/completions")
})
