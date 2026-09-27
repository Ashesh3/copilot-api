import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import { state } from "~/lib/state"

import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  collectSSEEvents,
  TEST_TIMEOUT,
} from "./setup"

interface AnthropicContentBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: unknown
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}

interface AnthropicMessageResponse {
  id: string
  type: string
  role: string
  content: Array<AnthropicContentBlock>
  stop_reason: string | null
  usage: AnthropicUsage
}

interface AnthropicStreamEvent {
  type: string
  message?: {
    id: string
    type: string
    role: string
    usage?: AnthropicUsage
  }
  delta?: {
    stop_reason?: string
    type?: string
    text?: string
  }
  content_block?: AnthropicContentBlock
  index?: number
  usage?: AnthropicUsage
}

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

describe("POST /v1/messages - basic", () => {
  test(
    "simple text message (non-streaming)",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 20,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      expect(body.id).toBeDefined()
      expect(body.type).toBe("message")
      expect(body.role).toBe("assistant")
      expect(Array.isArray(body.content)).toBe(true)
      expect(body.content.length).toBeGreaterThan(0)
      expect(body.content[0].type).toBe("text")
      expect(body.content[0].text).toBeTruthy()
      expect(body.stop_reason).toBeDefined()
      expect(body.usage).toBeDefined()
      expect(body.usage.input_tokens).toBeGreaterThan(0)
      expect(body.usage.output_tokens).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "simple text message (streaming)",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 20,
        stream: true,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const events = await collectSSEEvents(res)
      expect(events.length).toBeGreaterThan(0)
      const eventTypes = events.map((e) => e.event)
      expect(eventTypes).toContain("message_start")
      expect(eventTypes).toContain("content_block_start")
      expect(eventTypes).toContain("content_block_delta")
      expect(eventTypes).toContain("content_block_stop")
      expect(eventTypes).toContain("message_delta")
      expect(eventTypes).toContain("message_stop")
    },
    TEST_TIMEOUT,
  )

  test(
    "multi-turn conversation",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "My name is Bob." },
          { role: "assistant", content: "Nice to meet you, Bob!" },
          { role: "user", content: "What is my name?" },
        ],
        max_tokens: 20,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      const text = body.content[0].text?.toLowerCase() ?? ""
      expect(text).toContain("bob")
    },
    TEST_TIMEOUT,
  )

  test(
    "system prompt (string)",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        system: "Always respond in exactly one word.",
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 10,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      expect(body.content[0].text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "system prompt (array of text blocks)",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        system: [{ type: "text", text: "Always respond in exactly one word." }],
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 10,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      expect(body.content[0].text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )
})

describe("POST /v1/messages - streaming details", () => {
  test(
    "streaming events have correct structure",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hi." }],
        max_tokens: 10,
        stream: true,
      })
      expect(res.status).toBe(200)
      const events = await collectSSEEvents(res)

      // Parse and validate message_start event
      const messageStartEvent = events.find((e) => e.event === "message_start")
      expect(messageStartEvent).toBeDefined()
      const messageStart = JSON.parse(
        messageStartEvent?.data ?? "{}",
      ) as AnthropicStreamEvent
      expect(messageStart.message).toBeDefined()
      expect(messageStart.message?.id).toBeDefined()
      expect(messageStart.message?.type).toBe("message")
      expect(messageStart.message?.role).toBe("assistant")

      // Parse and validate message_delta event
      const messageDeltaEvent = events.find((e) => e.event === "message_delta")
      expect(messageDeltaEvent).toBeDefined()
      const messageDelta = JSON.parse(
        messageDeltaEvent?.data ?? "{}",
      ) as AnthropicStreamEvent
      expect(messageDelta.delta).toBeDefined()
      expect(messageDelta.delta?.stop_reason).toBeDefined()
    },
    TEST_TIMEOUT,
  )
})

describe("POST /v1/messages - tools and params", () => {
  test(
    "tool use (non-streaming)",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What is the weather in London?" }],
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather in a location",
            input_schema: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
          },
        ],
        tool_choice: { type: "auto" },
        max_tokens: 200,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      if (body.stop_reason === "tool_use") {
        const toolUse = body.content.find((b) => b.type === "tool_use")
        expect(toolUse).toBeDefined()
        expect(toolUse?.name).toBe("get_weather")
        expect(toolUse?.id).toBeDefined()
        expect(toolUse?.input).toBeDefined()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "tool use (streaming)",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What is the weather in Berlin?" }],
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather in a location",
            input_schema: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
          },
        ],
        tool_choice: { type: "auto" },
        max_tokens: 200,
        stream: true,
      })
      expect(res.status).toBe(200)
      const events = await collectSSEEvents(res)
      expect(events.length).toBeGreaterThan(0)
      const eventTypes = events.map((e) => e.event)
      expect(eventTypes).toContain("message_start")
      expect(eventTypes).toContain("message_stop")
    },
    TEST_TIMEOUT,
  )

  test(
    "max_tokens parameter respected",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: "Write a very long essay about the history of computing.",
          },
        ],
        max_tokens: 5,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      // With max_tokens=5, output should be very short (allow some tolerance)
      expect(body.usage.output_tokens).toBeLessThanOrEqual(15)
    },
    TEST_TIMEOUT,
  )

  test(
    "invalid model returns error",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "nonexistent-model-xyz-999",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10,
        stream: false,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )

  test(
    "malformed request body returns error",
    async () => {
      const res = await postJSON("/v1/messages", { max_tokens: 10 })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )
})

const NATIVE_WEB_SEARCH_MODELS = [
  "claude-haiku-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
]
// Claude Code's catalog marks these models `rejects_disabled_thinking`.
const ALWAYS_THINKING_MODELS = [
  "claude-opus-5.5",
  "claude-fable-5.1",
  "claude-fable-5",
]

function nativeMessagesModels() {
  return (state.models?.data ?? []).filter(
    (model) =>
      model.id.startsWith("claude-")
      && model.supported_endpoints?.includes("/v1/messages"),
  )
}

function findNativeMessagesModel(): string | undefined {
  const native = nativeMessagesModels()
  return (
    NATIVE_WEB_SEARCH_MODELS.find((id) =>
      native.some((model) => model.id === id),
    ) ?? native[0]?.id
  )
}

function findAlwaysThinkingModel(): string | undefined {
  const native = nativeMessagesModels()
  return ALWAYS_THINKING_MODELS.find((id) =>
    native.some((model) => model.id === id),
  )
}

// Request shape sent by the WebSearch tool in Claude Code 2.1.281.
function claudeCodeWebSearchRequest(
  model: string,
  extra: Record<string, unknown> = {},
) {
  return {
    model,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: "You are an assistant for performing a web search tool use",
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Perform a web search for the query: GitHub Copilot changelog",
          },
        ],
      },
    ],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    tool_choice: { type: "tool", name: "web_search" },
    thinking: { type: "disabled" },
    stream: true,
    ...extra,
  }
}

async function expectStreamedAnswer(res: Response): Promise<void> {
  const raw = await res.text()
  expect({ status: res.status, body: raw.slice(0, 1000) }).toMatchObject({
    status: 200,
  })
  const events = await collectSSEEvents(new Response(raw))
  const eventTypes = events.map((event) => event.event)
  const text = events
    .flatMap((event) => {
      if (event.event !== "content_block_delta") return []
      const data = JSON.parse(event.data) as AnthropicStreamEvent
      return data.delta?.type === "text_delta" ? [data.delta.text ?? ""] : []
    })
    .join("")

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).toContain("message_stop")
  expect(eventTypes).not.toContain("error")
  expect(text.trim().length).toBeGreaterThan(0)
}

describe("POST /v1/messages - web search", () => {
  test(
    "completes the Claude Code WebSearch side query on native Messages",
    async () => {
      const model = findNativeMessagesModel()
      if (!model) {
        console.log("Skipping — no native Messages Claude model available")
        return
      }

      await expectStreamedAnswer(
        await postJSON("/v1/messages", claudeCodeWebSearchRequest(model)),
      )
    },
    TEST_TIMEOUT,
  )

  test(
    "completes the Claude Code WebSearch side query on a model that always thinks",
    async () => {
      const model = findAlwaysThinkingModel()
      if (!model) {
        console.log("Skipping — no always-thinking Claude model available")
        return
      }

      await expectStreamedAnswer(
        await postJSON(
          "/v1/messages",
          claudeCodeWebSearchRequest(model, {
            output_config: { effort: "high" },
          }),
        ),
      )
    },
    TEST_TIMEOUT,
  )
})
