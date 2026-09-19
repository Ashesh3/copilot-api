import "./helpers/auth-misc-data-dir"

import { afterAll, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { state } from "../src/lib/state"
import { getStorageRuntime } from "../src/lib/storage/runtime"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"
import { server } from "../src/server"
import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const PATHS = [
  "/api/codex/accounts/check",
  "/wham/accounts/check",
  "/backend-api/wham/accounts/check",
]
const originalApiKeyAuth = state.apiKeyAuth

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function createJwt(claims: Record<string, unknown> = {}): string {
  return [
    encodeJson({ alg: "none", typ: "JWT" }),
    encodeJson({
      exp: 253_402_300_799,
      email: "private@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "local-account",
        chatgpt_user_id: "local-member",
        chatgpt_plan_type: "plus",
        ...claims,
      },
    }),
    Buffer.alloc(32, 7).toString("base64url"),
  ].join(".")
}

async function registerJwt(jwt: string) {
  return trustedJwtDigestStore.add({
    label: "Private device label",
    digest: createHash("sha256").update(jwt, "utf8").digest("hex"),
  })
}

function request(path: string, jwt?: string, headers?: Record<string, string>) {
  return server.request(path, {
    headers: {
      ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
      ...headers,
    },
  })
}

beforeEach(() => {
  trustedJwtDigestStore.resetAfterTest()
  state.apiKeyAuth = undefined
})

afterAll(() => {
  trustedJwtDigestStore.resetAfterTest()
  state.apiKeyAuth = originalApiKeyAuth
})

test.each(PATHS)(
  "discovers only the authenticated local account at %s",
  async (path) => {
    const jwt = createJwt()
    await registerJwt(jwt)
    await registerJwt(createJwt({ chatgpt_account_id: "other-account" }))
    state.apiKeyAuth = "unrelated-gateway-key"

    const response = await request(`${path}?account_id=other-account`, jwt, {
      "chatgpt-account-id": "local-account",
      host: "untrusted.example",
      "x-forwarded-host": "untrusted.example",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("pragma")).toBe("no-cache")
    expect(await response.json()).toEqual({
      accounts: [
        {
          id: "local-account",
          account_user_id: "local-member",
          account_user_role: "standard-user",
          structure: "personal",
          plan_type: "plus",
          is_zdr: false,
          is_openai_internal: false,
          workspace_backend_origin: "NO_CONSTRAINT",
          account_routing_override: "NO_CONSTRAINT",
        },
      ],
      default_account_id: "local-account",
      account_ordering: ["local-account"],
    })
  },
)

test.each(PATHS)(
  "rejects missing and unregistered identity credentials at %s",
  async (path) => {
    for (const jwt of [undefined, createJwt()]) {
      const response = await request(path, jwt)
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="copilot-api"',
      )
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("pragma")).toBe("no-cache")
      expect(await response.json()).toEqual({
        error: { message: "Unauthorized", type: "authentication_error" },
      })
    }
  },
)

test.each(PATHS)(
  "rejects a conflicting or duplicated account selector at %s",
  async (path) => {
    const jwt = createJwt()
    await registerJwt(jwt)
    for (const accountId of [
      "other-account",
      "local-account, other-account",
      "",
    ]) {
      const response = await request(path, jwt, {
        "chatgpt-account-id": accountId,
      })
      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("pragma")).toBe("no-cache")
      const body = await response.text()
      expect(body).not.toContain("local-account")
      expect(body).not.toContain("local-member")
    }
  },
)

test("discovery follows managed credential revocation and deletion", async () => {
  const jwt = createJwt()
  const entry = await registerJwt(jwt)
  expect((await request(PATHS[0], jwt)).status).toBe(200)
  await trustedJwtDigestStore.setEnabled(entry.id, false)
  for (const path of PATHS) expect((await request(path, jwt)).status).toBe(401)
  await trustedJwtDigestStore.setEnabled(entry.id, true)
  expect((await request(PATHS[0], jwt)).status).toBe(200)
  await trustedJwtDigestStore.remove(entry.id)
  expect((await request(PATHS[0], jwt)).status).toBe(401)
})

test("gateway and inference credentials cannot supply a managed identity", async () => {
  const jwt = createJwt()
  await seedProtocolDatabase({ gatewayKeys: [jwt] })
  await getStorageRuntime().storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,enabled,scopes_json,created_at,updated_at) VALUES (?,?,'environment',?,1,'[\"user:inference\"]',?,?)",
      args: [
        createHash("sha256").update(jwt, "utf8").digest("hex"),
        "configured-inference",
        "configured-inference",
        Date.now(),
        Date.now(),
      ],
    }),
  )
  for (const path of PATHS) expect((await request(path, jwt)).status).toBe(401)
})

test("requires an unambiguous bearer instead of cookies or alternate key headers", async () => {
  const jwt = createJwt()
  await registerJwt(jwt)
  const headers: Array<Record<string, string>> = [
    { "x-api-key": jwt },
    { "x-goog-api-key": jwt },
    { cookie: `token=${jwt}` },
    { authorization: `Basic ${jwt}` },
    { authorization: `Bearer ${jwt}`, "x-api-key": "conflicting-key" },
  ]
  for (const value of headers) {
    const response = await server.request(PATHS[0], { headers: value })
    expect(response.status).toBe(401)
  }
})

test.each([
  { chatgpt_account_id: "" },
  { chatgpt_account_id: 7 },
  { chatgpt_user_id: null },
  { chatgpt_user_id: "" },
  { chatgpt_plan_type: "" },
  { chatgpt_plan_type: [] },
])(
  "rejects enrolled credentials with malformed account claims %#",
  async (claims) => {
    const jwt = createJwt(claims)
    await registerJwt(jwt)
    const response = await request(PATHS[0], jwt)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("local-account")
  },
)

test.each([
  "opaque-managed-key",
  "header.invalid.signature",
  `header.${encodeJson(null)}.signature`,
  `header.${encodeJson([])}.signature`,
  `header.${encodeJson({})}.signature`,
  `${createJwt()}.extra`,
])(
  "rejects an enrolled credential without usable JWT metadata %#",
  async (jwt) => {
    await registerJwt(jwt)
    expect((await request(PATHS[0], jwt)).status).toBe(401)
  },
)

test("does not introduce time-based credential expiry or rotate credentials", async () => {
  const original = createJwt({ chatgpt_plan_type: "pro" })
  const parts = original.split(".")
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>
  delete payload.exp
  const jwt = `${parts[0]}.${encodeJson(payload)}.${parts[2]}`
  const entry = await registerJwt(jwt)
  const response = await request(PATHS[0], jwt)
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    accounts: Array<{ plan_type: string }>
  }
  expect(body.accounts[0].plan_type).toBe("pro")
  expect(await trustedJwtDigestStore.list()).toEqual([entry])
})

test.each(PATHS)(
  "keeps methods and adjacent account services unavailable at %s",
  async (path) => {
    const jwt = createJwt()
    await registerJwt(jwt)
    for (const method of [
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]) {
      const response = await server.request(path, {
        method,
        headers: { authorization: `Bearer ${jwt}` },
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(await response.text()).not.toContain("local-account")
    }
    await seedProtocolDatabase({ gatewayKeys: [jwt] })
    for (const suffix of ["/", "/extra", "-extra"]) {
      const response = await request(`${path}${suffix}`, jwt)
      expect(response.status).toBe(404)
    }
  },
)

test("does not turn account discovery into support for Codex cloud tasks", async () => {
  const jwt = createJwt()
  await registerJwt(jwt)
  const response = await request("/wham/tasks/list", jwt)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: { message: "Unsupported Codex cloud endpoint", type: "not_found" },
  })
})
