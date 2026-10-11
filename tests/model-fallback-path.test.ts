import { afterEach, beforeEach, expect, test } from "bun:test"

import { setConfigForTest } from "~/lib/config"
import { getModelFallbackIdentity } from "~/lib/model-fallback-identity"
import {
  hasAvailableFallbackModel,
  resolveAvailableModelFallback,
} from "~/lib/model-fallback-path"
import {
  resetModelRoutingOverridesForTest,
  setModelRoutingOverridesForTest,
} from "~/lib/model-routing"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

import { fallbackModels } from "./helpers/fallback-models"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalState = { ...state }

beforeEach(() => {
  setConfigForTest({})
  setModelRoutingOverridesForTest({})
  state.isMultiToken = false
  state.models = fallbackModels(["source", "target"])
})

afterEach(() => {
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  Object.assign(state, originalState)
  setConfigForTest(null)
  resetModelRoutingOverridesForTest()
})

function path(
  models: Array<string>,
  visitedModels: ReadonlySet<string> = new Set(),
) {
  return resolveAvailableModelFallback({
    config: {
      enabled: true,
      notifyClient: false,
      nativeClientNotice: false,
      rules: models.slice(1).map((targetModel, index) => ({
        id: String(index),
        sourceModel: models[index],
        targetModel,
        enabled: true,
      })),
    },
    redirects: [],
    request: { model: models[0] },
    visitedModels,
    reason: "refusal",
  })
}

test("path probes skip missing hops without consuming the attempt's visited models", () => {
  const visited = new Set([getModelFallbackIdentity("source")])
  const result = path(["source", "missing", "target"], visited)
  expect(result?.redirect.model).toBe("target")
  expect(result?.route).toEqual([
    {
      source: "source",
      target: "missing",
      resolved: "missing",
      reason: "refusal",
    },
    {
      source: "missing",
      target: "target",
      resolved: "target",
      reason: "unavailable",
    },
  ])
  expect([...visited]).toEqual(['["copilot","source"]'])
  expect(path(["source", "missing", "target"], visited)).toEqual(result)
})

test("a cycle through unavailable hops terminates without selecting the source", () => {
  expect(path(["source", "missing", "source"])).toBeUndefined()
})

test("a previously attempted target cannot be reached through an unavailable hop", () => {
  expect(
    path(
      ["source", "missing", "target"],
      new Set([getModelFallbackIdentity("target")]),
    ),
  ).toBeUndefined()
})

test.each(["disabled", "unhealthy", "deleting", "routing-disabled"])(
  "a single %s account does not make a fallback available through the legacy catalog",
  (unavailable) => {
    const account = tokenPool.addAccount("fixture-token", "individual", 17)
    account.models = new Set(["target"])
    account.modelsData = fallbackModels(["target"]).data
    account.healthy = unavailable !== "unhealthy"
    account.enabled = unavailable !== "disabled"
    account.deleting = unavailable === "deleting"
    if (unavailable === "routing-disabled")
      setModelRoutingOverridesForTest({ target: { "17": false } })
    tokenPool.rebuildModelIndex()
    state.models = fallbackModels(["source", "target"])
    expect(hasAvailableFallbackModel("target")).toBe(false)
    expect(path(["source", "target"])).toBeUndefined()
  },
)

test("multi-account mode with no accounts does not use a stale legacy catalog", () => {
  state.isMultiToken = true
  expect(hasAvailableFallbackModel("target")).toBe(false)
})

test.each(["embedding", "embeddings"])(
  "an advertised %s model is not an inference fallback provider",
  (type) => {
    state.models = fallbackModels(["source", "target"])
    state.models.data[1].capabilities.type = type
    expect(path(["source", "target"])).toBeUndefined()
  },
)

test("an explicit custom alias remains available when the same Copilot name is disabled", () => {
  const account = tokenPool.addAccount("fixture-token", "individual", 17)
  account.models = new Set(["target"])
  account.modelsData = fallbackModels(["target"]).data
  account.healthy = true
  account.enabled = false
  tokenPool.rebuildModelIndex()
  state.models = fallbackModels(["source", "target"])
  setConfigForTest({
    customProviders: [
      {
        id: "custom",
        name: "Custom",
        type: "openai-compatible",
        baseUrl: "https://custom.test/v1",
        models: [{ id: "custom-target", kind: "chat", aliases: ["target"] }],
      },
    ],
  })
  expect(path(["source", "target"])?.redirect.model).toBe("target")
})

test("an exact custom ID does not override a disabled catalogued Copilot model", () => {
  const account = tokenPool.addAccount("fixture-token", "individual", 17)
  account.models = new Set(["target"])
  account.modelsData = fallbackModels(["target"]).data
  account.healthy = true
  account.enabled = false
  tokenPool.rebuildModelIndex()
  state.models = fallbackModels(["source", "target"])
  setConfigForTest({
    customProviders: [
      {
        id: "custom",
        name: "Custom",
        type: "openai-compatible",
        baseUrl: "https://custom.test/v1",
        models: [{ id: "target", kind: "chat" }],
      },
    ],
  })
  expect(path(["source", "target"])).toBeUndefined()
})
