import { expect, test } from "bun:test"

import {
  inspectCopilotSessionToken,
  sessionTokenMatchesModel,
} from "~/lib/copilot-session-token"

const jwt = (payload: unknown): string =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`

test("reads only bounded model-binding hints from an opaque session token", () => {
  const token = jwt({
    selected_model: " gpt-current ",
    available_models: [
      "gpt-current",
      " claude-current ",
      "gpt-current",
      "",
      "   ",
      42,
    ],
    sub: "must-not-expose",
  })

  expect(inspectCopilotSessionToken(token)).toEqual({
    selectedModel: "gpt-current",
    availableModels: ["gpt-current", "claude-current"],
  })
})

test("accepts either selected_model or available_models as a model binding", () => {
  expect(
    inspectCopilotSessionToken(jwt({ selected_model: "gpt-current" })),
  ).toEqual({
    selectedModel: "gpt-current",
    availableModels: [],
  })
  expect(
    inspectCopilotSessionToken(
      jwt({ available_models: ["gpt-current", "claude-current"] }),
    ),
  ).toEqual({
    availableModels: ["gpt-current", "claude-current"],
  })
})

test("treats malformed or model-unbound tokens as unusable", () => {
  const validPayload = Buffer.from(
    JSON.stringify({ selected_model: "gpt-current" }),
  ).toString("base64url")
  const malformedTokens = [
    "not-a-jwt",
    "one.two.three.four",
    `.${validPayload}.signature`,
    `header.${validPayload}.`,
    "header.%.signature",
    `header.${Buffer.from("not json").toString("base64url")}.signature`,
    jwt(null),
    jwt([]),
    jwt({}),
    jwt({ selected_model: "", available_models: [1, false, " "] }),
    `${"x".repeat(16 * 1024)}.payload.signature`,
  ]

  for (const token of malformedTokens) {
    expect(inspectCopilotSessionToken(token)).toBeUndefined()
  }
})

test("does not inspect header or signature segments as JSON", () => {
  const payload = Buffer.from(
    JSON.stringify({ available_models: ["gpt-current"] }),
  ).toString("base64url")

  expect(
    inspectCopilotSessionToken(`not-json.${payload}.also-not-json`),
  ).toEqual({ availableModels: ["gpt-current"] })
})

test("forwards only when the requested and final models remain allowed", () => {
  const selectedToken = jwt({
    selected_model: "gpt-current",
    available_models: ["redirected-model"],
  })
  expect(
    sessionTokenMatchesModel({
      token: selectedToken,
      requestedModel: "gpt-current",
      finalModel: "gpt-current",
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesModel({
      token: selectedToken,
      requestedModel: "gpt-current",
      finalModel: "redirected-model",
    }),
  ).toBe(false)
  expect(
    sessionTokenMatchesModel({
      token: jwt({ available_models: ["redirected-model"] }),
      requestedModel: "gpt-current",
      finalModel: "redirected-model",
    }),
  ).toBe(false)
})

test("uses selected_model ahead of available_models", () => {
  const token = jwt({
    selected_model: "claude-current",
    available_models: ["gpt-current"],
  })

  expect(
    sessionTokenMatchesModel({
      token,
      requestedModel: "gpt-current",
      finalModel: "gpt-current",
    }),
  ).toBe(false)
})

test("compares aliases only through the existing model normalization", () => {
  const token = jwt({ selected_model: "claude-opus-4.6-1m" })

  expect(
    sessionTokenMatchesModel({
      token,
      requestedModel: "claude-opus-4-6[1m]",
      finalModel: "claude-opus-4.6-1m",
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesModel({
      token: jwt({ available_models: ["Claude Opus 4.6 1M"] }),
      requestedModel: "claude-opus-4.6-1m",
      finalModel: "claude-opus-4.6-1m",
    }),
  ).toBe(false)
})

test("rejects absent and malformed tokens without throwing", () => {
  expect(
    sessionTokenMatchesModel({
      token: undefined,
      requestedModel: "gpt-current",
      finalModel: "gpt-current",
    }),
  ).toBe(false)
  expect(
    sessionTokenMatchesModel({
      token: "malformed",
      requestedModel: "gpt-current",
      finalModel: "gpt-current",
    }),
  ).toBe(false)
})
