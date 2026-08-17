import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

const originalFetch = globalThis.fetch
let lastRequestBody: Record<string, unknown> | undefined

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  return Response.json({
    id: "resp_normalization",
    object: "response",
    created_at: 1,
    model: lastRequestBody?.model,
    output: [],
    output_text: "",
    status: "completed",
    usage: null,
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  lastRequestBody = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  setModelSettingsForTest([])
})

test("omits sampling parameters for GPT-5.6 reasoning requests", async () => {
  await createResponses(
    {
      model: "gpt-5.6-sol",
      input: "Hello",
      reasoning: { effort: "max" },
      temperature: 0.3,
      top_p: 0.8,
    },
    { vision: false, initiator: "user" },
  )

  expect(lastRequestBody).not.toHaveProperty("temperature")
  expect(lastRequestBody).not.toHaveProperty("top_p")
})

test("keeps sampling parameters for GPT-5.6 with reasoning disabled", async () => {
  await createResponses(
    {
      model: "gpt-5.6-sol",
      input: "Hello",
      reasoning: { effort: "none" },
      temperature: 0.3,
      top_p: 0.8,
    },
    { vision: false, initiator: "user" },
  )

  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("omits GPT-5.6 sampling after implicit defaults remove explicit none", async () => {
  setModelSettingsForTest([
    {
      model: "gpt-5.6-implicit-medium",
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  await createResponses(
    {
      model: "gpt-5.6-implicit-medium",
      input: "Hello",
      reasoning: { effort: "none" },
      temperature: 0.3,
      top_p: 0.8,
    },
    { vision: false, initiator: "user" },
  )

  expect(lastRequestBody?.reasoning).toEqual({ summary: "auto" })
  expect(lastRequestBody).not.toHaveProperty("temperature")
  expect(lastRequestBody).not.toHaveProperty("top_p")
})

test("keeps GPT-5.6 sampling when the configured final default is none", async () => {
  setModelSettingsForTest([
    {
      model: "gpt-5.6-default-none",
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "none",
    },
  ])

  await createResponses(
    {
      model: "gpt-5.6-default-none",
      input: "Hello",
      temperature: 0.3,
      top_p: 0.8,
    },
    { vision: false, initiator: "user" },
  )

  expect(lastRequestBody?.reasoning).toEqual({
    effort: "none",
    summary: "auto",
  })
  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("omits Responses tool controls when no tools are available", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Hello",
      tools: null,
      tool_choice: "auto",
      parallel_tool_calls: true,
    },
    { vision: false, initiator: "user" },
  )

  expect(lastRequestBody).not.toHaveProperty("tools")
  expect(lastRequestBody).not.toHaveProperty("tool_choice")
  expect(lastRequestBody).not.toHaveProperty("parallel_tool_calls")
})

test("forwards reviewed Responses fields from the prepared request", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Hello",
      context_management: [{ type: "truncate" }],
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      prompt_cache_retention: "in_memory",
      truncation: "auto",
      user: "user-1",
    },
    { vision: false, initiator: "user" },
  )

  expect(lastRequestBody).toMatchObject({
    context_management: [{ type: "truncate" }],
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    truncation: "auto",
    user: "user-1",
  })
})

test("does not pass upstream Responses objects to ordinary logs", async () => {
  fetchMock.mockImplementationOnce(() =>
    Response.json(
      { error: { code: "invalid_request_body", message: "private-body" } },
      { status: 400, statusText: "private-status" },
    ),
  )
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await createResponses(
        { model: "gpt-4o", input: "Hello" },
        { vision: false, initiator: "user" },
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toHaveProperty("response.status", 400)
    const output = JSON.stringify(errorSpy.mock.calls)
    expect(output).not.toContain("private-body")
    expect(output).not.toContain("private-status")
    expect(errorSpy.mock.calls).toEqual([["Failed to create responses"]])
  } finally {
    errorSpy.mockRestore()
  }
})
