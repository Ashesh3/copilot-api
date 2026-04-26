import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"

const originalFetch = globalThis.fetch
let lastRequestBody: Record<string, unknown> | undefined
let requestBodies: Array<Record<string, unknown>>
let queuedResponses: Array<Response>

function createSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-4o",
      output: [],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
}

function parseRequestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    return {}
  }

  return JSON.parse(init.body) as Record<string, unknown>
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastRequestBody = parseRequestBody(init)
  requestBodies.push(lastRequestBody)

  return queuedResponses.shift() ?? createSuccessResponse()
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastRequestBody = undefined
  requestBodies = []
  queuedResponses = []
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  setModelSettingsForTest([])
})

test("preserves previous_response_id when sending Responses API requests", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Hello",
      previous_response_id: "resp_previous",
    } as {
      model: string
      input: string
      previous_response_id: string
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.previous_response_id).toBe("resp_previous")
})

test("preserves prompt and conversation_id when sending Responses API requests", async () => {
  const prompt = {
    id: "pmpt_123",
    variables: { task: "greeting" },
  }

  await createResponses(
    {
      model: "gpt-4o",
      prompt,
      conversation_id: "conv_abc",
    } as {
      model: string
      prompt: {
        id: string
        variables: { task: string }
      }
      conversation_id: string
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.prompt).toEqual(prompt)
  expect(lastRequestBody?.conversation_id).toBe("conv_abc")
})

test("injects runtime-style default reasoning settings for direct Responses requests", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Hello",
    } as {
      model: string
      input: string
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.store).toBe(false)
  expect(lastRequestBody?.reasoning).toEqual({
    effort: "medium",
    summary: "auto",
  })
  expect(lastRequestBody?.include).toEqual(["reasoning.encrypted_content"])
})

test("does not send configurable effort for implicit-default Responses models", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  await createResponses(
    {
      model: "claude-implicit-medium",
      input: "Hello",
      reasoning: { effort: "high" },
    } as {
      model: string
      input: string
      reasoning: { effort: "high" }
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.reasoning).toEqual({
    summary: "auto",
  })
})

test("retries 413 Responses requests without input images", async () => {
  queuedResponses.push(
    new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    }),
    createSuccessResponse(),
  )

  await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "high",
            },
          ],
        },
      ],
    } as {
      model: string
      input: Array<{
        role: string
        content: Array<
          | { type: "input_text"; text: string }
          | { type: "input_image"; image_url: string; detail: string }
        >
      }>
    },
    {
      vision: true,
      initiator: "user",
    },
  )

  expect(requestBodies).toHaveLength(2)
  expect(requestBodies[0]?.input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,abc",
          detail: "high",
        },
      ],
    },
  ])
  expect(requestBodies[1]?.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "Describe this image" }],
    },
  ])
})

test("does not retry 413 Responses requests when removing images leaves an empty input", async () => {
  queuedResponses.push(
    new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    }),
    createSuccessResponse(),
  )

  const error = await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "high",
            },
          ],
        },
      ],
    } as {
      model: string
      input: Array<{
        role: string
        content: Array<{
          type: "input_image"
          image_url: string
          detail: string
        }>
      }>
    },
    {
      vision: true,
      initiator: "user",
    },
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response.status).toBe(413)
  expect(requestBodies).toHaveLength(1)
})
