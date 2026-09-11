import { expect, test } from "bun:test"

import { createBackupStream } from "~/lib/config-backup"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import { restoreBackup } from "~/lib/storage/restore"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const DAY = 86400_000

test("pruning replaces expired collection detail with lifetime numbers that survive backup restore", async () => {
  await withTransferStorage(async (source) => {
    const now = Date.now()
    const repository = createHistoryRepository(source)
    await repository.applyBatch("collection-fixture", [
      {
        id: "old-gap",
        kind: "collection-gap",
        generation: 0,
        recordedAt: now - 2 * DAY,
        payload: { historyKind: "usage", lostRecords: 7, lostBytes: 42 },
      },
      {
        id: "recent-gap",
        kind: "collection-gap",
        generation: 0,
        recordedAt: now,
        payload: { unknown: true, reason: "expired-unconfirmed-batch" },
      },
    ])
    await repository.prune(now)
    expect(
      await source.read((s) =>
        s.query({
          sql: "SELECT id FROM capi_collection_gaps ORDER BY id",
          args: [],
        }),
      ),
    ).toEqual([{ id: "recent-gap" }])
    expect(await repository.collectionStatus()).toEqual({
      knownLostRecords: 7,
      knownLostBytes: 42,
      unknownGaps: 1,
    })
    expect(await repository.collectionStatus({ since: now - DAY })).toEqual({
      knownLostRecords: 0,
      knownLostBytes: 0,
      unknownGaps: 1,
    })
    const archive = await streamBytes(
      createBackupStream("fixture-retention-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      expect(
        (
          await restoreBackup(
            bytesStream(archive),
            "fixture-retention-password",
            target,
          )
        ).phase,
      ).toBe("complete")
      expect(await createHistoryRepository(target).collectionStatus()).toEqual({
        knownLostRecords: 7,
        knownLostBytes: 42,
        unknownGaps: 1,
      })
    })
  })
})

test("starting history after idle downtime expires detailed usage before serving it", async () => {
  await withTransferStorage(async (storage) => {
    const now = Date.now()
    const repository = createHistoryRepository(storage)
    await repository.applyBatch("prior-run-usage", [
      {
        id: "old-usage",
        kind: "usage",
        generation: 0,
        recordedAt: now - 2 * DAY,
        payload: {
          timestamp: now - 2 * DAY,
          inputTokens: 3,
          outputTokens: 5,
          requestCount: 1,
          model: "old-model",
        },
      },
    ])
    await repository.startRun("new-run", now)
    expect((await repository.readUsage(0)).buckets).toHaveLength(0)
    expect(
      (await repository.readUsageTotals(now - DAY)).lifetime,
    ).toMatchObject({ inputTokens: 3, outputTokens: 5, requestCount: 1 })
    expect(
      await storage.read((s) =>
        s.query({
          sql: "SELECT name FROM sqlite_master WHERE name='capi_debug' OR name='capi_activity'",
          args: [],
        }),
      ),
    ).toEqual([])
  })
})
