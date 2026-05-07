import { beforeEach, expect, test } from "bun:test"

import {
  getAllModelSettings,
  setModelSettingsForTest,
} from "../src/lib/model-settings"
import { getSentryModelName } from "../src/lib/sentry"

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

test("falls back to built-in Sentry model names", () => {
  expect(getSentryModelName("claude-opus-4.6")).toBe("claude-opus-4-6")
  expect(getSentryModelName("claude-opus-4.6:high")).toBe("claude-opus-4-6")
})
