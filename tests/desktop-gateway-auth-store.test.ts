/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun asynchronous rejection matchers have void type declarations. */
import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import { resolveCredential } from "~/lib/credential-resolver"
import {
  credentialDigest,
  insertGatewayCredential,
} from "~/lib/storage/credentials-repository"
import {
  DesktopGatewayAuthRepository,
  getDesktopGatewayAuthRepository,
} from "~/lib/storage/desktop-gateway-auth-repository"
import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"

import { createAuthStorageFixture } from "./helpers/auth-storage"

const issuer = "https://gateway.example/v1"
const gatewayKey = "desktop-test-gateway-key"
const inferenceKey = "desktop-test-inference-key"
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let repository: DesktopGatewayAuthRepository
let now: number

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  repository = new DesktopGatewayAuthRepository(fixture.storage)
  now = Date.now() - 20_000
  await fixture.storage.transaction(async (session) => {
    await insertGatewayCredential(session, {
      id: "desktop-gateway",
      credential: gatewayKey,
      label: "Desktop test",
      createdAt: now,
    })
    await session.execute({
      sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,scopes_json,created_at,updated_at) VALUES (?,?,'test',?,'[\"user:inference\"]',?,?)",
      args: [
        credentialDigest(inferenceKey),
        "desktop-inference",
        "inference:desktop-issuer",
        now,
        now,
      ],
    })
  })
})

afterEach(async () => {
  await fixture.close()
})

async function approvedDevice(issuerKey = gatewayKey) {
  const device = await repository.issueDeviceAuthorization({ issuer, now })
  expect(
    await repository.approveDeviceAuthorization({
      issuer,
      issuerKey,
      userCode: device.userCode,
      now: now + 1,
    }),
  ).toEqual({ status: "approved" })
  return device
}

async function issuedTokens(issuerKey = gatewayKey) {
  const device = await approvedDevice(issuerKey)
  const result = await repository.exchangeDeviceCode({
    issuer,
    deviceCode: device.deviceCode,
    now: now + 5000,
  })
  expect(result.status).toBe("ok")
  if (result.status !== "ok") throw new Error("Device exchange failed")
  return { device, tokens: result.tokens, issuedAt: now + 5000 }
}

async function seedReceipt(id: string, kind: string, createdAt: number) {
  await fixture.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_applied_operations (id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES (?,?,'retention-test','fixture',0,'{\"status\":\"committed\"}',?)",
      args: [id, kind, createdAt],
    },
  ])
}

async function receiptIds() {
  return fixture.storage.read(async (session) =>
    (
      await session.query({
        sql: "SELECT id FROM capi_applied_operations",
        args: [],
      })
    ).map((row) => row.id),
  )
}

test.each([gatewayKey, inferenceKey])(
  "device approval delegates inference only for supported issuer %s",
  async (issuerKey) => {
    const device = await repository.issueDeviceAuthorization({ issuer, now })
    expect(device).toMatchObject({ expiresIn: 300, interval: 5 })
    expect(device.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(
      await repository.approveDeviceAuthorization({
        issuer,
        issuerKey,
        userCode: " " + device.userCode.replace("-", "").toLowerCase() + " ",
        now: now + 1,
      }),
    ).toEqual({ status: "approved" })
    const result = await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.tokens).toMatchObject({
      expiresIn: 3600,
      refreshTokenExpiresIn: 2_592_000,
      scopes: ["user:inference"],
    })
    expect(await resolveCredential(result.tokens.accessToken)).toMatchObject({
      kind: "inference-client",
      scopes: new Set(["user:inference"]),
    })
    expect(
      await resolveCredential(result.tokens.accessToken, ["user:profile"]),
    ).toBeNull()
    expect(await resolveCredential(result.tokens.refreshToken)).toBeNull()
  },
)

test("pending polling slows down without consuming the device grant", async () => {
  const device = await repository.issueDeviceAuthorization({ issuer, now })
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    }),
  ).toEqual({ status: "authorization_pending" })
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5001,
    }),
  ).toEqual({ status: "slow_down" })
  expect(
    await repository.getDeviceAuthorization({
      issuer,
      userCode: device.userCode,
      now: now + 5001,
    }),
  ).toMatchObject({ status: "pending", interval: 10 })
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 15_001,
    }),
  ).toEqual({ status: "authorization_pending" })
})

test("denied devices never issue tokens", async () => {
  const device = await repository.issueDeviceAuthorization({ issuer, now })
  expect(
    await repository.approveDeviceAuthorization({
      issuer,
      issuerKey: inferenceKey,
      userCode: device.userCode,
      action: "deny",
      now: now + 1,
    }),
  ).toEqual({ status: "denied" })
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    }),
  ).toEqual({ status: "access_denied" })
})

test("device expiry is exact and new issuance removes stale grants", async () => {
  const device = await approvedDevice()
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 300_000,
    }),
  ).toEqual({ status: "expired_token" })
  expect(
    await repository.approveDeviceAuthorization({
      issuer,
      issuerKey: gatewayKey,
      userCode: device.userCode,
      now: now + 300_000,
    }),
  ).toEqual({ status: "invalid_code" })
  await repository.issueDeviceAuthorization({ issuer, now: now + 300_001 })
  expect(
    await repository.getDeviceAuthorization({
      issuer,
      userCode: device.userCode,
      now: now + 300_001,
    }),
  ).toBeNull()
})

test("unapproved, unknown and delegated keys cannot approve a device", async () => {
  const { tokens } = await issuedTokens()
  const device = await repository.issueDeviceAuthorization({ issuer, now })
  for (const issuerKey of [
    "unknown-key",
    tokens.accessToken,
    tokens.refreshToken,
  ]) {
    expect(
      await repository.approveDeviceAuthorization({
        issuer,
        issuerKey,
        userCode: device.userCode,
        now: now + 1,
      }),
    ).toEqual({ status: "invalid_credential" })
  }
  expect(
    await repository.getDeviceAuthorization({
      issuer,
      userCode: device.userCode,
      now: now + 2,
    }),
  ).toMatchObject({ status: "pending" })
})

test.each([
  ["gateway", "gw_at_user-chosen-gateway-key"],
  ["gateway", "gw_rt_user-chosen-gateway-key"],
  ["gateway", "gw_device_user-chosen-gateway-key"],
  ["inference", "gw_at_user-chosen-inference-key"],
  ["inference", "gw_rt_user-chosen-inference-key"],
  ["inference", "gw_device_user-chosen-inference-key"],
] as const)(
  "stored prefixed %s credential still authenticates and approves: %s",
  async (kind, key) => {
    await fixture.storage.transaction(async (session) => {
      await (kind === "gateway" ?
        insertGatewayCredential(session, {
          id: "prefixed-gateway",
          credential: key,
          label: "Prefixed stored key",
          createdAt: now,
        })
      : session.execute({
          sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,scopes_json,created_at,updated_at) VALUES (?,'prefixed-inference','test','inference:prefixed','[\"user:inference\"]',?,?)",
          args: [credentialDigest(key), now, now],
        }))
    })
    expect(await resolveCredential(key)).toMatchObject({
      kind: kind === "gateway" ? "gateway" : "inference-client",
    })
    const { tokens } = await issuedTokens(key)
    expect(await resolveCredential(tokens.accessToken)).toMatchObject({
      kind: "inference-client",
      scopes: new Set(["user:inference"]),
    })
  },
)

test("an independently registered delegated token can approve as its stored key", async () => {
  const { tokens } = await issuedTokens()
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: "registered-delegated-key",
      credential: tokens.accessToken,
      label: "Explicitly registered key",
      createdAt: now + 6000,
    }),
  )
  expect(await resolveCredential(tokens.accessToken)).toMatchObject({
    kind: "gateway",
  })
  expect((await issuedTokens(tokens.accessToken)).tokens.scopes).toEqual([
    "user:inference",
  ])
})

test("issuer base and optional client binding cannot change across the flow", async () => {
  const device = await repository.issueDeviceAuthorization({
    issuer: issuer + "/",
    clientId: "desktop-client",
    now,
  })
  expect(
    await repository.approveDeviceAuthorization({
      issuer: "https://gateway.example",
      userCode: device.userCode,
      issuerKey: gatewayKey,
      now: now + 1,
    }),
  ).toEqual({ status: "invalid_code" })
  await repository.approveDeviceAuthorization({
    issuer,
    issuerKey: gatewayKey,
    userCode: device.userCode,
    now: now + 2,
  })
  for (const binding of [
    { issuer: "https://other.example/v1", clientId: "desktop-client" },
    { issuer: "https://gateway.example", clientId: "desktop-client" },
    { issuer, clientId: "wrong-client" },
    { issuer },
  ]) {
    expect(
      await repository.exchangeDeviceCode({
        ...binding,
        deviceCode: device.deviceCode,
        now: now + 5000,
      }),
    ).toEqual({ status: "invalid_grant" })
  }
  const result = await repository.exchangeDeviceCode({
    issuer,
    clientId: "desktop-client",
    deviceCode: device.deviceCode,
    now: now + 5000,
  })
  expect(result.status).toBe("ok")
  if (result.status !== "ok") return
  expect(
    await repository.refresh({
      issuer,
      refreshToken: result.tokens.refreshToken,
      now: now + 6000,
    }),
  ).toEqual({ status: "invalid_grant" })
  await repository.revoke({
    issuer: "https://other.example/v1",
    token: result.tokens.refreshToken,
    now: now + 6000,
  })
  expect(
    await repository.resolveAccessToken(result.tokens.accessToken, now + 6000),
  ).not.toBeNull()
})

test("access and refresh expire at their advertised boundaries", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  expect(
    await repository.resolveAccessToken(
      tokens.accessToken,
      issuedAt + 3_599_999,
    ),
  ).not.toBeNull()
  expect(
    await repository.resolveAccessToken(
      tokens.accessToken,
      issuedAt + 3_600_000,
    ),
  ).toBeNull()
  expect(
    await repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 2_592_000_000,
    }),
  ).toEqual({ status: "invalid_grant" })
})

test("refresh rotates once and preserves earlier access until its own expiry", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const refreshed = await repository.refresh({
    issuer,
    refreshToken: tokens.refreshToken,
    now: issuedAt + 1000,
  })
  expect(refreshed.status).toBe("ok")
  if (refreshed.status !== "ok") return
  expect(refreshed.tokens.refreshToken).not.toBe(tokens.refreshToken)
  expect(refreshed.tokens.accessToken).not.toBe(tokens.accessToken)
  expect(
    await repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 1001,
    }),
  ).toEqual({ status: "invalid_grant" })
  expect(
    await repository.resolveAccessToken(
      tokens.accessToken,
      issuedAt + 3_599_999,
    ),
  ).not.toBeNull()
  expect(
    await repository.resolveAccessToken(
      tokens.accessToken,
      issuedAt + 3_600_000,
    ),
  ).toBeNull()
  expect(
    await repository.resolveAccessToken(
      refreshed.tokens.accessToken,
      issuedAt + 3_600_000,
    ),
  ).not.toBeNull()
})

test.each(["access", "refresh"] as const)(
  "revoking a %s token invalidates every token in its session",
  async (kind) => {
    const { tokens, issuedAt } = await issuedTokens()
    const next = await repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 1,
    })
    if (next.status !== "ok") throw new Error("Refresh failed")
    await repository.revoke({
      issuer,
      token: kind === "access" ? tokens.accessToken : next.tokens.refreshToken,
      now: issuedAt + 2,
    })
    for (const token of [tokens.accessToken, next.tokens.accessToken])
      expect(
        await repository.resolveAccessToken(token, issuedAt + 3),
      ).toBeNull()
    expect(
      await repository.refresh({
        issuer,
        refreshToken: next.tokens.refreshToken,
        now: issuedAt + 3,
      }),
    ).toEqual({ status: "invalid_grant" })
  },
)

test.each([
  [gatewayKey, "UPDATE capi_gateway_credentials SET revoked_at=1"],
  [gatewayKey, "UPDATE capi_gateway_credentials SET digest='replaced'"],
  [gatewayKey, "DELETE FROM capi_gateway_secrets"],
  [inferenceKey, "UPDATE capi_inference_credentials SET enabled=0"],
  [inferenceKey, "UPDATE capi_inference_credentials SET revoked_at=1"],
  [inferenceKey, "UPDATE capi_inference_credentials SET digest='replaced'"],
  [inferenceKey, "UPDATE capi_inference_credentials SET scopes_json='[]'"],
])("issuer changes invalidate delegated access: %s %s", async (key, sql) => {
  const { tokens, issuedAt } = await issuedTokens(key)
  await fixture.storage.atomicBatch([{ sql, args: [] }])
  expect(
    await repository.resolveAccessToken(tokens.accessToken, issuedAt + 1),
  ).toBeNull()
  expect(
    await repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 1,
    }),
  ).toEqual({ status: "invalid_grant" })
})

test("device exchange revalidates the approving key after approval", async () => {
  const device = await approvedDevice(inferenceKey)
  await fixture.storage.atomicBatch([
    { sql: "UPDATE capi_inference_credentials SET enabled=0", args: [] },
  ])
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    }),
  ).toEqual({ status: "invalid_grant" })
})

test("approval rechecks the supplied key inside the committing transaction", async () => {
  const device = await repository.issueDeviceAuthorization({ issuer, now })
  fixture.beforeNextTransaction((storage) =>
    storage.atomicBatch([
      { sql: "UPDATE capi_inference_credentials SET enabled=0", args: [] },
    ]),
  )
  expect(
    await repository.approveDeviceAuthorization({
      issuer,
      userCode: device.userCode,
      issuerKey: inferenceKey,
      now: now + 1,
    }),
  ).toEqual({ status: "invalid_credential" })
})

test("tokens survive restart without durable plaintext issued secrets", async () => {
  const { device, tokens, issuedAt } = await issuedTokens()
  const before = await repository.resolveAccessToken(
    tokens.accessToken,
    issuedAt,
  )
  await fixture.restart()
  const reopened = getDesktopGatewayAuthRepository()
  expect(
    await reopened.resolveAccessToken(tokens.accessToken, issuedAt + 1),
  ).toEqual(before)
  const serialized = await fixture.storage.read(async (session) => {
    const rows = []
    for (const table of [
      "capi_desktop_device_grants",
      "capi_desktop_auth_sessions",
      "capi_desktop_access_tokens",
      "capi_applied_operations",
    ])
      rows.push(
        await session.query({ sql: "SELECT * FROM " + table, args: [] }),
      )
    return JSON.stringify(rows)
  })
  for (const secret of [
    device.deviceCode,
    device.userCode,
    tokens.accessToken,
    tokens.refreshToken,
    gatewayKey,
  ])
    expect(serialized).not.toContain(secret)
  expect(
    await reopened.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 2,
    }),
  ).toMatchObject({ status: "ok" })
})

test("independent connections exchange a device and refresh a session once", async () => {
  const device = await approvedDevice()
  const connection = new LocalSqliteStorage(fixture.config.path)
  try {
    const second = new DesktopGatewayAuthRepository(connection)
    const exchanged = await Promise.all(
      [repository, second].map((store) =>
        store.exchangeDeviceCode({
          issuer,
          deviceCode: device.deviceCode,
          now: now + 5000,
        }),
      ),
    )
    expect(exchanged.map((result) => result.status).sort()).toEqual([
      "invalid_grant",
      "ok",
    ])
    const success = exchanged.find((result) => result.status === "ok")
    if (success?.status !== "ok")
      throw new Error("No successful device exchange")
    const refreshed = await Promise.all(
      [repository, second].map((store) =>
        store.refresh({
          issuer,
          refreshToken: success.tokens.refreshToken,
          now: now + 6000,
        }),
      ),
    )
    expect(refreshed.map((result) => result.status).sort()).toEqual([
      "invalid_grant",
      "ok",
    ])
  } finally {
    await connection.close()
  }
})

test("failed issuance rolls back device consumption and can be retried", async () => {
  const device = await approvedDevice()
  fixture.failWrites()
  await expect(
    repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    }),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  fixture.failWrites(false)
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    }),
  ).toMatchObject({ status: "ok" })
})

test("read outages propagate instead of becoming invalid credentials", async () => {
  const { tokens } = await issuedTokens()
  fixture.failReads()
  await expect(
    repository.resolveAccessToken(tokens.accessToken),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  fixture.failReads(false)
})

test("lost commit response reconciles issuance without issuing another session", async () => {
  const device = await approvedDevice()
  fixture.loseNextCommitResponse()
  const result = await repository.exchangeDeviceCode({
    issuer,
    deviceCode: device.deviceCode,
    now: now + 5000,
  })
  expect(result.status).toBe("ok")
  if (result.status !== "ok") return
  expect(
    await repository.resolveAccessToken(result.tokens.accessToken, now + 5001),
  ).not.toBeNull()
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_desktop_auth_sessions",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
})

test("unknown commit blocks further writes until reconciliation confirms it", async () => {
  const device = await approvedDevice()
  fixture.loseNextCommitResponse({ failReads: true })
  await expect(
    repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 5000,
    }),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  await expect(
    repository.issueDeviceAuthorization({ issuer, now: now + 6000 }),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  fixture.failReads(false)
  expect(
    await repository.exchangeDeviceCode({
      issuer,
      deviceCode: device.deviceCode,
      now: now + 6000,
    }),
  ).toEqual({ status: "invalid_grant" })
})

test.each(["issue", "poll"] as const)(
  "Desktop receipt retention runs on %s and preserves other authentication receipts",
  async (operation) => {
    const device = await repository.issueDeviceAuthorization({ issuer, now })
    const cutoff = Date.now() - 86_400_000
    await seedReceipt(
      "old-desktop-device",
      "desktop-auth.device",
      cutoff - 1000,
    )
    await seedReceipt(
      "old-desktop-poll",
      "desktop-auth.exchange",
      cutoff - 1000,
    )
    await seedReceipt("old-cli-oauth", "oauth.issue-code", cutoff - 1000)
    await seedReceipt(
      "other-namespace",
      "desktop-authentication.device",
      cutoff - 1000,
    )
    await seedReceipt("recent-desktop", "desktop-auth.device", cutoff + 60_000)
    if (operation === "issue") {
      await repository.issueDeviceAuthorization({ issuer, now: now + 5000 })
    } else {
      expect(
        await repository.exchangeDeviceCode({
          issuer,
          deviceCode: device.deviceCode,
          now: now + 5000,
        }),
      ).toEqual({ status: "authorization_pending" })
    }
    const retained = await receiptIds()
    expect(retained).not.toContain("old-desktop-device")
    expect(retained).not.toContain("old-desktop-poll")
    expect(retained).toContain("old-cli-oauth")
    expect(retained).toContain("other-namespace")
    expect(retained).toContain("recent-desktop")
  },
)

test("Desktop receipt cleanup rolls back with failed device issuance", async () => {
  await seedReceipt(
    "old-desktop",
    "desktop-auth.device",
    Date.now() - 86_401_000,
  )
  fixture.failWrites()
  await expect(
    repository.issueDeviceAuthorization({ issuer, now }),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  fixture.failWrites(false)
  expect(await receiptIds()).toContain("old-desktop")
  await repository.issueDeviceAuthorization({ issuer, now })
  expect(await receiptIds()).not.toContain("old-desktop")
})

test("Desktop receipt cleanup preserves the receipt for a lost commit response", async () => {
  await seedReceipt(
    "old-desktop",
    "desktop-auth.device",
    Date.now() - 86_401_000,
  )
  fixture.loseNextCommitResponse()
  const device = await repository.issueDeviceAuthorization({ issuer, now })
  expect(
    await repository.getDeviceAuthorization({
      issuer,
      userCode: device.userCode,
      now,
    }),
  ).toMatchObject({ status: "pending" })
  expect(await receiptIds()).not.toContain("old-desktop")
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_desktop_device_grants",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
})

test("Desktop receipt retention protects pending reconciliation across connections", async () => {
  fixture.loseNextCommitResponse({ failReads: true })
  let pendingId: string | undefined
  try {
    await repository.issueDeviceAuthorization({ issuer, now })
  } catch (error) {
    if (!(error instanceof StorageCommitUnknownError)) throw error
    pendingId = error.operationId
  }
  if (!pendingId) throw new Error("Expected an uncertain Desktop commit")
  const operationId = pendingId
  await fixture.storage.atomicBatch([
    {
      sql: "UPDATE capi_applied_operations SET created_at=? WHERE id=?",
      args: [Date.now() - 86_401_000, operationId],
    },
  ])
  const connection = new LocalSqliteStorage(fixture.config.path)
  try {
    const other = new DesktopGatewayAuthRepository(connection)
    await other.issueDeviceAuthorization({ issuer, now: now + 1000 })
    expect(
      await connection.read((session) =>
        session.query({
          sql: "SELECT id FROM capi_applied_operations WHERE id=?",
          args: [operationId],
        }),
      ),
    ).toEqual([{ id: operationId }])
    fixture.failReads(false)
    await repository.issueDeviceAuthorization({ issuer, now: now + 2000 })
    expect(await receiptIds()).not.toContain(operationId)
  } finally {
    fixture.failReads(false)
    await connection.close()
  }
})

test("migration from schema eleven preserves credentials and enables device auth", async () => {
  await fixture.storage.atomicBatch([
    { sql: "DROP TABLE capi_desktop_access_tokens", args: [] },
    { sql: "DROP TABLE capi_desktop_auth_sessions", args: [] },
    { sql: "DROP TABLE capi_desktop_device_grants", args: [] },
    { sql: "DELETE FROM capi_schema_migrations WHERE version=12", args: [] },
    {
      sql: "UPDATE capi_metadata SET value='11' WHERE key='schema_version'",
      args: [],
    },
  ])
  await migrateStorage(fixture.storage)
  expect(await resolveCredential(gatewayKey)).toMatchObject({ kind: "gateway" })
  expect(await resolveCredential(inferenceKey)).toMatchObject({
    kind: "inference-client",
  })
  expect((await issuedTokens()).tokens.scopes).toEqual(["user:inference"])
})
