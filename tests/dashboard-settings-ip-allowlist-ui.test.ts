import { expect, test } from "bun:test"

import type { IpAllowlistEntry, SettingsData } from "../ui/src/lib/types"

import {
  IpAddressRequiredError,
  addIpAllowlistEntry,
  clearIpAllowlist,
  loadSettingsBundle,
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

const allowlist: Array<IpAllowlistEntry> = [
  {
    ip: "192.0.2.10",
    enabled: true,
    source: "dashboard",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  },
]

test("settings loader requests the current IP with the settings and allowlist", async () => {
  const paths: Array<string> = []
  const requestGet = <T>(path: string): Promise<T> => {
    paths.push(path)
    const responses: Record<string, unknown> = {
      "/dashboard/api/settings": settings,
      "/dashboard/api/ip-allowlist": allowlist,
      "/dashboard/api/ip-allowlist/current": { ip: "198.51.100.24" },
    }
    return Promise.resolve(responses[path] as T)
  }

  const bundle = await loadSettingsBundle(requestGet)
  expect(bundle).toEqual({
    settings,
    allowlist,
    currentIp: "198.51.100.24",
  })
  expect(paths.sort()).toEqual(
    [
      "/dashboard/api/settings",
      "/dashboard/api/ip-allowlist",
      "/dashboard/api/ip-allowlist/current",
    ].sort(),
  )
})

test("settings loader keeps the page available when current-IP lookup fails", async () => {
  const requestGet = <T>(path: string): Promise<T> => {
    if (path === "/dashboard/api/settings") {
      return Promise.resolve(settings as T)
    }
    if (path === "/dashboard/api/ip-allowlist") {
      return Promise.resolve(allowlist as T)
    }
    return Promise.reject(new Error("current IP unavailable"))
  }

  const bundle = await loadSettingsBundle(requestGet)
  expect(bundle).toEqual({
    settings,
    allowlist,
    currentIp: null,
  })
})

test("blank Add posts the displayed current IP", async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  const requestPost = <T>(path: string, body?: unknown): Promise<T> => {
    requests.push({ path, body })
    return Promise.resolve(undefined as T)
  }

  await addIpAllowlistEntry("", "198.51.100.24", requestPost)

  expect(requests).toEqual([
    {
      path: "/dashboard/api/ip-allowlist",
      body: { ip: "198.51.100.24", enabled: true },
    },
  ])
})

test("manual Add trims and posts the entered IP instead of the current IP", async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  const requestPost = <T>(path: string, body?: unknown): Promise<T> => {
    requests.push({ path, body })
    return Promise.resolve(undefined as T)
  }

  await addIpAllowlistEntry(" 2001:db8::7 ", "198.51.100.24", requestPost)

  expect(requests[0]).toEqual({
    path: "/dashboard/api/ip-allowlist",
    body: { ip: "2001:db8::7", enabled: true },
  })
})

test("blank Add remains required when no current IP is available", async () => {
  let postCount = 0
  const requestPost = <T>(): Promise<T> => {
    postCount += 1
    return Promise.resolve(undefined as T)
  }

  let caught: unknown
  try {
    await addIpAllowlistEntry("", null, requestPost)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(IpAddressRequiredError)
  expect(postCount).toBe(0)
})

test("Clear all uses the collection DELETE contract and propagates failures", async () => {
  const paths: Array<string> = []
  const requestDelete = <T>(path: string): Promise<T> => {
    paths.push(path)
    return Promise.resolve({ success: true, cleared: 2 } as T)
  }

  const result = await clearIpAllowlist(requestDelete)
  expect(result).toEqual({
    success: true,
    cleared: 2,
  })
  expect(paths).toEqual(["/dashboard/api/ip-allowlist"])

  const failure = new Error("clear failed")
  let caught: unknown
  try {
    await clearIpAllowlist(() => Promise.reject(failure))
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
})
