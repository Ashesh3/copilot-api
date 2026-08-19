import { expect, test } from "bun:test"

import {
  inspectCopilotSessionToken,
  sessionTokenMatchesModel,
} from "~/lib/copilot-session-token"

const jwt = (payload: unknown): string =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`

function noncanonicalPayloadSegment(payload: unknown): string {
  const canonical = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const decoded = Buffer.from(canonical, "base64url")
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const candidate = Array.from(alphabet).find((character) => {
    const changed = `${canonical.slice(0, -1)}${character}`
    return (
      changed !== canonical && Buffer.from(changed, "base64url").equals(decoded)
    )
  })
  if (!candidate) throw new Error("Expected a noncanonical payload variant")
  return `${canonical.slice(0, -1)}${candidate}`
}

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
    `e%0.${validPayload}.c2ln`,
    `e30.${validPayload}.c2%ln`,
    `e30.${validPayload}.c2\u0000ln`,
    `e30=.${validPayload}.c2ln`,
    `A.${validPayload}.c2ln`,
    `e30.A.c2ln`,
    `e30.${noncanonicalPayloadSegment({ selected_model: "gpt-current" })}.c2ln`,
    `e30.${Buffer.from("not json").toString("base64url")}.c2ln`,
    `e30.${Buffer.concat([
      Buffer.from('{"selected_model":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]).toString("base64url")}.c2ln`,
    jwt(null),
    jwt([]),
    jwt({}),
    jwt({ selected_model: "", available_models: [1, false, " "] }),
    `e30.${"A".repeat(16 * 1024)}.c2ln`,
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
    inspectCopilotSessionToken(`bm90LWpzb24.${payload}.YWxzby1ub3QtanNvbg`),
  ).toEqual({ availableModels: ["gpt-current"] })
})

test("keeps syntactically valid header and signature segments opaque", () => {
  const payload = Buffer.from(
    JSON.stringify({ selected_model: "gpt-current" }),
  ).toString("base64url")

  expect(inspectCopilotSessionToken(`Zh.${payload}.Zh`)).toEqual({
    selectedModel: "gpt-current",
    availableModels: [],
  })
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
      modelWasRedirected: false,
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesModel({
      token: selectedToken,
      requestedModel: "gpt-current",
      finalModel: "redirected-model",
      modelWasRedirected: true,
    }),
  ).toBe(false)
  expect(
    sessionTokenMatchesModel({
      token: jwt({ available_models: ["redirected-model"] }),
      requestedModel: "gpt-current",
      finalModel: "redirected-model",
      modelWasRedirected: true,
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
      modelWasRedirected: false,
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
      modelWasRedirected: false,
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesModel({
      token: jwt({ available_models: ["Claude Opus 4.6 1M"] }),
      requestedModel: "claude-opus-4.6-1m",
      finalModel: "claude-opus-4.6-1m",
      modelWasRedirected: false,
    }),
  ).toBe(false)
})

test("rejects absent and malformed tokens without throwing", () => {
  expect(
    sessionTokenMatchesModel({
      token: undefined,
      requestedModel: "gpt-current",
      finalModel: "gpt-current",
      modelWasRedirected: false,
    }),
  ).toBe(false)
  expect(
    sessionTokenMatchesModel({
      token: "malformed",
      requestedModel: "gpt-current",
      finalModel: "gpt-current",
      modelWasRedirected: false,
    }),
  ).toBe(false)
})

test("rejects configured redirects even when source and target normalize equally", () => {
  const token = jwt({ selected_model: "gpt-4.1" })

  expect(
    sessionTokenMatchesModel({
      token,
      requestedModel: "gpt-4-1",
      finalModel: "gpt-4.1",
      modelWasRedirected: false,
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesModel({
      token,
      requestedModel: "gpt-4-1",
      finalModel: "gpt-4.1",
      modelWasRedirected: true,
    }),
  ).toBe(false)
})
