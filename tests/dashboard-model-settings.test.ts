import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  loadModelSettings,
  MAX_FORCED_SYSTEM_PROMPT_LENGTH,
} from "~/lib/model-settings"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import { DASHBOARD_HTML } from "~/routes/dashboard/page-generated"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const settingsPath = "/dashboard/api/model-settings"
let adminSession: TestAdminSession

beforeEach(async () => {
  adminSession = await createTestAdminSession()
  // Use stored settings, not an override left by another suite.
  await loadModelSettings()
})

afterEach(async () => {
  await resetTestAdminSession()
})

async function save(body: unknown): Promise<Response> {
  return server.request(settingsPath, {
    method: "POST",
    headers: adminHeaders(adminSession),
    body: JSON.stringify(body),
  })
}

async function list(): Promise<unknown> {
  const response = await server.request(settingsPath, {
    headers: adminHeaders(adminSession, false),
  })
  expect(response.status).toBe(200)
  return await response.json()
}

test.each(["clearOtherSystemPrompts", "forceAppendSystemPrompt"])(
  "saves a trimmed forced prompt with %s across a storage restart",
  async (mode) => {
    const response = await save({
      model: "claude-opus-5.5",
      forcedSystemPrompt: "  Be brief.\nCite files.  \n",
      [mode]: true,
    })

    expect(response.status).toBe(200)
    const saved = {
      model: "claude-opus-5.5",
      forcedSystemPrompt: "Be brief.\nCite files.",
      [mode]: true,
    }
    expect(await response.json()).toEqual(saved)
    const storageConfig = getStorageRuntime().config
    await closeStorageRuntime()
    await initializeStorageRuntime({ config: storageConfig })
    expect(await list()).toEqual([saved])
  },
)

test.each(["clearOtherSystemPrompts", "forceAppendSystemPrompt"])(
  "%s applies only with a prompt, and removing the prompt clears it",
  async (mode) => {
    expect(
      await (await save({ model: "gpt-5.5", [mode]: true })).json(),
    ).toEqual({ model: "gpt-5.5" })
    expect(await list()).toEqual([])

    await save({
      model: "gpt-5.5",
      forcedSystemPrompt: "Be brief.",
      [mode]: true,
    })
    expect(
      (await save({ model: "gpt-5.5", forcedSystemPrompt: "   " })).status,
    ).toBe(200)
    expect(await list()).toEqual([])
  },
)

test.each([
  [{ forcedSystemPrompt: 42 }, "forcedSystemPrompt is invalid"],
  [
    { forcedSystemPrompt: "x".repeat(MAX_FORCED_SYSTEM_PROMPT_LENGTH + 1) },
    "forcedSystemPrompt must be at most 200,000 characters",
  ],
  [
    { forcedSystemPrompt: "Be brief.", clearOtherSystemPrompts: "yes" },
    "clearOtherSystemPrompts is invalid",
  ],
  [
    { forcedSystemPrompt: "Be brief.", forceAppendSystemPrompt: "yes" },
    "forceAppendSystemPrompt is invalid",
  ],
  [
    {
      forcedSystemPrompt: "Be brief.",
      clearOtherSystemPrompts: true,
      forceAppendSystemPrompt: true,
    },
    "forceAppendSystemPrompt cannot be combined with clearOtherSystemPrompts",
  ],
])("rejects invalid forced prompt fields %#", async (fields, error) => {
  const response = await save({ model: "gpt-5.5", ...fields })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error })
  expect(await list()).toEqual([])
})

test("the dashboard bundle includes the forced system prompt controls", () => {
  expect(DASHBOARD_HTML).toContain("Forced system prompt")
  expect(DASHBOARD_HTML).toContain("Clear other system prompts")
  expect(DASHBOARD_HTML).toContain("Force append")
})

test("switching prompt modes clears the previous mode and preserves prompt edits", async () => {
  const model = "gpt-5.5"
  await save({
    model,
    forcedSystemPrompt: "Be brief.",
    clearOtherSystemPrompts: true,
  })

  expect(
    await (await save({ model, forceAppendSystemPrompt: true })).json(),
  ).toEqual({
    model,
    forcedSystemPrompt: "Be brief.",
    forceAppendSystemPrompt: true,
  })
  expect(
    await (await save({ model, forcedSystemPrompt: "Use examples." })).json(),
  ).toEqual({
    model,
    forcedSystemPrompt: "Use examples.",
    forceAppendSystemPrompt: true,
  })
  expect(
    await (await save({ model, clearOtherSystemPrompts: true })).json(),
  ).toEqual({
    model,
    forcedSystemPrompt: "Use examples.",
    clearOtherSystemPrompts: true,
  })
})

test.each([false, null])(
  "force append can be disabled with %s",
  async (value) => {
    const model = "gpt-5.5"
    await save({
      model,
      forcedSystemPrompt: "Be brief.",
      forceAppendSystemPrompt: true,
    })

    expect(
      await (await save({ model, forceAppendSystemPrompt: value })).json(),
    ).toEqual({
      model,
      forcedSystemPrompt: "Be brief.",
    })
  },
)

test("Omit replaces the effort levels and survives a storage restart", async () => {
  const model = "claude-haiku-4.5"
  await save({
    model,
    exposeVirtualReasoningModels: false,
    supportedReasoningEfforts: ["none"],
    defaultReasoningEffort: "none",
  })

  const response = await save({
    model,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    omitReasoningEffort: true,
  })

  expect(response.status).toBe(200)
  const saved = {
    model,
    exposeVirtualReasoningModels: false,
    omitReasoningEffort: true,
  }
  expect(await response.json()).toEqual(saved)
  const storageConfig = getStorageRuntime().config
  await closeStorageRuntime()
  await initializeStorageRuntime({ config: storageConfig })
  expect(await list()).toEqual([saved])
})

test("saving effort levels turns Omit off", async () => {
  const model = "claude-haiku-4.5"
  await save({ model, omitReasoningEffort: true })

  const response = await save({
    model,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
  })

  expect(await response.json()).toEqual({
    model,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
  })
  expect(
    await (await save({ model, supportedReasoningEfforts: null })).json(),
  ).toEqual({ model, defaultReasoningEffort: "low" })
})

test.each([
  [{ omitReasoningEffort: "yes" }, "omitReasoningEffort is invalid"],
  [
    { omitReasoningEffort: true, supportedReasoningEfforts: ["low"] },
    "omitReasoningEffort cannot be combined with supportedReasoningEfforts or defaultReasoningEffort",
  ],
  [
    { omitReasoningEffort: true, defaultReasoningEffort: "high" },
    "omitReasoningEffort cannot be combined with supportedReasoningEfforts or defaultReasoningEffort",
  ],
])("rejects invalid Omit settings %#", async (fields, error) => {
  const response = await save({ model: "claude-haiku-4.5", ...fields })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error })
  expect(await list()).toEqual([])
})

test("the dashboard bundle includes the Omit effort control", () => {
  expect(DASHBOARD_HTML).toContain(
    "Requests to this model are sent without a reasoning effort.",
  )
})
