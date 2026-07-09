import { expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import nodeFs from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import {
  createStatsigOverrideStore,
  statsigOverrideStore,
  StatsigOverrideValidationError,
} from "~/routes/statsig-overrides/store"

async function withTestDir<T>(
  callback: (directory: string) => Promise<T> | T,
): Promise<T> {
  const directory = path.join(
    import.meta.dir,
    ".test-artifacts",
    `statsig-overrides-store-${randomUUID()}`,
  )
  await fs.mkdir(directory, { recursive: true })

  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function expectValidationError(
  action: () => unknown,
  expectedMessage: string,
): void {
  try {
    action()
    expect.unreachable("Expected StatsigOverrideValidationError")
  } catch (error) {
    expect(error).toBeInstanceOf(StatsigOverrideValidationError)
    expect((error as Error).message).toBe(expectedMessage)
  }
}

test("production singleton uses the default statsig override path", () => {
  expect(statsigOverrideStore.filePath).toBe(PATHS.STATSIG_OVERRIDES_PATH)
})

test("stores feature gates and dynamic configs independently", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )

    store.set("featureGate", "  gate-enabled  ", true)
    store.set("dynamicConfig", "config-values", {
      rollout: 50,
      nested: { enabled: true },
    })

    const snapshot = store.get()
    snapshot.featureGates["gate-enabled"] = false
    ;(
      snapshot.dynamicConfigs["config-values"] as {
        nested: { enabled: boolean }
      }
    ).nested.enabled = false

    expect(store.get()).toEqual({
      featureGates: { "gate-enabled": true },
      dynamicConfigs: {
        "config-values": { rollout: 50, nested: { enabled: true } },
      },
    })
    expect(store.count()).toBe(2)
  })
})

test("persists overrides across store instances", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "nested", "statsig_overrides.json")
    const firstStore = createStatsigOverrideStore(filePath)

    firstStore.set("featureGate", "copilot_gate", true)
    firstStore.set("dynamicConfig", "assistant_config", {
      mode: "shadow",
      sampleRate: 0.1,
    })

    const secondStore = createStatsigOverrideStore(filePath)

    expect(secondStore.get()).toEqual({
      featureGates: { copilot_gate: true },
      dynamicConfigs: {
        assistant_config: { mode: "shadow", sampleRate: 0.1 },
      },
    })
    expect(await fs.readFile(filePath, "utf8")).toBe(`{
  "featureGates": {
    "copilot_gate": true
  },
  "dynamicConfigs": {
    "assistant_config": {
      "mode": "shadow",
      "sampleRate": 0.1
    }
  }
}
`)
  })
})

test("loads a missing override file as empty overrides", async () => {
  await withTestDir((directory) => {
    const filePath = path.join(directory, "nested", "statsig_overrides.json")
    const store = createStatsigOverrideStore(filePath)

    expect(store.get()).toEqual({
      featureGates: {},
      dynamicConfigs: {},
    })
    expect(store.count()).toBe(0)
  })
})

test("throws for invalid JSON in an existing override file", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "statsig_overrides.json")
    await fs.writeFile(filePath, "{ invalid json", "utf8")

    const store = createStatsigOverrideStore(filePath)

    expect(() => store.get()).toThrow(SyntaxError)
  })
})

test("throws validation errors for invalid persisted override maps and values", async () => {
  await withTestDir(async (directory) => {
    const cases = [
      {
        name: "invalid feature gate map",
        fileContents: {
          featureGates: "not-an-object",
          dynamicConfigs: {},
        },
        message: "featureGates must be an object",
      },
      {
        name: "invalid feature gate value",
        fileContents: {
          featureGates: { gate: "true" },
          dynamicConfigs: {},
        },
        message: "feature gate value must be boolean",
      },
      {
        name: "invalid dynamic config map",
        fileContents: {
          featureGates: {},
          dynamicConfigs: [],
        },
        message: "dynamicConfigs must be an object",
      },
      {
        name: "invalid dynamic config value",
        fileContents: {
          featureGates: {},
          dynamicConfigs: { config: [] },
        },
        message: "dynamic config value must be a JSON object",
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      const filePath = path.join(directory, `invalid-${index}.json`)
      await fs.writeFile(
        filePath,
        `${JSON.stringify(testCase.fileContents, null, 2)}\n`,
        "utf8",
      )

      const store = createStatsigOverrideStore(filePath)

      try {
        store.get()
        expect.unreachable(`Expected validation error for ${testCase.name}`)
      } catch (error) {
        expect(error).toBeInstanceOf(StatsigOverrideValidationError)
        expect((error as Error).message).toBe(testCase.message)
      }
    }
  })
})

test("rejects invalid feature gate values", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )

    for (const value of [0, "true", null, { enabled: true }]) {
      expectValidationError(
        () => store.set("featureGate", "gate", value),
        "feature gate value must be boolean",
      )
    }
  })
})

test("rejects invalid dynamic config values", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )

    for (const value of [true, null, [], "config", new Date()]) {
      expectValidationError(
        () => store.set("dynamicConfig", "config", value),
        "dynamic config value must be a JSON object",
      )
    }
  })
})

test("rejects nested non-JSON dynamic config values", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )
    const cyclicValue: Record<string, unknown> = { nested: { enabled: true } }
    cyclicValue.self = cyclicValue
    const sparseArray: Array<unknown> = Array(2)
    sparseArray[1] = 1

    for (const value of [
      { nested: { updatedAt: new Date() } },
      { nested: { missing: undefined } },
      { nested: { sampleRate: Number.POSITIVE_INFINITY } },
      { nested: sparseArray },
      cyclicValue,
    ]) {
      expectValidationError(
        () => store.set("dynamicConfig", "config", value),
        "dynamic config value must be a JSON object",
      )
    }
  })
})

test("rejects unsafe override names", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )

    for (const name of ["__proto__", "prototype", "constructor"]) {
      expectValidationError(
        () => store.set("featureGate", name, true),
        "name is not allowed",
      )
      expectValidationError(
        () => store.set("dynamicConfig", name, { enabled: true }),
        "name is not allowed",
      )
    }
  })
})

test("rejects blank override names", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )

    for (const name of ["", " ", "\n\t "]) {
      expectValidationError(
        () => store.set("featureGate", name, true),
        "name is required",
      )
      expectValidationError(
        () => store.remove("dynamicConfig", name),
        "name is required",
      )
    }
  })
})

test("removal is isolated by override kind", async () => {
  await withTestDir((directory) => {
    const store = createStatsigOverrideStore(
      path.join(directory, "statsig_overrides.json"),
    )

    store.set("featureGate", "shared-name", true)
    store.set("dynamicConfig", "shared-name", { enabled: true })

    expect(store.remove("featureGate", "shared-name")).toBe(true)
    expect(store.get()).toEqual({
      featureGates: {},
      dynamicConfigs: { "shared-name": { enabled: true } },
    })
    expect(store.count()).toBe(1)

    expect(store.remove("dynamicConfig", "shared-name")).toBe(true)
    expect(store.get()).toEqual({
      featureGates: {},
      dynamicConfigs: {},
    })
    expect(store.count()).toBe(0)
  })
})

test("remove persists the deleted entry without affecting the other override kind", async () => {
  await withTestDir((directory) => {
    const filePath = path.join(directory, "statsig_overrides.json")
    const store = createStatsigOverrideStore(filePath)

    store.set("featureGate", "shared-name", true)
    store.set("dynamicConfig", "shared-name", { enabled: true })

    expect(store.remove("featureGate", "shared-name")).toBe(true)

    const reloadedStore = createStatsigOverrideStore(filePath)
    expect(reloadedStore.get()).toEqual({
      featureGates: {},
      dynamicConfigs: { "shared-name": { enabled: true } },
    })
  })
})

test("replaceForTest swaps the cache and disables persistence", async () => {
  await withTestDir((directory) => {
    const filePath = path.join(directory, "statsig_overrides.json")
    const store = createStatsigOverrideStore(filePath)

    store.set("featureGate", "persisted", true)
    store.replaceForTest({
      featureGates: { ephemeral: false },
      dynamicConfigs: { preview: { enabled: true } },
    })
    store.set("dynamicConfig", "runtime-only", { cohort: "beta" })

    expect(store.get()).toEqual({
      featureGates: { ephemeral: false },
      dynamicConfigs: {
        preview: { enabled: true },
        "runtime-only": { cohort: "beta" },
      },
    })

    const persistedStore = createStatsigOverrideStore(filePath)
    expect(persistedStore.get()).toEqual({
      featureGates: { persisted: true },
      dynamicConfigs: {},
    })
  })
})

test("set leaves the cache unchanged when persistence fails", async () => {
  await withTestDir(async (directory) => {
    const blockedParent = path.join(directory, "blocked-parent")
    const store = createStatsigOverrideStore(
      path.join(blockedParent, "statsig_overrides.json"),
    )

    expect(store.get()).toEqual({
      featureGates: {},
      dynamicConfigs: {},
    })
    await fs.writeFile(blockedParent, "not a directory")

    expect(() => store.set("featureGate", "should-not-stick", true)).toThrow()
    expect(store.get()).toEqual({
      featureGates: {},
      dynamicConfigs: {},
    })
  })
})

test("set preserves the prior file and cache when atomic replacement fails", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "statsig_overrides.json")
    const store = createStatsigOverrideStore(filePath)

    store.set("featureGate", "persisted", true)

    const originalRenameSync = nodeFs.renameSync
    nodeFs.renameSync = mock(() => {
      throw new Error("rename failed")
    }) as typeof nodeFs.renameSync

    try {
      expect(() => store.set("featureGate", "next-value", false)).toThrow(
        "rename failed",
      )
    } finally {
      nodeFs.renameSync = originalRenameSync
    }

    expect(await fs.readFile(filePath, "utf8")).toBe(`{
  "featureGates": {
    "persisted": true
  },
  "dynamicConfigs": {}
}
`)
    expect(store.get()).toEqual({
      featureGates: { persisted: true },
      dynamicConfigs: {},
    })
    expect(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([])
  })
})

test("remove leaves the cache unchanged when persistence fails", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "statsig_overrides.json")
    const store = createStatsigOverrideStore(filePath)

    store.set("featureGate", "persisted", true)
    await fs.rm(filePath)
    await fs.mkdir(filePath)

    expect(() => store.remove("featureGate", "persisted")).toThrow()
    expect(store.get()).toEqual({
      featureGates: { persisted: true },
      dynamicConfigs: {},
    })
    expect(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([])
  })
})
