import { afterEach, describe, expect, test } from "bun:test"

import {
  getLoadedModelFallbackConfig,
  getModelFallbackConfig,
  getModelFallbackConfigRevision,
  setModelFallbackConfig,
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { initializeStorageRuntime } from "~/lib/storage/runtime"

import { createRuntimeStorage } from "./helpers/runtime-storage"

afterEach(() => setModelFallbackConfigForTest(null))

const rule = {
  id: "primary",
  sourceModel: "gpt-6-astra",
  targetModel: "claude-opus-4.6",
  enabled: true,
}

describe("model fallback configuration", () => {
  test("defaults to disabled fallbacks without legacy affinity controls", () => {
    expect(validateModelFallbackConfig({})).toEqual({
      enabled: false,
      notifyClient: false,
      nativeClientNotice: false,
      rules: [],
    })
  })

  test("accepts and strips the three legacy affinity settings", () => {
    expect(
      validateModelFallbackConfig({
        enabled: true,
        conversationAffinity: false,
        affinityTtlSeconds: 0,
        affinityMaxEntries: "unbounded",
        rules: [rule],
      }),
    ).toEqual({
      enabled: true,
      notifyClient: false,
      nativeClientNotice: false,
      rules: [rule],
    })
  })

  test("validates explicit models and prevents ambiguous active rules", () => {
    const invalid = [
      { ...rule, sourceModel: " " },
      { ...rule, targetModel: rule.sourceModel },
      { ...rule, id: "" },
      { ...rule, targetModel: "target\nmodel" },
      { ...rule, targetModel: "target model" },
    ]
    for (const entry of invalid) {
      expect(() => validateModelFallbackConfig({ rules: [entry] })).toThrow()
    }
    expect(() =>
      validateModelFallbackConfig({ rules: [rule, { ...rule, id: "second" }] }),
    ).toThrow()
    expect(() =>
      validateModelFallbackConfig({
        rules: [rule, { ...rule, enabled: false }],
      }),
    ).toThrow()
    expect(
      validateModelFallbackConfig({
        rules: [rule, { ...rule, id: "disabled", enabled: false }],
      }).rules,
    ).toHaveLength(2)
  })

  test("rejects unknown options other than the three legacy affinity settings", () => {
    for (const value of [
      { conversationAffinityEnabled: true },
      { affinityTtl: 86400 },
      { affinityEntries: 10000 },
      { statusCodes: [500] },
      { enabled: "true" },
    ]) {
      expect(() => validateModelFallbackConfig(value)).toThrow()
    }
  })

  test("publishes isolated config snapshots only after a valid update", async () => {
    setModelFallbackConfigForTest(validateModelFallbackConfig({}))
    const revision = getModelFallbackConfigRevision()
    const next = await setModelFallbackConfig({ enabled: true, rules: [rule] })
    expect(getModelFallbackConfigRevision()).toBeGreaterThan(revision)
    next.rules[0].targetModel = "mutated"
    expect(getLoadedModelFallbackConfig().rules[0].targetModel).toBe(
      rule.targetModel,
    )
    const rejected = await setModelFallbackConfig({ rules: [{}] }).then(
      () => false,
      () => true,
    )
    expect(rejected).toBe(true)
    expect((await getModelFallbackConfig()).enabled).toBe(true)
  })

  test("persists configuration atomically and retains the last good state after a storage failure", async () => {
    const fixture = await createRuntimeStorage()
    try {
      await initializeStorageRuntime(fixture)
      setModelFallbackConfigForTest(null)
      expect((await getModelFallbackConfig()).enabled).toBe(false)
      await Promise.all([
        setModelFallbackConfig({ enabled: false, rules: [rule] }),
        setModelFallbackConfig({ enabled: true, rules: [rule] }),
      ])
      setModelFallbackConfigForTest(null)
      expect((await getModelFallbackConfig()).rules).toEqual([rule])
      fixture.failCommits()
      expect(
        await setModelFallbackConfig({ enabled: false }).then(
          () => false,
          () => true,
        ),
      ).toBe(true)
      expect(getLoadedModelFallbackConfig().enabled).toBe(true)
      const persisted = await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT value_json FROM capi_settings WHERE namespace = ?",
          args: ["model_fallbacks"],
        }),
      )
      expect(
        validateModelFallbackConfig(
          JSON.parse(String(persisted[0]?.value_json)),
        ).enabled,
      ).toBe(true)
    } finally {
      await fixture.close()
    }
  })
})
