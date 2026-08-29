import { expect, test } from "bun:test"

import type { SettingsData, TrustedJwtDigestEntry } from "../ui/src/lib/types"

import {
  TrustedJwtDigestInputError,
  addTrustedJwtDigest,
  loadSettingsBundle,
  trustedJwtDigestForSubmission,
} from "../ui/src/lib/types"

const settings: SettingsData = {
  version: "2.0.9",
  port: "4141",
  host: "127.0.0.1",
  authEnabled: true,
  multiToken: false,
  sentryEnabled: false,
  groqEnabled: true,
  dataDir: "C:/copilot-api",
  debug: false,
  verbose: false,
  passwordManagedExternally: false,
  codexCleanupModel: null,
  codexCleanupModelDefault: undefined,
  availableModels: [],
}

const trustedEntries: Array<TrustedJwtDigestEntry> = [
  {
    id: "6f9619ff-8b86-4be5-9c13-11c0c978a11",
    label: "Gaming PC",
    digest: "a".repeat(64),
    enabled: true,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
]

test("settings loader requests trusted JWT digests", async () => {
  const paths: Array<string> = []
  const result = await loadSettingsBundle(<T>(path: string): Promise<T> => {
    paths.push(path)
    if (path === "/dashboard/api/settings") {
      return Promise.resolve(settings as T)
    }
    if (path === "/dashboard/api/ip-allowlist") {
      return Promise.resolve([] as T)
    }
    if (path === "/dashboard/api/ip-allowlist/current") {
      return Promise.resolve({ ip: null } as T)
    }
    if (path === "/dashboard/api/trusted-jwt-digests") {
      return Promise.resolve(trustedEntries as T)
    }
    return Promise.reject(new Error(`Unexpected path: ${path}`))
  })

  expect(paths).toContain("/dashboard/api/trusted-jwt-digests")
  expect(result.trustedJwtDigests).toEqual(trustedEntries)
})

test("trusted JWT input trims labels and lowercases digests", () => {
  expect(
    trustedJwtDigestForSubmission("  Gaming PC  ", "A".repeat(64)),
  ).toEqual({ label: "Gaming PC", digest: "a".repeat(64) })
})

test("trusted JWT input rejects incomplete values before posting", () => {
  expect(() => trustedJwtDigestForSubmission("", "a".repeat(64))).toThrow(
    TrustedJwtDigestInputError,
  )
  expect(() => trustedJwtDigestForSubmission("PC", "not-a-digest")).toThrow(
    TrustedJwtDigestInputError,
  )
})

test("add trusted JWT digest posts normalized values", async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  const requestPost = <T>(path: string, body?: unknown): Promise<T> => {
    requests.push({ path, body })
    return Promise.resolve(undefined as T)
  }

  await addTrustedJwtDigest("  Gaming PC  ", "A".repeat(64), requestPost)

  expect(requests).toEqual([
    {
      path: "/dashboard/api/trusted-jwt-digests",
      body: { label: "Gaming PC", digest: "a".repeat(64) },
    },
  ])
})
