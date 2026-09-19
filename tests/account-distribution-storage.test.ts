/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import type { MutationContext, Storage } from "~/lib/storage/types"

import {
  AccountDistributionConflictError,
  AccountDistributionRevisionError,
  AccountDistributionUnavailableError,
  createAccountDistributionRepository,
} from "~/lib/storage/account-distribution-repository"
import { AccountsRepository } from "~/lib/storage/accounts-repository"
import { StorageConflictError } from "~/lib/storage/errors"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { getStoreRevision } from "~/lib/storage/operations"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

async function context(storage: Storage): Promise<MutationContext> {
  return {
    operationId: randomUUID(),
    expectedRevision: await getStoreRevision(storage),
    actorId: "test:distribution",
    kind: "account.distribution",
    inputDigest: "fixture",
  }
}

async function fixture(weights?: ReadonlyArray<number>) {
  const value = await createSchemaFixture()
  fixtures.push(value)
  await migrateStorage(value.storage)
  const accounts = new AccountsRepository(value.storage)
  const ids: Array<number> = []
  for (let index = 0; index < (weights?.length ?? 4); index++) {
    const account = await accounts.create(
      {
        instanceDomain: "github.com",
        upstreamUserId: String(index),
        login: `fixture-${index}`,
        token: "fixture-oauth",
        label: null,
        accountType: "individual",
        modelCount: 2,
      },
      await context(value.storage),
    )
    ids.push(account.value.id)
  }
  const repository = createAccountDistributionRepository(value.storage)
  if (weights)
    await repository.replace(
      ids.map((accountId, index) => ({
        accountId,
        percentage: weights[index],
      })),
      await context(value.storage),
    )
  return { ...value, accounts, ids, repository }
}

test.each([{ weights: [80, 10, 5, 5] }, { weights: [50, 30, 15, 5] }])(
  "weighted allocation matches each complete hundred and preserves ownership: %j",
  async ({ weights }) => {
    const { repository, ids, storage } = await fixture(weights)
    const revision = await getStoreRevision(storage)
    const counts = ids.map(() => 0)
    for (let index = 0; index < 100; index++) {
      const request = {
        affinityKey: `conversation-${index}`,
        modelId: "model-a",
        eligibleAccountIds: [...ids].reverse(),
      }
      const assigned = await repository.assign(request)
      counts[ids.indexOf(assigned.accountId)]++
      expect(assigned.reason).toBe("new")
      expect(
        await repository.assign({ ...request, modelId: "model-b" }),
      ).toMatchObject({ accountId: assigned.accountId, reason: "existing" })
    }
    expect(counts).toEqual([...weights])
    expect(await getStoreRevision(storage)).toBe(revision)
  },
)

test("filtered model schedulers normalize positive shares and do not phase-lock", async () => {
  const { repository, ids } = await fixture([80, 10, 5, 5])
  const counts: Record<string, Array<number>> = {
    all: [0, 0, 0, 0],
    subset: [0, 0, 0, 0],
  }
  for (let index = 0; index < 100; index++) {
    for (const modelId of ["all", "subset"]) {
      const assigned = await repository.assign({
        affinityKey: `${modelId}-${index}`,
        modelId,
        eligibleAccountIds: modelId === "all" ? ids : ids.slice(1),
      })
      counts[modelId][ids.indexOf(assigned.accountId)]++
    }
  }
  expect(counts).toEqual({ all: [80, 10, 5, 5], subset: [0, 50, 25, 25] })
})

test("alternating models with identical eligible sets each receive their configured shares", async () => {
  const { repository, ids } = await fixture([80, 10, 5, 5])
  const counts = { first: [0, 0, 0, 0], second: [0, 0, 0, 0] }
  for (let index = 0; index < 100; index++) {
    for (const modelId of ["first", "second"] as const) {
      const result = await repository.assign({
        affinityKey: `${modelId}-${index}`,
        modelId,
        eligibleAccountIds: ids,
      })
      counts[modelId][ids.indexOf(result.accountId)]++
    }
  }
  expect(counts).toEqual({ first: [80, 10, 5, 5], second: [80, 10, 5, 5] })
})

test("legacy and issuer seeds retain owners at zero share without consuming credits", async () => {
  const { repository, ids, storage } = await fixture()
  expect(await repository.load()).toMatchObject({
    configured: false,
    version: 0,
  })
  const request = {
    affinityKey: "old",
    modelId: "model",
    eligibleAccountIds: ids,
  }
  expect(
    await repository.assign({ ...request, legacyAccountId: ids[3] }),
  ).toMatchObject({ accountId: ids[3], reason: "legacy" })
  await repository.replace(
    ids.map((accountId, index) => ({
      accountId,
      percentage: index === 0 ? 100 : 0,
    })),
    await context(storage),
  )
  expect(await repository.assign(request)).toMatchObject({
    accountId: ids[3],
    reason: "existing",
  })
  expect(
    await repository.assign({
      ...request,
      affinityKey: "issuer",
      preferredAccountId: ids[2],
      preferredReason: "issuer",
    }),
  ).toMatchObject({ accountId: ids[2], reason: "issuer" })
  expect(
    await repository.assign({ ...request, affinityKey: "new" }),
  ).toMatchObject({ accountId: ids[0], reason: "new" })
  await expect(
    repository.assign({ ...request, preferredAccountId: ids[0] }),
  ).rejects.toBeInstanceOf(AccountDistributionConflictError)
  await expect(
    repository.assign({
      ...request,
      affinityKey: "zero",
      eligibleAccountIds: ids.slice(1),
    }),
  ).rejects.toBeInstanceOf(AccountDistributionUnavailableError)
})

test("no-op saves retain policy version and scheduler phase while new policy leaves owners intact", async () => {
  const { repository, ids, storage } = await fixture([50, 50])
  const assign = (affinityKey: string) =>
    repository.assign({
      affinityKey,
      modelId: "model",
      eligibleAccountIds: ids,
    })
  expect((await assign("first")).accountId).toBe(ids[0])
  const before = await repository.load()
  const saved = await repository.replace(
    [...before.allocations].reverse(),
    await context(storage),
  )
  expect(saved.value.version).toBe(before.version)
  expect((await assign("second")).accountId).toBe(ids[1])
  await repository.replace(
    [
      { accountId: ids[0], percentage: 0 },
      { accountId: ids[1], percentage: 100 },
    ],
    await context(storage),
  )
  expect((await assign("first")).accountId).toBe(ids[0])
  expect((await assign("third")).accountId).toBe(ids[1])
})

test("allocation saves validate integer totals, active identities, revision and operation binding", async () => {
  const { repository, ids, storage } = await fixture([50, 50])
  for (const allocations of [
    [{ accountId: ids[0], percentage: 99 }],
    [{ accountId: ids[0], percentage: 101 }],
    [
      { accountId: ids[0], percentage: 99.5 },
      { accountId: ids[1], percentage: 0.5 },
    ],
    [
      { accountId: ids[0], percentage: 50 },
      { accountId: ids[0], percentage: 50 },
    ],
    [{ accountId: 9999, percentage: 100 }],
  ])
    await expect(
      repository.replace(allocations, await context(storage)),
    ).rejects.toBeInstanceOf(StorageConflictError)
  const mutation = await context(storage)
  const allocations = [{ accountId: ids[0], percentage: 100 }]
  const result = await repository.replace(allocations, mutation)
  expect(await repository.replace(allocations, mutation)).toEqual(result)
  await expect(
    repository.replace([{ accountId: ids[1], percentage: 100 }], mutation),
  ).rejects.toBeInstanceOf(StorageConflictError)
  await expect(
    repository.replace(allocations, { ...mutation, operationId: randomUUID() }),
  ).rejects.toThrow("revision")
})

test("duplicate concurrent first assignments across adapters consume one scheduling turn", async () => {
  const { repository, ids, path } = await fixture([50, 50])
  const other = new LocalSqliteStorage(path)
  try {
    const request = {
      affinityKey: "raced",
      modelId: "model",
      eligibleAccountIds: ids,
    }
    const results = await Promise.all([
      repository.assign(request),
      createAccountDistributionRepository(other).assign(request),
    ])
    expect(results.map((result) => result.accountId)).toEqual([ids[0], ids[0]])
    expect(
      (await repository.assign({ ...request, affinityKey: "next" })).accountId,
    ).toBe(ids[1])
  } finally {
    await other.close()
  }
})

test("failed commit rolls ownership and scheduler back, while reopening retains both", async () => {
  const { repository, storage, ids, path } = await fixture([50, 50])
  const failed = createAccountDistributionRepository(
    faultStorage(storage, {
      beforeCommit: () => {
        throw new Error("injected rollback")
      },
    }),
  )
  const request = {
    affinityKey: "rolled-back",
    modelId: "model",
    eligibleAccountIds: ids,
  }
  await expect(failed.assign(request)).rejects.toThrow("injected rollback")
  expect(
    (await repository.assign({ ...request, affinityKey: "committed" }))
      .accountId,
  ).toBe(ids[0])
  const reopened = new LocalSqliteStorage(path)
  try {
    const recovered = createAccountDistributionRepository(reopened)
    expect(
      (await recovered.assign({ ...request, affinityKey: "committed" })).reason,
    ).toBe("existing")
    expect((await recovered.assign(request)).accountId).toBe(ids[1])
  } finally {
    await reopened.close()
  }
})

test("durable lifecycle checks exclude disabled new owners and preserve deleted owner tombstones", async () => {
  const { repository, storage, accounts, ids } = await fixture([50, 50])
  const request = {
    affinityKey: "owned",
    modelId: "model",
    eligibleAccountIds: ids,
  }
  const first = await repository.assign(request)
  await accounts.beginRemoval(first.accountId, await context(storage))
  await accounts.finalizeRemoval(first.accountId, await context(storage))
  expect(await repository.assign(request)).toMatchObject({
    accountId: first.accountId,
    reason: "existing",
  })
  expect(
    (await repository.assign({ ...request, affinityKey: "next" })).accountId,
  ).toBe(ids[1])
  await expect(
    repository.assign({
      ...request,
      affinityKey: "pin-deleted",
      preferredAccountId: first.accountId,
    }),
  ).rejects.toBeInstanceOf(AccountDistributionUnavailableError)
  await accounts.update(ids[1], { enabled: false }, await context(storage))
  await expect(
    repository.assign({ ...request, affinityKey: "disabled" }),
  ).rejects.toBeInstanceOf(AccountDistributionUnavailableError)
  await expect(
    storage.atomicBatch([
      { sql: "DELETE FROM capi_accounts WHERE id=?", args: [first.accountId] },
    ]),
  ).rejects.toBeInstanceOf(StorageConflictError)
})

test("new reservations reject stale eligibility revisions, and existing roots remain readable", async () => {
  const { repository, storage, ids } = await fixture([50, 50])
  const revision = await getStoreRevision(storage)
  const request = {
    affinityKey: "before",
    modelId: "model",
    eligibleAccountIds: ids,
    expectedRevision: revision,
  }
  expect((await repository.assign(request)).accountId).toBe(ids[0])
  await repository.replace(
    [{ accountId: ids[1], percentage: 100 }],
    await context(storage),
  )
  expect((await repository.assign(request)).accountId).toBe(ids[0])
  await expect(
    repository.assign({ ...request, affinityKey: "stale" }),
  ).rejects.toBeInstanceOf(AccountDistributionRevisionError)
  expect(await repository.lookup("stale")).toBeUndefined()
  expect(await repository.lookup("unseen-control-plane")).toBeUndefined()
  expect(
    (
      await repository.assign({
        ...request,
        affinityKey: "fresh",
        expectedRevision: await getStoreRevision(storage),
      })
    ).accountId,
  ).toBe(ids[1])
})

test("save results include zero allocations and new registry members without resetting policy", async () => {
  const { repository, storage, accounts, ids } = await fixture([100, 0])
  const added = await accounts.create(
    {
      instanceDomain: "github.com",
      upstreamUserId: "new",
      login: "new",
      token: "fixture-new",
      label: null,
      accountType: "individual",
      modelCount: 1,
    },
    await context(storage),
  )
  const saved = await repository.replace(
    [{ accountId: ids[0], percentage: 100 }],
    await context(storage),
  )
  expect(saved.value.allocations).toEqual([
    { accountId: ids[0], percentage: 100 },
    { accountId: ids[1], percentage: 0 },
    { accountId: added.value.id, percentage: 0 },
  ])
  expect(saved.value.version).toBe(1)
})

test("ownership existing reads never require a write transaction", async () => {
  const { repository, storage, ids } = await fixture([50, 50])
  const request = {
    affinityKey: "read-only",
    modelId: "model",
    eligibleAccountIds: ids,
  }
  await repository.assign(request)
  const reader = createAccountDistributionRepository({
    read: (work) => storage.read(work),
    transaction: () => Promise.reject(new Error("unexpected write")),
    atomicBatch: () => Promise.reject(new Error("unexpected write")),
    close: async () => {},
  })
  expect(await reader.lookup(request.affinityKey)).toBe(ids[0])
  expect(
    await reader.assign({ ...request, eligibleAccountIds: [] }),
  ).toMatchObject({ accountId: ids[0], reason: "existing" })
})

test("policy publication between the fast lookup and reservation prevents a stale root", async () => {
  const { repository, storage, ids } = await fixture([50, 50])
  const revision = await getStoreRevision(storage)
  let publish = true
  const racing = createAccountDistributionRepository({
    read: (work) => storage.read(work),
    transaction: async (work) => {
      if (publish) {
        publish = false
        await repository.replace(
          [{ accountId: ids[1], percentage: 100 }],
          await context(storage),
        )
      }
      return storage.transaction(work)
    },
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: async () => {},
  })
  const request = {
    affinityKey: "policy-race",
    modelId: "model",
    eligibleAccountIds: ids,
    expectedRevision: revision,
  }
  await expect(racing.assign(request)).rejects.toBeInstanceOf(
    AccountDistributionRevisionError,
  )
  expect(await repository.lookup(request.affinityKey)).toBeUndefined()
  expect(
    (
      await repository.assign({
        ...request,
        expectedRevision: await getStoreRevision(storage),
      })
    ).accountId,
  ).toBe(ids[1])
})

test("a failed mapping insertion rolls back the scheduler advance", async () => {
  const { repository, storage, ids } = await fixture([50, 50])
  const failed = createAccountDistributionRepository({
    read: (work) => storage.read(work),
    transaction: (work) =>
      storage.transaction((session) =>
        work({
          query: (statement) => session.query(statement),
          execute: (statement) =>
            statement.sql.startsWith("INSERT INTO capi_conversation_accounts") ?
              Promise.reject(new Error("injected insert failure"))
            : session.execute(statement),
        }),
      ),
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: async () => {},
  })
  const request = {
    affinityKey: "insert-failure",
    modelId: "model",
    eligibleAccountIds: ids,
  }
  await expect(failed.assign(request)).rejects.toThrow(
    "injected insert failure",
  )
  expect(await repository.lookup(request.affinityKey)).toBeUndefined()
  expect((await repository.assign(request)).accountId).toBe(ids[0])
})

test("candidate validation rolls back first reservations before or after scheduler and mapping writes", async () => {
  const { repository, ids } = await fixture([50, 50])
  const request = {
    affinityKey: "candidate-race",
    modelId: "model",
    eligibleAccountIds: ids,
  }
  for (const failAt of [1, 2]) {
    let checks = 0
    await expect(
      repository.assign({
        ...request,
        validateCandidates: () => {
          if (++checks === failAt) throw new AccountDistributionRevisionError()
        },
      }),
    ).rejects.toBeInstanceOf(AccountDistributionRevisionError)
    expect(checks).toBe(failAt)
    expect(await repository.lookup(request.affinityKey)).toBeUndefined()
  }
  expect((await repository.assign(request)).accountId).toBe(ids[0])
  expect(
    (await repository.assign({ ...request, affinityKey: "after-rollback" }))
      .accountId,
  ).toBe(ids[1])
  expect(
    (
      await repository.assign({
        ...request,
        validateCandidates: () => {
          throw new Error("existing root must bypass candidate validation")
        },
      })
    ).reason,
  ).toBe("existing")
})
