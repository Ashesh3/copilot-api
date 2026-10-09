import { afterEach, expect, test } from "bun:test"

import {
  modelSupportsAssistantPrefill,
  setModelSettingsForTest,
} from "~/lib/model-settings"

afterEach(() => {
  setModelSettingsForTest([])
})

test("defaults Claude Opus, Sonnet, Haiku, and Fable models to no prefill", () => {
  setModelSettingsForTest([])
  const models = [
    "claude-opus-4.7-1m-internal",
    "claude-opus-4.8",
    "claude-opus-4.8-fast",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-sonnet-5.5",
    "claude-haiku-4.5",
    "claude-fable-5",
    "claude-fable-5.1",
    "claude-3.5-sonnet",
    "claude-3-5-haiku-20241022",
    "claude-sonnet-4-6[1m]",
    "claude-opus-4.8:high",
    "anthropic/claude-sonnet-4.5",
    "claude-gpt-5.5",
    "claude-code",
    "gpt-5.5",
    "opus-writer",
  ]

  expect(
    Object.fromEntries(
      models.map((model) => [model, modelSupportsAssistantPrefill(model)]),
    ),
  ).toEqual({
    "claude-opus-4.7-1m-internal": false,
    "claude-opus-4.8": false,
    "claude-opus-4.8-fast": false,
    "claude-opus-5": false,
    "claude-sonnet-5": false,
    "claude-sonnet-5.5": false,
    "claude-haiku-4.5": false,
    "claude-fable-5": false,
    "claude-fable-5.1": false,
    "claude-3.5-sonnet": false,
    "claude-3-5-haiku-20241022": false,
    "claude-sonnet-4-6[1m]": false,
    "claude-opus-4.8:high": false,
    "anthropic/claude-sonnet-4.5": false,
    "claude-gpt-5.5": true,
    "claude-code": true,
    "gpt-5.5": true,
    "opus-writer": true,
  })
})

test("model settings can re-enable prefill for a Claude model", () => {
  setModelSettingsForTest([
    { model: "claude-sonnet-5.5", supportsAssistantPrefill: true },
  ])

  expect(modelSupportsAssistantPrefill("claude-sonnet-5.5")).toBe(true)
  expect(modelSupportsAssistantPrefill("claude-sonnet-5")).toBe(false)
})
