/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise assertions require awaiting. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import {
  AccountsService,
  createAccountMutationContext,
} from "~/lib/accounts-service"
import { getStoreRevision } from "~/lib/storage/operations"
import { initializeStorageRuntime } from "~/lib/storage/runtime"

import { createRuntimeStorage } from "./helpers/runtime-storage"

let fixture: Awaited<ReturnType<typeof createRuntimeStorage>>
let service: AccountsService
let accountId: number

beforeEach(async () => {
  fixture = await createRuntimeStorage()
  await initializeStorageRuntime(fixture)
  service = new AccountsService(fixture.storage, {
    validate: (input) =>
      Promise.resolve({
        persisted: {
          instanceDomain: "github.com",
          upstreamUserId: "fixture-id",
          login: "fixture-account",
          token: input.token,
          label: input.label ?? null,
          accountType: "individual",
          modelCount: 0,
        },
        resolved: {
          baseUrl: "https://api.githubcopilot.com",
          token: input.token,
          accountSubject: "fixture-id",
          models: { object: "list", data: [] },
        },
      }),
  })
  const created = await service.create(
    { token: "fixture-token" },
    await context("account.create"),
  )
  accountId = created.value.id
  await service.whenIdle()
  await service.refreshRuntime()
})

afterEach(async () => {
  await service.whenIdle()
  await fixture.close()
})

function context(kind: string) {
  return createAccountMutationContext(
    fixture.storage,
    kind,
    {},
    "admin:fixture",
  )
}

test("standalone unchanged account refresh reads the current revision once", async () => {
  const read = spyOn(fixture.storage, "read")
  try {
    await service.refreshRuntime()
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    read.mockRestore()
  }
})

test("an admission can reuse its fresh revision without another database read", async () => {
  const revision = await getStoreRevision(fixture.storage)
  const read = spyOn(fixture.storage, "read")
  try {
    await service.refreshRuntime(revision)
    expect(read).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
  }
})

test("a later admission catches up after joining an older account snapshot", async () => {
  await service.repository.update(
    accountId,
    { label: "first-change" },
    await context("account.update"),
  )
  const earlierRevision = await getStoreRevision(fixture.storage)
  const captured = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const originalSnapshot = service.repository.snapshot.bind(service.repository)
  const delayed = spyOn(service.repository, "snapshot").mockImplementationOnce(
    async () => {
      const snapshot = await originalSnapshot()
      captured.resolve(undefined)
      await release.promise
      return snapshot
    },
  )
  try {
    const earlier = service.refreshRuntime(earlierRevision)
    await captured.promise
    await service.repository.update(
      accountId,
      { enabled: false },
      await context("account.update"),
    )
    const laterRevision = await getStoreRevision(fixture.storage)
    const later = service.refreshRuntime(laterRevision)
    release.resolve(undefined)
    await Promise.all([earlier, later])
    expect(
      service.pool.getAllAccounts().find((account) => account.id === accountId)
        ?.enabled,
    ).toBe(false)
    expect(delayed).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve(undefined)
    delayed.mockRestore()
  }
})

test("fresh admissions publish account disabling and removal before selection", async () => {
  await service.repository.update(
    accountId,
    { enabled: false },
    await context("account.update"),
  )
  await service.refreshRuntime(await getStoreRevision(fixture.storage))
  expect(service.pool.getFirstHealthyAccount()).toBeUndefined()
  await service.repository.beginRemoval(
    accountId,
    await context("account.remove"),
  )
  await service.refreshRuntime(await getStoreRevision(fixture.storage))
  expect(service.pool.getAllAccounts()).toEqual([])
})

test("standalone refresh rejects a durable revision that moved backwards", async () => {
  await fixture.storage.atomicBatch([
    {
      sql: "UPDATE capi_metadata SET value='0' WHERE key='config_revision'",
      args: [],
    },
  ])
  await expect(service.refreshRuntime()).rejects.toMatchObject({
    code: "storage_schema",
  })
})

test("an older revision response racing a completed newer refresh does not report rollback", async () => {
  const read = fixture.storage.read.bind(fixture.storage)
  const captured = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const delayed = spyOn(fixture.storage, "read").mockImplementationOnce(
    async (work) => {
      const result = await read(work)
      captured.resolve(undefined)
      await release.promise
      return result
    },
  )
  try {
    const earlier = service.refreshRuntime()
    await captured.promise
    await service.repository.update(
      accountId,
      { enabled: false },
      await context("account.update"),
    )
    await service.refreshRuntime(await getStoreRevision(fixture.storage))
    release.resolve(undefined)
    await earlier
    expect(service.pool.getFirstHealthyAccount()).toBeUndefined()
  } finally {
    release.resolve(undefined)
    delayed.mockRestore()
  }
})

test("a stale account snapshot behind the freshly observed revision fails closed", async () => {
  const stale = await service.repository.snapshot()
  await service.repository.update(
    accountId,
    { enabled: false },
    await context("account.update"),
  )
  const revision = await getStoreRevision(fixture.storage)
  const snapshot = spyOn(service.repository, "snapshot").mockResolvedValueOnce(
    stale,
  )
  try {
    await expect(service.refreshRuntime(revision)).rejects.toMatchObject({
      code: "storage_schema",
    })
  } finally {
    snapshot.mockRestore()
  }
})
