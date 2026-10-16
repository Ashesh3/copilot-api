import { expect, test } from "bun:test"

import type { SystemPromptOverride } from "~/lib/system-prompt-overrides"

import { validateStoredModelSettings } from "~/lib/model-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import * as promptOverrides from "~/lib/system-prompt-overrides"

test("stored prompt overrides retain their exact content and take precedence over legacy fields", () => {
  const systemPromptOverrides: Array<SystemPromptOverride> = [
    { mode: "clear", prompt: "" },
    { mode: "append", prompt: "  Literal prompt\n" },
    { mode: "replace", find: " \n", replacement: "" },
    { mode: "prepend", prompt: " Legacy separate prompt " },
  ]

  expect(
    validateStoredModelSettings([
      {
        model: "gpt-5.5",
        systemPromptOverrides,
        forcedSystemPrompt: "Do not use this prompt",
        clearOtherSystemPrompts: true,
        forceAppendSystemPrompt: true,
      },
    ]),
  ).toEqual({ "gpt-5.5": { model: "gpt-5.5", systemPromptOverrides } })
})

test("a stored empty list prevents legacy prompts from returning", () => {
  expect(
    validateStoredModelSettings({
      "gpt-5.5": {
        systemPromptOverrides: [],
        forcedSystemPrompt: "Do not use this prompt",
        clearOtherSystemPrompts: true,
      },
    }),
  ).toEqual({})
})

test.each(
  [
    null,
    {},
    "prompt",
    [null],
    [[]],
    [{}],
    [{ mode: ["clear", "append"], prompt: "Text" }],
    [{ mode: "regex", find: "x", replacement: "y" }],
    [{ mode: "clear", prompt: null }],
    [{ mode: "append", prompt: " \n\t" }],
    [{ mode: "prepend", prompt: "" }],
    [{ mode: "replace", find: "", replacement: "y" }],
    [{ mode: "replace", find: 1, replacement: "y" }],
    [{ mode: "replace", find: "x", replacement: null }],
    [{ mode: "replace", find: "x" }],
    [{ mode: "clear", prompt: "", replacement: "y" }],
    [{ mode: "replace", find: "x", replacement: "", prompt: "ambiguous" }],
    [{ mode: "append", prompt: "x", enabled: true }],
    Array.from({ length: 33 }, () => ({ mode: "clear", prompt: "" })),
    [
      { mode: "append", prompt: "x".repeat(100_000) },
      { mode: "replace", find: "x", replacement: "y".repeat(100_000) },
    ],
  ].map((value) => ({ value })),
)(
  "rejects malformed stored prompt overrides %# with StorageSchemaError",
  ({ value }) => {
    expect(() =>
      validateStoredModelSettings([
        { model: "gpt-5.5", systemPromptOverrides: value },
      ]),
    ).toThrow(StorageSchemaError)
  },
)

test("legacy-only stored prompts keep their existing shape and normalization", () => {
  expect(
    validateStoredModelSettings([
      {
        model: "legacy-append",
        forcedSystemPrompt: "  Keep old normalization.\n",
        forceAppendSystemPrompt: true,
      },
      {
        model: "legacy-prepend",
        forcedSystemPrompt: " Separate prompt ",
        clearOtherSystemPrompts: false,
        forceAppendSystemPrompt: false,
      },
    ]),
  ).toEqual({
    "legacy-append": {
      model: "legacy-append",
      forcedSystemPrompt: "Keep old normalization.",
      forceAppendSystemPrompt: true,
    },
    "legacy-prepend": {
      model: "legacy-prepend",
      forcedSystemPrompt: "Separate prompt",
    },
  })
})

test("the shared resolver converts legacy prompt modes while retaining new rule order and text", () => {
  expect(promptOverrides.getSystemPromptOverrides).toBeFunction()
  expect(
    promptOverrides.getSystemPromptOverrides({
      forcedSystemPrompt: "  Old clear prompt \n",
      clearOtherSystemPrompts: true,
      forceAppendSystemPrompt: true,
    }),
  ).toEqual([{ mode: "clear", prompt: "Old clear prompt" }])
  expect(
    promptOverrides.getSystemPromptOverrides({
      forcedSystemPrompt: " Old append prompt ",
      forceAppendSystemPrompt: true,
    }),
  ).toEqual([{ mode: "append", prompt: "Old append prompt" }])
  expect(
    promptOverrides.getSystemPromptOverrides({
      forcedSystemPrompt: " Old separate prompt ",
      forceAppendSystemPrompt: false,
      clearOtherSystemPrompts: false,
    }),
  ).toEqual([{ mode: "prepend", prompt: "Old separate prompt" }])
  expect(promptOverrides.getSystemPromptOverrides({})).toEqual([])
  expect(
    promptOverrides.getSystemPromptOverrides({ forcedSystemPrompt: "\n\t " }),
  ).toEqual([])
  expect(
    promptOverrides.getSystemPromptOverrides({
      systemPromptOverrides: [],
      forcedSystemPrompt: "Do not restore this prompt",
    }),
  ).toEqual([])
  expect(
    promptOverrides.getSystemPromptOverrides({
      systemPromptOverrides: [
        { mode: "append", prompt: " \n Literal text \n " },
        { mode: "replace", find: " ", replacement: "" },
      ],
      forcedSystemPrompt: "Do not restore this prompt",
      clearOtherSystemPrompts: true,
    }),
  ).toEqual([
    { mode: "append", prompt: " \n Literal text \n " },
    { mode: "replace", find: " ", replacement: "" },
  ])
})

test.each([undefined, null, []].map((value) => ({ value })))(
  "the shared validator accepts absent and empty overrides %#",
  ({ value }) => {
    expect(promptOverrides.validateSystemPromptOverrides(value)).toBeUndefined()
  },
)
