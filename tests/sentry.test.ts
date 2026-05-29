import { beforeEach, expect, test } from "bun:test"

import {
  getAllModelSettings,
  setModelSettingsForTest,
} from "../src/lib/model-settings"
import {
  getSentryConversationIdFromHeaders,
  getSentryConversationIdFromPayload,
  getSentryModelName,
} from "../src/lib/sentry"

beforeEach(() => {
  setModelSettingsForTest([])
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

test("falls back to built-in Sentry model names", () => {
  expect(getSentryModelName("claude-opus-4.6")).toBe("claude-opus-4-6")
  expect(getSentryModelName("claude-opus-4.6:high")).toBe("claude-opus-4-6")
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
