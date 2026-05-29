import { beforeEach, expect, test } from "bun:test"

import {
  getAllModelSettings,
  modelSupportsAssistantPrefill,
  setModelSettingsForTest,
} from "../src/lib/model-settings"
import {
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  createSentryOutputMessages,
  createSentryToolSpanOptions,
  getSentryConversationIdFromHeaders,
  getSentryConversationIdFromPayload,
  getSentryModelName,
} from "../src/lib/sentry"

const originalSentryAiRecordInputs = process.env.SENTRY_AI_RECORD_INPUTS

beforeEach(() => {
  setModelSettingsForTest([])
  if (originalSentryAiRecordInputs === undefined) {
    delete process.env.SENTRY_AI_RECORD_INPUTS
  } else {
    process.env.SENTRY_AI_RECORD_INPUTS = originalSentryAiRecordInputs
  }
})

test("uses configured Sentry model name without reasoning settings", async () => {
  setModelSettingsForTest([
    {
      model: "opus-4.7-internal",
      sentryModelName: "opus-4.7-haha",
    },
  ])

  expect(getSentryModelName("opus-4.7-internal")).toBe("opus-4.7-haha")
  expect(getSentryModelName("opus-4.7-internal:high")).toBe("opus-4.7-haha")

  const settings = await getAllModelSettings()
  expect(settings).toEqual([
    {
      model: "opus-4.7-internal",
      sentryModelName: "opus-4.7-haha",
    },
  ])
})

test("persists unsupported request parameter model settings", async () => {
  setModelSettingsForTest([
    {
      model: "no-temperature-model",
      unsupportedRequestParameters: ["temperature", "top_p", "invalid"],
    },
  ])

  const settings = await getAllModelSettings()
  expect(settings).toEqual([
    {
      model: "no-temperature-model",
      unsupportedRequestParameters: ["temperature", "top_p"],
    },
  ])
})

test("persists assistant prefill support model settings", async () => {
  setModelSettingsForTest([
    {
      model: "claude-no-prefill",
      supportsAssistantPrefill: false,
    },
    {
      model: "claude-default-prefill",
      supportsAssistantPrefill: "false",
    },
  ])

  const settings = await getAllModelSettings()
  expect(settings).toEqual([
    {
      model: "claude-no-prefill",
      supportsAssistantPrefill: false,
    },
  ])
  expect(modelSupportsAssistantPrefill("claude-no-prefill")).toBe(false)
  expect(modelSupportsAssistantPrefill("claude-default-prefill")).toBe(true)
  expect(modelSupportsAssistantPrefill("unset-model")).toBe(true)
})

test("falls back to built-in Sentry model names", () => {
  expect(getSentryModelName("claude-opus-4.6")).toBe("claude-opus-4-6")
  expect(getSentryModelName("claude-opus-4.6:high")).toBe("claude-opus-4-6")
})

test("creates current Sentry AI agent span attributes", () => {
  process.env.SENTRY_AI_RECORD_INPUTS = "true"

  expect(
    createSentryInvokeAgentSpanOptions("claude-opus-4.6", "conv_abc"),
  ).toEqual({
    op: "gen_ai.invoke_agent",
    name: "invoke_agent copilot-proxy",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "copilot-proxy",
      "gen_ai.request.model": "claude-opus-4-6",
      "gen_ai.conversation.id": "conv_abc",
    },
  })

  expect(
    createSentryChatSpanOptions({
      inputMessages: [{ role: "user", content: "quota" }],
      model: "claude-opus-4.6",
      streaming: true,
    }),
  ).toEqual({
    op: "gen_ai.chat",
    name: "chat claude-opus-4-6",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "copilot-proxy",
      "gen_ai.request.model": "claude-opus-4-6",
      "gen_ai.response.model": "claude-opus-4-6",
      "gen_ai.response.streaming": true,
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", content: "quota" },
      ]),
    },
  })

  expect(
    createSentryToolSpanOptions({
      toolArguments: { query: "quota" },
      toolName: "web_search",
      toolResult: "result",
    }),
  ).toEqual({
    op: "gen_ai.execute_tool",
    name: "execute_tool web_search",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "web_search",
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.arguments": JSON.stringify({ query: "quota" }),
      "gen_ai.tool.call.result": "result",
    },
  })
})

test("creates Sentry output messages in current message format", () => {
  expect(createSentryOutputMessages("hello")).toBe(
    JSON.stringify([
      {
        role: "assistant",
        parts: [{ type: "text", content: "hello" }],
      },
    ]),
  )
})

test("omits Sentry AI content attributes when recording is disabled", () => {
  process.env.SENTRY_AI_RECORD_INPUTS = "false"

  expect(
    createSentryChatSpanOptions({
      inputMessages: [{ role: "user", content: "quota" }],
      model: "claude-opus-4.6",
    }).attributes,
  ).not.toHaveProperty("gen_ai.input.messages")

  expect(
    createSentryToolSpanOptions({
      toolArguments: { query: "quota" },
      toolName: "web_search",
      toolResult: "result",
    }).attributes,
  ).not.toHaveProperty("gen_ai.tool.call.arguments")
})

test("extracts Sentry conversation ID from Responses payload", () => {
  expect(
    getSentryConversationIdFromPayload({
      conversation_id: "conv_abc",
      model: "gpt-5.3-codex",
    }),
  ).toBe("conv_abc")
})

test("extracts Sentry conversation ID from metadata", () => {
  expect(
    getSentryConversationIdFromPayload({
      metadata: {
        session_id: "session_abc",
      },
      model: "claude-sonnet-4.6",
    }),
  ).toBe("session_abc")
})

test("extracts Sentry conversation ID from Claude Code JSON user metadata", () => {
  expect(
    getSentryConversationIdFromPayload({
      metadata: {
        user_id: JSON.stringify({
          account_uuid: "account_abc",
          session_id: "session_json",
        }),
      },
      model: "claude-sonnet-4.6",
    }),
  ).toBe("session_json")
})

test("extracts Sentry conversation ID from legacy Claude Code user metadata", () => {
  expect(
    getSentryConversationIdFromPayload({
      metadata: {
        user_id: "user_abc_account_xyz_session_session_legacy",
      },
      model: "claude-sonnet-4.6",
    }),
  ).toBe("session_legacy")
})

test("extracts Sentry conversation ID from supported headers", () => {
  const headers = new Headers({
    "x-session-id": "session_header",
  })

  expect(getSentryConversationIdFromHeaders(headers)).toBe("session_header")
})
