import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Storage } from "~/lib/storage/types"

import { createBackupStream } from "~/lib/config-backup"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import {
  applyLegacyImport,
  previewLegacyImport,
} from "~/lib/storage/legacy-import"
import { restoreBackup } from "~/lib/storage/restore"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const DAY = 86400_000

async function assertRetained(storage: Storage, now: number) {
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT model FROM capi_usage_minutes ORDER BY minute",
        args: [],
      }),
    ),
  ).toEqual([{ model: "recent" }])
  expect(
    await createHistoryRepository(storage).readUsageTotals(now - DAY),
  ).toMatchObject({
    window: { inputTokens: 7, outputTokens: 14, requests: 1 },
    lifetime: { inputTokens: 11, outputTokens: 22, requestCount: 3 },
  })
}

test("encrypted roundtrip retains lifetime totals without restoring expired model detail", async () => {
  await withTransferStorage(async (source) => {
    const now = Math.floor(Date.now() / 60_000) * 60_000
    await createHistoryRepository(source).applyBatch(
      "history",
      [
        [now - 8 * DAY, 1, "old"],
        [now - 2 * DAY, 3, "past"],
        [now, 7, "recent"],
      ].map(([timestamp, input, model]) => ({
        id: String(model),
        kind: "usage" as const,
        generation: 0,
        recordedAt: Number(timestamp),
        payload: {
          timestamp,
          inputTokens: input,
          outputTokens: Number(input) * 2,
          requestCount: 1,
          model,
        },
      })),
    )
    const archive = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      expect(
        (await restoreBackup(bytesStream(archive), "fixture-password", target))
          .phase,
      ).toBe("complete")
      await assertRetained(target, now)
    })
  })
})

test("legacy import preserves lifetime totals while discarding old model detail", async () => {
  await withTransferStorage(async (target, directory) => {
    const now = Math.floor(Date.now() / 60_000) * 60_000
    await writeFile(
      join(directory, "usage.json"),
      JSON.stringify({
        records: [
          {
            timestamp: now - 8 * DAY,
            inputTokens: 1,
            outputTokens: 2,
            model: "old",
          },
          {
            timestamp: now - 2 * DAY,
            inputTokens: 3,
            outputTokens: 6,
            model: "past",
          },
          { timestamp: now, inputTokens: 7, outputTokens: 14, model: "recent" },
        ],
      }),
    )
    const input = { directory, includeEnvironment: false }
    const preview = await previewLegacyImport(input, target)
    expect((await applyLegacyImport(input, preview, target)).phase).toBe(
      "complete",
    )
    await assertRetained(target, now)
  })
})
