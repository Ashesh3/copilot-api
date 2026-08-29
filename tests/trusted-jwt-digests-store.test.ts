import { expect, mock, test } from "bun:test"
import crypto from "node:crypto"
import { createHash, randomUUID } from "node:crypto"
import nodeFs from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import {
  createTrustedJwtDigestStore,
  trustedJwtDigestStore,
  TrustedJwtDigestConflictError,
  TrustedJwtDigestValidationError,
} from "~/lib/trusted-jwt-digests"

const FIRST_ID = "6f9619ff-8b86-4be5-9c13-11c0c978a111"
const SECOND_ID = "6f9619ff-8b86-4be5-9c13-11c0c978a222"
const CREATED_AT = "2026-08-29T05:00:00.000Z"
const UPDATED_AT = "2026-08-29T06:00:00.000Z"

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

async function withTestDir<T>(
  callback: (directory: string) => Promise<T> | T,
): Promise<T> {
  const directory = path.join(
    import.meta.dir,
    ".test-artifacts",
    `trusted-jwt-digests-${randomUUID()}`,
  )
  await fs.mkdir(directory, { recursive: true })

  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function persistedEntry(
  overrides: Partial<{
    id: unknown
    label: unknown
    digest: unknown
    enabled: unknown
    createdAt: unknown
    updatedAt: unknown
  }> = {},
): Record<string, unknown> {
  return {
    id: FIRST_ID,
    label: "Desktop",
    digest: sha256("desktop-token"),
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

async function writeRegistry(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function expectValidationError(action: () => unknown): void {
  try {
    action()
    expect.unreachable("Expected TrustedJwtDigestValidationError")
  } catch (error) {
    expect(error).toBeInstanceOf(TrustedJwtDigestValidationError)
  }
}

test("production singleton uses the managed trusted JWT path", () => {
  expect(trustedJwtDigestStore.filePath).toBe(PATHS.TRUSTED_JWT_DIGESTS_PATH)
})

test("a missing registry starts empty", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "nested", "trusted_jwt_digests.json"),
    )

    expect(store.list()).toEqual([])
  })
})

test("adds normalized records and persists a versioned registry", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "trusted_jwt_digests.json")
    const store = createTrustedJwtDigestStore(filePath)
    const digest = sha256("device-token")

    const added = store.add({
      label: "  Living-room PC  ",
      digest: digest.toUpperCase(),
    })

    expect(added).toMatchObject({
      label: "Living-room PC",
      digest,
      enabled: true,
    })
    expect(added.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(new Date(added.createdAt).toISOString()).toBe(added.createdAt)
    expect(added.updatedAt).toBe(added.createdAt)
    expect(createTrustedJwtDigestStore(filePath).list()).toEqual([added])
    const persisted = await fs.readFile(filePath)
    // @ts-expect-error JSON.parse accepts UTF-8 buffers at runtime.
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      entries: [added],
    })
  })
})

test("returned records are clones", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    const added = store.add({ label: "Laptop", digest: sha256("laptop") })

    added.label = "mutated add result"
    const listed = store.list()
    const [listedEntry] = listed
    expect(listedEntry).toBeDefined()
    listedEntry.label = "mutated list result"
    listed.push({ ...listedEntry, id: SECOND_ID })

    const actual = store.list()
    expect(actual).toHaveLength(1)
    expect(actual[0]?.label).toBe("Laptop")
    expect(actual[0]?.digest).toBe(sha256("laptop"))
  })
})

test("matches only enabled raw credentials and rejects digest literals", async () => {
  await withTestDir((directory) => {
    const rawCredential = "header.payload.signature"
    const digest = sha256(rawCredential)
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    const added = store.add({ label: "Laptop", digest })

    expect(store.findEnabledCredential(`  ${rawCredential}\n`)?.id).toBe(
      added.id,
    )
    expect(store.containsDigestLiteral(` ${digest.toUpperCase()} `)).toBe(true)
    expect(store.findEnabledCredential(digest)).toBeNull()
    expect(store.setEnabled(added.id, false)?.enabled).toBe(false)
    expect(store.findEnabledCredential(rawCredential)).toBeNull()
    expect(store.containsDigestLiteral(digest)).toBe(true)
    expect(store.remove(added.id)).toBe(true)
    expect(store.containsDigestLiteral(digest)).toBe(false)
  })
})

test("all-record matching includes enabled and disabled managed credentials", async () => {
  await withTestDir((directory) => {
    const enabledCredential = "enabled.header.payload"
    const disabledCredential = "disabled.header.payload"
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    store.add({ label: "Enabled", digest: sha256(enabledCredential) })
    const disabled = store.add({
      label: "Disabled",
      digest: sha256(disabledCredential),
    })
    store.setEnabled(disabled.id, false)

    expect(store.matchesCredentialDigest(` ${enabledCredential} `)).toBe(true)
    expect(store.matchesCredentialDigest(`\n${disabledCredential}\t`)).toBe(
      true,
    )
    expect(store.matchesCredentialDigest("unknown.header.payload")).toBe(false)
    expect(store.findEnabledCredential(disabledCredential)).toBeNull()
  })
})

test("credential matching compares against every enabled and disabled digest", async () => {
  await withTestDir((directory) => {
    const rawCredential = "first.header.payload"
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    const first = store.add({ label: "First", digest: sha256(rawCredential) })
    store.add({ label: "Enabled", digest: sha256("enabled.header.payload") })
    const disabled = store.add({
      label: "Disabled",
      digest: sha256("disabled.header.payload"),
    })
    store.setEnabled(disabled.id, false)
    let comparisonCount = 0
    const originalTimingSafeEqual = crypto.timingSafeEqual
    const countingTimingSafeEqual: typeof crypto.timingSafeEqual = (
      left,
      right,
    ) => {
      comparisonCount += 1
      return originalTimingSafeEqual(left, right)
    }
    crypto.timingSafeEqual = mock(
      countingTimingSafeEqual,
    ) as typeof crypto.timingSafeEqual

    try {
      expect(store.matchesCredentialDigest(rawCredential)).toBe(true)
      expect(comparisonCount).toBe(3)
      comparisonCount = 0
      expect(store.findEnabledCredential(rawCredential)?.id).toBe(first.id)
      expect(comparisonCount).toBe(3)
    } finally {
      crypto.timingSafeEqual = originalTimingSafeEqual
    }
  })
})

test("rejects invalid labels", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )

    for (const label of [
      "",
      " \t ",
      "x".repeat(81),
      "desktop\u0000name",
      "desktop\nname",
      "desktop\u007fname",
    ]) {
      expectValidationError(() =>
        store.add({ label, digest: sha256(`token-${label}`) }),
      )
    }
  })
})

test("rejects non-SHA-256 hexadecimal digests", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )

    for (const digest of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      `${"a".repeat(63)}g`,
      ` ${"a".repeat(64)}`,
    ]) {
      expectValidationError(() => store.add({ label: "Device", digest }))
    }
  })
})

test("rejects duplicate digests regardless of case", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    const digest = sha256("same-device")
    store.add({ label: "First", digest })

    expect(() =>
      store.add({ label: "Second", digest: digest.toUpperCase() }),
    ).toThrow(TrustedJwtDigestConflictError)
    expect(store.list()).toHaveLength(1)
  })
})

test("rejects duplicate persisted IDs and digests", async () => {
  await withTestDir(async (directory) => {
    const duplicateCases = [
      [persistedEntry(), persistedEntry({ digest: sha256("other-token") })],
      [
        persistedEntry(),
        persistedEntry({
          id: SECOND_ID,
          digest: sha256("desktop-token").toUpperCase(),
        }),
      ],
    ]

    for (const [index, entries] of duplicateCases.entries()) {
      const filePath = path.join(directory, `duplicate-${index}.json`)
      await writeRegistry(filePath, { version: 1, entries })

      expectValidationError(() => createTrustedJwtDigestStore(filePath).list())
    }
  })
})

test("fails closed for malformed persisted registries", async () => {
  await withTestDir(async (directory) => {
    const invalidCases: Array<{ name: string; value: unknown }> = [
      { name: "top-level array", value: [] },
      { name: "wrong version", value: { version: 2, entries: [] } },
      { name: "string version", value: { version: "1", entries: [] } },
      { name: "wrong entries type", value: { version: 1, entries: {} } },
      {
        name: "non-object entry",
        value: { version: 1, entries: [null] },
      },
      {
        name: "non-UUID ID",
        value: {
          version: 1,
          entries: [persistedEntry({ id: "device-one" })],
        },
      },
      {
        name: "wrong label type",
        value: { version: 1, entries: [persistedEntry({ label: 7 })] },
      },
      {
        name: "wrong digest type",
        value: { version: 1, entries: [persistedEntry({ digest: 7 })] },
      },
      {
        name: "wrong enabled type",
        value: {
          version: 1,
          entries: [persistedEntry({ enabled: "true" })],
        },
      },
      {
        name: "non-ISO created timestamp",
        value: {
          version: 1,
          entries: [persistedEntry({ createdAt: "2026-08-29" })],
        },
      },
      {
        name: "invalid updated timestamp",
        value: {
          version: 1,
          entries: [persistedEntry({ updatedAt: "not-a-date" })],
        },
      },
      {
        name: "wrong timestamp type",
        value: {
          version: 1,
          entries: [persistedEntry({ updatedAt: 1_788_000_000 })],
        },
      },
      {
        name: "unexpected top-level field",
        value: { version: 1, entries: [], rawJwt: "must-not-be-accepted" },
      },
      {
        name: "unexpected entry field",
        value: {
          version: 1,
          entries: [{ ...persistedEntry(), rawJwt: "must-not-be-accepted" }],
        },
      },
    ]

    for (const [index, invalidCase] of invalidCases.entries()) {
      const filePath = path.join(directory, `invalid-${index}.json`)
      await writeRegistry(filePath, invalidCase.value)

      try {
        createTrustedJwtDigestStore(filePath).list()
        expect.unreachable(`Expected rejection for ${invalidCase.name}`)
      } catch (error) {
        expect(error).toBeInstanceOf(TrustedJwtDigestValidationError)
      }
    }

    const invalidJsonPath = path.join(directory, "invalid-json.json")
    await fs.writeFile(invalidJsonPath, "{ invalid json", "utf8")
    expect(() => createTrustedJwtDigestStore(invalidJsonPath).list()).toThrow(
      SyntaxError,
    )
  })
})

test("setEnabled validates booleans and returns null for unknown UUIDs", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    const added = store.add({ label: "Desktop", digest: sha256("desktop") })

    expectValidationError(() =>
      store.setEnabled(added.id, "false" as unknown as boolean),
    )
    expect(store.setEnabled(SECOND_ID, false)).toBeNull()
    expect(store.list()[0]?.enabled).toBe(true)
  })
})

test("remove returns false for an unknown UUID", async () => {
  await withTestDir((directory) => {
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    store.add({ label: "Desktop", digest: sha256("desktop") })

    expect(store.remove(SECOND_ID)).toBe(false)
    expect(store.list()).toHaveLength(1)
  })
})

test("test replacement is isolated from disk and reset reloads persistence", async () => {
  await withTestDir((directory) => {
    const filePath = path.join(directory, "trusted_jwt_digests.json")
    const store = createTrustedJwtDigestStore(filePath)
    const persisted = store.add({
      label: "Persisted",
      digest: sha256("persisted"),
    })
    const replacement = {
      id: SECOND_ID,
      label: "Ephemeral",
      digest: sha256("ephemeral"),
      enabled: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    }

    store.replaceForTest([replacement])
    store.setEnabled(replacement.id, false)
    expect(store.list()).toMatchObject([{ id: replacement.id, enabled: false }])
    expect(createTrustedJwtDigestStore(filePath).list()).toEqual([persisted])

    store.resetAfterTest()
    expect(store.list()).toEqual([persisted])
    expect(store.setEnabled(persisted.id, false)?.enabled).toBe(false)
    expect(createTrustedJwtDigestStore(filePath).list()[0]?.enabled).toBe(false)
  })
})

test("failed atomic replacement preserves the prior file and cache", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "trusted_jwt_digests.json")
    const store = createTrustedJwtDigestStore(filePath)
    const persisted = store.add({
      label: "Persisted",
      digest: sha256("persisted"),
    })
    const priorContents = await fs.readFile(filePath, "utf8")
    const originalRenameSync = nodeFs.renameSync
    nodeFs.renameSync = mock(() => {
      throw new Error("rename failed")
    }) as typeof nodeFs.renameSync

    try {
      expect(() => store.setEnabled(persisted.id, false)).toThrow(
        "rename failed",
      )
    } finally {
      nodeFs.renameSync = originalRenameSync
    }

    expect(await fs.readFile(filePath, "utf8")).toBe(priorContents)
    expect(store.list()).toEqual([persisted])
    expect(
      (await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([])
  })
})

test("a blocked parent path leaves the initial empty cache unchanged", async () => {
  await withTestDir(async (directory) => {
    const blockedParent = path.join(directory, "blocked-parent")
    const store = createTrustedJwtDigestStore(
      path.join(blockedParent, "trusted_jwt_digests.json"),
    )
    expect(store.list()).toEqual([])
    await fs.writeFile(blockedParent, "not a directory", "utf8")

    expect(() =>
      store.add({ label: "Must not stick", digest: sha256("not-stored") }),
    ).toThrow()
    expect(store.list()).toEqual([])
  })
})
