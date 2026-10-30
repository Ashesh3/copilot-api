import "./helpers/auth-misc-data-dir"

import { afterAll, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { state } from "~/lib/state"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import { trustedJwtDigestStore } from "~/lib/trusted-jwt-digests"
import { server } from "~/server"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const feature = "model_picker_reasoning_effort_visibility"
const efforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]
const originalApiKeyAuth = state.apiKeyAuth

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url")

async function identity(account = "account-a", user = "user-a") {
  const jwt = [
    encode({ alg: "none" }),
    encode({
      "https://api.openai.com/auth": {
        chatgpt_account_id: account,
        chatgpt_user_id: user,
        chatgpt_plan_type: "free",
      },
    }),
    "local-signature",
  ].join(".")
  const entry = await trustedJwtDigestStore.add({
    label: "Settings test",
    digest: createHash("sha256").update(jwt).digest("hex"),
  })
  return { jwt, entry }
}

function read(jwt?: string, prefix = "", headers: Record<string, string> = {}) {
  return server.request(`${prefix}/settings/user`, {
    headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...headers },
  })
}

function patch(
  jwt: string,
  value: unknown,
  options: {
    prefix?: string
    headers?: Record<string, string>
    feature?: string
  } = {},
) {
  const query = new URLSearchParams({
    feature: options.feature ?? feature,
    value: JSON.stringify(value),
  })
  return server.request(
    `${options.prefix ?? ""}/settings/account_user_setting?${query.toString()}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${jwt}`, ...options.headers },
    },
  )
}

async function visibility(response: Response) {
  const body = (await response.json()) as {
    settings?: Record<string, unknown>
  } & Record<string, unknown>
  return body.settings?.[feature] ?? body[feature]
}

beforeEach(() => {
  trustedJwtDigestStore.resetAfterTest()
  state.apiKeyAuth = undefined
})
afterAll(() => {
  trustedJwtDigestStore.resetAfterTest()
  state.apiKeyAuth = originalApiKeyAuth
})

test.each(["", "/backend-api"])(
  "%s settings enables every effort without plan restrictions",
  async (prefix) => {
    const { jwt } = await identity()
    const response = await read(jwt, prefix)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("pragma")).toBe("no-cache")
    expect(await response.json()).toEqual({
      settings: {
        [feature]: {
          enabled: efforts,
          source: "default",
          uses_defaults: true,
        },
      },
    })
  },
)

test("explicit display choices persist across restart and reset restores every effort", async () => {
  const { jwt } = await identity()
  const response = await patch(jwt, { ultra: false, max: false })
  expect(response.status).toBe(200)
  expect(await visibility(response)).toEqual({
    enabled: [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "persistent",
    ],
    source: "user",
    uses_defaults: false,
  })
  const config = getStorageRuntime().config
  await closeStorageRuntime()
  await initializeStorageRuntime({ config })
  expect(await visibility(await read(jwt))).toEqual({
    enabled: [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "persistent",
    ],
    source: "user",
    uses_defaults: false,
  })
  expect(
    (await patch(jwt, { ultra: true }, { prefix: "/backend-api" })).status,
  ).toBe(200)
  expect(await visibility(await read(jwt))).toEqual({
    enabled: [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultra",
      "persistent",
    ],
    source: "user",
    uses_defaults: false,
  })
  expect((await patch(jwt, {})).status).toBe(200)
  expect(await visibility(await read(jwt))).toEqual({
    enabled: efforts,
    source: "user",
    uses_defaults: true,
  })
})

test("preferences are isolated by both authenticated account and user", async () => {
  const first = await identity()
  const otherAccount = await identity("account-b")
  const otherUser = await identity("account-a", "user-b")
  expect((await patch(first.jwt, { high: false })).status).toBe(200)
  for (const { jwt } of [otherAccount, otherUser]) {
    expect(await visibility(await read(jwt))).toEqual({
      enabled: efforts,
      source: "default",
      uses_defaults: true,
    })
  }
})

test("legacy migration is create-only and cannot overwrite a user's preference", async () => {
  const { jwt } = await identity()
  const headers = { "if-none-match": "*" }
  const migrated = await patch(jwt, { max: true, ultra: true }, { headers })
  expect(migrated.status).toBe(200)
  expect(await visibility(migrated)).toEqual({
    enabled: efforts,
    source: "migrated",
    uses_defaults: false,
  })
  expect((await patch(jwt, { high: false })).status).toBe(200)
  expect((await patch(jwt, { high: true }, { headers })).status).toBe(412)
  expect(await visibility(await read(jwt))).toEqual({
    enabled: [
      "none",
      "minimal",
      "low",
      "medium",
      "xhigh",
      "max",
      "ultra",
      "persistent",
    ],
    source: "user",
    uses_defaults: false,
  })
})

test("concurrent partial changes retain both user choices", async () => {
  const { jwt } = await identity()
  const responses = await Promise.all([
    patch(jwt, { low: false }),
    patch(jwt, { medium: false }),
  ])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(await visibility(await read(jwt))).toEqual({
    enabled: ["none", "minimal", "high", "xhigh", "max", "ultra", "persistent"],
    source: "user",
    uses_defaults: false,
  })
})

test("reset remains a deliberate user choice when legacy migration retries", async () => {
  const { jwt } = await identity()
  expect((await patch(jwt, {})).status).toBe(200)
  expect(
    (await patch(jwt, { max: false }, { headers: { "if-none-match": "*" } }))
      .status,
  ).toBe(412)
  expect(await visibility(await read(jwt))).toEqual({
    enabled: efforts,
    source: "user",
    uses_defaults: true,
  })
})

test("concurrent migrations publish only one initial preference", async () => {
  const { jwt } = await identity()
  const responses = await Promise.all([
    patch(jwt, { max: false }, { headers: { "if-none-match": "*" } }),
    patch(jwt, { ultra: false }, { headers: { "if-none-match": "*" } }),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 412,
  ])
})

test("settings rejects missing, gateway-only, revoked, and conflicting credentials", async () => {
  expect((await read()).status).toBe(401)
  const { jwt, entry } = await identity()
  expect((await read(jwt, "", { "chatgpt-account-id": "other" })).status).toBe(
    403,
  )
  expect(
    (await patch(jwt, {}, { headers: { "chatgpt-account-id": "other" } }))
      .status,
  ).toBe(403)
  expect((await read(jwt, "", { "x-api-key": "other" })).status).toBe(401)
  await trustedJwtDigestStore.setEnabled(entry.id, false)
  expect((await read(jwt)).status).toBe(401)
  expect((await patch(jwt, {})).status).toBe(401)
  await trustedJwtDigestStore.remove(entry.id)
  await seedProtocolDatabase({ gatewayKeys: [jwt] })
  expect((await read(jwt)).status).toBe(401)
  expect((await patch(jwt, {})).status).toBe(401)
})

test.each(
  [
    null,
    [],
    "max",
    { max: "true" },
    { ultra: 1 },
    { unrelated_setting: true },
  ].map((value) => ({ value })),
)(
  "rejects malformed or unsupported preference payload %# without saving",
  async ({ value }) => {
    const { jwt } = await identity()
    expect((await patch(jwt, value)).status).toBe(400)
    expect(await visibility(await read(jwt))).toEqual({
      enabled: efforts,
      source: "default",
      uses_defaults: true,
    })
  },
)

test.each([
  "feature=training_allowed&value=true",
  `feature=${feature}&value=not-json`,
  `feature=${feature}&value={}&value={}`,
  `feature=${feature}&feature=other&value={}`,
  `feature=${feature}`,
])("rejects an invalid settings query %s", async (query) => {
  const { jwt } = await identity()
  const response = await server.request(
    `/settings/account_user_setting?${query}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${jwt}` },
    },
  )
  expect(response.status).toBe(400)
})

test.each(["", "/backend-api"])(
  "%s settings denies unsupported methods and neighbouring paths",
  async (prefix) => {
    const { jwt } = await identity()
    for (const [method, path] of [
      ["HEAD", "/settings/user"],
      ["POST", "/settings/user"],
      ["GET", "/settings/account_user_setting"],
      ["POST", "/settings/account_user_setting"],
      ["GET", "/settings/other"],
      ["GET", "/settings/user/extra"],
    ]) {
      const response = await server.request(prefix + path, {
        method,
        headers: { authorization: `Bearer ${jwt}` },
      })
      expect(response.status).toBe(404)
    }
  },
)
