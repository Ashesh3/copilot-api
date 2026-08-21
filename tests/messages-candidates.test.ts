import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { selectEvaluatedCopilotCandidate } from "~/lib/endpoint-routing"
import { prepareMessagesCandidates } from "~/routes/messages/messages-candidates"

const originalFetch = globalThis.fetch
let attachmentFetchCount = 0

const fetchMock = mock((url: string | URL | Request) => {
  attachmentFetchCount += 1
  const value = url instanceof Request ? url.url : String(url)
  const isPdf = value.endsWith(".pdf")
  return new Response(isPdf ? "%PDF-1.4 candidate" : "image", {
    headers: { "content-type": isPdf ? "application/pdf" : "image/png" },
  })
})

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  attachmentFetchCount = 0
  fetchMock.mockClear()
})

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

test("does no attachment work for unadvertised translated candidates", async () => {
  await prepareMessagesCandidates({
    source: createSource({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://attachment.test/image.png" },
            },
          ],
        },
      ],
    }),
    selectedModel: { ...selectedModel, supported_endpoints: ["/v1/messages"] },
  })

  expect(attachmentFetchCount).toBe(1)
})

test("shares one URL fetch while keeping Chat and Responses attachment semantics independent", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "keep sibling" },
            {
              type: "document",
              source: {
                type: "url",
                url: "https://attachment.test/report.pdf",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(attachmentFetchCount).toBe(1)
  expect(JSON.stringify(candidates.responses?.payload)).toContain("input_file")
  expect(JSON.stringify(candidates.responses?.payload)).toContain(
    "keep sibling",
  )
  expect(JSON.stringify(candidates.chat?.payload)).not.toContain(
    '"type":"file"',
  )
  expect(JSON.stringify(candidates.chat?.payload)).toContain("keep sibling")
  expect(candidates.chat?.check.findings).toContainEqual({
    class: "attachment",
    severity: "omitted",
  })
})

test("degrades unsupported tools per target with bounded private findings", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      tools: [
        {
          name: "lookup_private",
          input_schema: { type: "object", properties: {} },
        },
        {
          type: "web_fetch_20250910",
          name: "PRIVATE_WEB_FETCH",
          allowed_domains: ["private.example"],
        },
      ],
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(candidates.chat?.check.findings).toContainEqual({
    class: "tool_shape",
    severity: "omitted",
  })
  expect(candidates.responses?.check.findings).toContainEqual({
    class: "tool_shape",
    severity: "omitted",
  })
  expect(JSON.stringify(candidates.chat?.check.findings)).not.toContain(
    "PRIVATE_WEB_FETCH",
  )
  expect(JSON.stringify(candidates.responses?.payload)).toContain(
    "lookup_private",
  )
})

test("keys attachment cache by URL and expected PDF mode", async () => {
  const sharedUrl = "https://attachment.test/shared"
  await prepareMessagesCandidates({
    source: createSource({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: sharedUrl } },
            {
              type: "document",
              source: { type: "url", url: sharedUrl },
              title: "shared.pdf",
            },
          ],
        },
      ],
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(attachmentFetchCount).toBe(2)
})

test("propagates the caller abort reason from attachment adaptation", async () => {
  const controller = new AbortController()
  const reason = new Error("PRIVATE_ABORT_REASON")
  controller.abort(reason)

  const error = await prepareMessagesCandidates({
    source: createSource({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://attachment.test/image.png" },
            },
          ],
        },
      ],
    }),
    selectedModel: { ...selectedModel, supported_endpoints: ["/responses"] },
    signal: controller.signal,
  }).catch((caught: unknown) => caught)

  expect(error).toBe(reason)
  expect(attachmentFetchCount).toBe(0)
})

test("associates duplicate and missing tool IDs without collisions", async () => {
  const source = createSource({
    system: "system prefix",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "dup", name: "first", input: {} },
          { type: "text", text: "between" },
          { type: "tool_use", id: "dup", name: "second", input: {} },
          { type: "tool_use", id: "", name: "third", input: {} },
          {
            type: "tool_use",
            id: "messages_call_0_2",
            name: "reserved",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "dup", content: "one" },
          { type: "text", text: "interleaved" },
          { type: "tool_result", tool_use_id: "dup", content: "two" },
          { type: "tool_result", tool_use_id: "", content: "three" },
          { type: "tool_result", tool_use_id: "dup", content: "orphan" },
        ],
      },
    ],
  })
  const snapshot = structuredClone(source)
  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  const chat = JSON.stringify(candidates.chat?.payload)
  const responses = JSON.stringify(candidates.responses?.payload)
  expect(chat).toContain('"id":"dup"')
  expect(chat).toContain('"id":"messages_call_0_2_1"')
  expect(chat).toContain('"id":"messages_call_0_3"')
  expect(chat).toContain('"tool_call_id":"messages_call_0_2_1"')
  expect(responses).toContain('"call_id":"messages_call_0_2_1"')
  expect(chat).not.toContain('"tool_call_id":"dup","content":"orphan"')
  expect(responses).not.toContain('"call_id":"dup","output":"orphan"')
  expect(chat).toContain("[Orphaned tool result omitted]")
  expect(responses).toContain("[Orphaned tool result omitted]")
  expect(candidates.chat?.check.findings).toContainEqual({
    class: "tool_history",
    severity: "adapted",
  })
  expect(candidates.responses?.check.findings).toContainEqual({
    class: "tool_history",
    severity: "adapted",
  })
  expect(source).toEqual(snapshot)
})
