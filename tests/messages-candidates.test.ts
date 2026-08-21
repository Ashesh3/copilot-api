import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { selectEvaluatedCopilotCandidate } from "~/lib/endpoint-routing"
import { prepareMessagesCandidates } from "~/routes/messages/messages-candidates"

const selectedModel: Model = {
  id: "claude-current",
  name: "Claude Current",
  object: "model",
  version: "1",
  supported_endpoints: ["/v1/messages", "/responses", "/chat/completions"],
  capabilities: {
    family: "claude",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
}

function createSource(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-current",
    max_tokens: 512,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

test("builds detached endpoint-correlated Messages candidates", async () => {
  const source = createSource()
  const snapshot = structuredClone(source)
  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel,
  })

  expect(candidates.ordered.map((candidate) => candidate.endpoint)).toEqual([
    "/v1/messages",
    "/responses",
    "/chat/completions",
  ])
  candidates.native.payload.messages[0].content = "native mutation"
  expect(candidates.responses?.payload.input).not.toEqual(
    candidates.native.payload.messages,
  )
  expect(candidates.chat?.payload.messages[0]?.content).toBe("hello")
  expect(source).toEqual(snapshot)

  const selection = selectEvaluatedCopilotCandidate({
    source: "messages",
    support: {
      chat: true,
      embeddings: false,
      messages: true,
      responses: true,
      responsesWebSocket: false,
    },
    candidates: candidates.ordered,
  })
  expect("candidate" in selection && selection.candidate).toBe(
    candidates.native,
  )
})

test("Chat candidate maps controls without unconditional sampling or parallel defaults", async () => {
  const ordinary = await prepareMessagesCandidates({
    source: createSource({
      stop_sequences: ["STOP"],
      temperature: 0.4,
      top_p: 0.8,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: "high" },
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/chat/completions"],
    },
    effortOverride: "high",
  })

  expect(ordinary.chat?.payload).toMatchObject({
    stop: ["STOP"],
    temperature: 1,
    parallel_tool_calls: false,
    reasoning_effort: "high",
  })
  expect(ordinary.chat?.payload).not.toHaveProperty("top_p")

  const noControls = await prepareMessagesCandidates({
    source: createSource(),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/chat/completions"],
    },
  })
  expect(noControls.chat?.payload).not.toHaveProperty("temperature")
  expect(noControls.chat?.payload).not.toHaveProperty("parallel_tool_calls")
})

test("Responses candidate omits stops and adapts controls with bounded findings", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      stop_sequences: ["PRIVATE_STOP"],
      temperature: 0.3,
      top_p: 0.7,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", name: "answer" },
        task_budget: { type: "tokens", total: 100 },
      },
    }),
    selectedModel: { ...selectedModel, supported_endpoints: ["/responses"] },
    effortOverride: "medium",
  })

  expect(candidates.responses?.payload).toMatchObject({
    temperature: 1,
    parallel_tool_calls: false,
    reasoning: { effort: "medium" },
    text: { format: { type: "json_schema", name: "answer" } },
    task_budget: { type: "tokens", total: 100 },
    store: false,
  })
  expect(candidates.responses?.payload).not.toHaveProperty("top_p")
  expect(candidates.responses?.payload).not.toHaveProperty("stop_sequences")
  expect(candidates.responses?.check.findings).toContainEqual({
    class: "sampling",
    severity: "omitted",
  })
  expect(JSON.stringify(candidates.responses?.check.findings)).not.toContain(
    "PRIVATE_STOP",
  )
})

test("ordinary translated candidates do not invent sampling or parallel defaults", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({ temperature: 0.2, top_p: 0.9 }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(candidates.chat?.payload).toMatchObject({
    temperature: 0.2,
    top_p: 0.9,
  })
  expect(candidates.chat?.payload).not.toHaveProperty("parallel_tool_calls")
  expect(candidates.responses?.payload).toMatchObject({
    temperature: 0.2,
    top_p: 0.9,
  })
  expect(candidates.responses?.payload).not.toHaveProperty(
    "parallel_tool_calls",
  )
})
