import { createCipheriv, createHash, randomBytes } from "node:crypto"

import type { TransferRecord } from "~/lib/storage/transfer-records"
import type { Storage } from "~/lib/storage/types"

import {
  BACKUP_MAGIC,
  BACKUP_VERSION,
  deriveBackupKey,
} from "~/lib/config-backup"
import {
  transferColumns,
  transferKey,
  transferTablesForSchema,
} from "~/lib/storage/transfer-records"

/** Produce the retired v5 archive format without depending on the current exporter. */
export async function createVersionFiveBackup(
  storage: Storage,
): Promise<Uint8Array> {
  const records: Array<TransferRecord> = []
  await storage.read(async (session) => {
    for (const table of transferTablesForSchema(5)) {
      const columns = transferColumns(table, 5).map((column) => column.name)
      const rows = await session.query({
        sql: `SELECT ${columns.join(",")} FROM ${table}`,
        args: [],
      })
      records.push(
        ...rows
          .map((row) => ({
            table,
            key: transferKey(table, row, 5),
            value: row as TransferRecord["value"],
          }))
          .sort((a, b) =>
            Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
          ),
      )
    }
  })
  const digest = createHash("sha256")
  const recordCounts: Record<string, number> = {}
  const frames = records.map((record, seq) => {
    recordCounts[record.table] = (recordCounts[record.table] ?? 0) + 1
    const frame = `${JSON.stringify({ kind: "record", seq, record })}\n`
    digest.update(frame)
    return frame
  })
  const identity = records.find(
    (record) =>
      record.table === "capi_metadata" && record.key === '["store_id"]',
  )
  frames.push(
    `${JSON.stringify({
      kind: "manifest",
      seq: frames.length,
      manifest: {
        formatVersion: 1,
        schemaVersion: 5,
        sourceStoreId: (identity?.value as { value: string }).value,
        recordCounts,
        recordsSha256: digest.digest("hex"),
      },
    })}\n`,
  )
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const header = Buffer.concat([
    BACKUP_MAGIC,
    Buffer.from([BACKUP_VERSION]),
    salt,
    iv,
  ])
  const key = await deriveBackupKey("fixture-password", salt)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(header)
  key.fill(0)
  return Buffer.concat([
    header,
    cipher.update(frames.join("")),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}
