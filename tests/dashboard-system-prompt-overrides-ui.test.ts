import { expect, test } from "bun:test"

import {
  MAX_SYSTEM_PROMPT_OVERRIDES,
  MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH,
  validateSystemPromptOverrides,
} from "~/lib/system-prompt-overrides"

import {
  createSystemPromptOverrideRow,
  getSystemPromptOverrideFieldErrors,
  getSystemPromptOverrideOptions,
  moveSystemPromptOverride,
  toSystemPromptOverrideRows,
  toSystemPromptOverrides,
  validateSystemPromptOverrideRows,
} from "../ui/src/lib/system-prompt-override-form"

test("new configurations append; separate-prompt mode remains available only to existing rows", () => {
  const added = createSystemPromptOverrideRow()
  expect(added.mode).toBe("append")
  expect(
    getSystemPromptOverrideOptions(added).map(({ value }) => value),
  ).toEqual(["clear", "append", "replace"])

  const [legacy] = toSystemPromptOverrideRows({
    model: "test-model",
    forcedSystemPrompt: "Keep separate.",
  })
  expect(legacy.mode).toBe("prepend")
  expect(getSystemPromptOverrideOptions(legacy)).toContainEqual({
    value: "prepend",
    label: "Add separate prompt",
  })
  expect(
    getSystemPromptOverrideOptions({ ...legacy, mode: "clear" }),
  ).toContainEqual({
    value: "prepend",
    label: "Add separate prompt",
  })
  expect(toSystemPromptOverrides([legacy])).toEqual([
    { mode: "prepend", prompt: "Keep separate." },
  ])
})

test("saving ordered configurations retains whitespace and strips inactive drafts and row metadata", () => {
  const append = {
    ...createSystemPromptOverrideRow({ mode: "append", prompt: "  Intro\n" }),
    find: "old draft",
    replacement: "unused draft",
  }
  const replace = {
    ...createSystemPromptOverrideRow({
      mode: "replace",
      find: "  exact \n",
      replacement: "\n  replacement  ",
    }),
    prompt: "inactive prompt",
  }

  expect(toSystemPromptOverrides([append, replace])).toEqual([
    { mode: "append", prompt: "  Intro\n" },
    { mode: "replace", find: "  exact \n", replacement: "\n  replacement  " },
  ])
  expect(toSystemPromptOverrides([])).toEqual([])
})

test("editing retains legacy clear and append behavior, and an explicit empty rule list stays disabled", () => {
  for (const [legacyKey, mode] of [
    ["clearOtherSystemPrompts", "clear"],
    ["forceAppendSystemPrompt", "append"],
  ] as const) {
    const rows = toSystemPromptOverrideRows({
      model: "test-model",
      forcedSystemPrompt: "Existing instructions.",
      [legacyKey]: true,
    })
    expect(toSystemPromptOverrides(rows)).toEqual([
      { mode, prompt: "Existing instructions." },
    ])
    expect(getSystemPromptOverrideOptions(rows[0])).not.toContainEqual({
      value: "prepend",
      label: "Add separate prompt",
    })
  }
  expect(
    toSystemPromptOverrideRows({
      model: "test-model",
      systemPromptOverrides: [],
      forcedSystemPrompt: "Stale legacy text.",
    }),
  ).toEqual([])
})

test("reordering preserves row identities and field values without mutating the original order", () => {
  const first = createSystemPromptOverrideRow({ mode: "clear", prompt: "" })
  const second = createSystemPromptOverrideRow({
    mode: "replace",
    find: "old",
    replacement: "new",
  })
  const third = createSystemPromptOverrideRow({
    mode: "append",
    prompt: "Last",
  })
  const rows = [first, second, third]
  const moved = moveSystemPromptOverride(rows, third.id, "up")

  expect(new Set(rows.map(({ id }) => id)).size).toBe(3)
  expect(moved).toEqual([first, third, second])
  expect(moved[1]).toBe(third)
  expect(rows).toEqual([first, second, third])
  expect(moveSystemPromptOverride(rows, first.id, "up")).toBe(rows)
  expect(moveSystemPromptOverride(rows, third.id, "down")).toBe(rows)
  expect(moveSystemPromptOverride(rows, "deleted-row", "up")).toBe(rows)
  expect(toSystemPromptOverrides(moved).map(({ mode }) => mode)).toEqual([
    "clear",
    "append",
    "replace",
  ])
})

test("field validation accepts clear-only and literal whitespace searches but rejects missing required text", () => {
  expect(
    getSystemPromptOverrideFieldErrors(createSystemPromptOverrideRow()),
  ).toEqual({
    prompt: "Enter a system prompt.",
  })
  expect(
    getSystemPromptOverrideFieldErrors(
      createSystemPromptOverrideRow({ mode: "append", prompt: " \n\t" }),
    ),
  ).toEqual({ prompt: "Enter a system prompt." })
  expect(
    getSystemPromptOverrideFieldErrors(
      createSystemPromptOverrideRow({
        mode: "replace",
        find: "",
        replacement: "",
      }),
    ),
  ).toEqual({ find: "Enter the exact text to find." })

  const allowed = [
    createSystemPromptOverrideRow({ mode: "clear", prompt: "" }),
    createSystemPromptOverrideRow({
      mode: "replace",
      find: " \n",
      replacement: "",
    }),
  ]
  for (const row of allowed)
    expect(getSystemPromptOverrideFieldErrors(row)).toEqual({})
  expect(
    validateSystemPromptOverrides(toSystemPromptOverrides(allowed)),
  ).toBeUndefined()
})

test("save validation counts only active text and enforces the shared total limit", () => {
  const row = {
    ...createSystemPromptOverrideRow({ mode: "append", prompt: "Active" }),
    find: "x".repeat(MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH),
    replacement: "draft",
  }
  expect(
    validateSystemPromptOverrides(toSystemPromptOverrides([row])),
  ).toBeUndefined()
  expect(validateSystemPromptOverrideRows([row])).toBeUndefined()

  const atLimit = createSystemPromptOverrideRow({
    mode: "replace",
    find: "x".repeat(MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH - 1),
    replacement: "y",
  })
  expect(
    validateSystemPromptOverrides(toSystemPromptOverrides([atLimit])),
  ).toBeUndefined()
  expect(
    validateSystemPromptOverrides(toSystemPromptOverrides([atLimit, row])),
  ).toBeDefined()
  expect(validateSystemPromptOverrideRows([atLimit, row])).toContain(
    "combined text",
  )
})

test("form validation names the invalid configuration and rejects too many configurations", () => {
  const clear = createSystemPromptOverrideRow({ mode: "clear", prompt: "" })
  const blank = createSystemPromptOverrideRow()
  expect(validateSystemPromptOverrideRows([clear, blank])).toBe(
    "Configuration 2: Enter a system prompt.",
  )
  const many = Array.from({ length: MAX_SYSTEM_PROMPT_OVERRIDES + 1 }, () =>
    createSystemPromptOverrideRow({ mode: "clear", prompt: "" }),
  )
  expect(validateSystemPromptOverrideRows(many)).toBe(
    `Use at most ${MAX_SYSTEM_PROMPT_OVERRIDES} configurations.`,
  )
})
