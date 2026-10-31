import { randomUUID } from "node:crypto"

import type { SqlSession, Storage } from "~/lib/storage/types"

import { SerialQueue } from "~/lib/storage/adapter-utils"
import { credentialDigest } from "~/lib/storage/credentials-repository"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import {
  remainingStorageMs,
  withStorageDeadline,
} from "~/lib/storage/operation-budget"
import { readStoreRevision } from "~/lib/storage/operations"

interface Operation {
  id: string
  kind: string
  actor: string
  digest: string
}

export interface DesktopAuthMutationResult<T> {
  value: T
  changed: boolean
}

const states = new WeakMap<
  Storage,
  { queue: SerialQueue; pending?: Operation }
>()
const pendingOperations = new Set<string>()
const RECEIPT_RETENTION_MS = 86_400_000

function setPending(
  state: { pending?: Operation },
  operation: Operation | undefined,
): void {
  if (state.pending) pendingOperations.delete(state.pending.id)
  state.pending = operation
  if (operation) pendingOperations.add(operation.id)
}

async function pruneReceipts(session: SqlSession, now: number): Promise<void> {
  const pending = [...pendingOperations]
  const exclusion =
    pending.length > 0 ?
      " AND id NOT IN (" + pending.map(() => "?").join(",") + ")"
    : ""
  // One day exceeds storage deadlines. An unresolved local commit keeps its
  // receipt until reconciliation, including through another live connection.
  await session.execute({
    sql:
      "DELETE FROM capi_applied_operations WHERE kind GLOB 'desktop-auth.*' AND created_at < ?"
      + exclusion,
    args: [now - RECEIPT_RETENTION_MS, ...pending],
  })
}

async function committed(storage: Storage, operation: Operation) {
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT kind,actor_id,input_digest,result_json FROM capi_applied_operations WHERE id=?",
      args: [operation.id],
    }),
  )
  const row = rows.at(0)
  if (!row) return false
  if (
    row.kind !== operation.kind
    || row.actor_id !== operation.actor
    || row.input_digest !== operation.digest
    || row.result_json !== '{"status":"committed"}'
  )
    throw new StorageSchemaError(
      "Invalid Desktop authentication mutation marker",
    )
  return true
}

async function reconcile(storage: Storage, operation: Operation) {
  try {
    return await committed(storage, operation)
  } catch {
    return false
  }
}

/** Issued secrets remain in memory; durable receipts contain only commit evidence. */
export async function mutateDesktopAuth<T>(
  storage: Storage,
  input: { kind: string; actor: string; binding: unknown },
  work: (session: SqlSession) => Promise<DesktopAuthMutationResult<T>>,
): Promise<T> {
  let state = states.get(storage)
  if (!state) {
    state = { queue: new SerialQueue() }
    states.set(storage, state)
  }
  const owned = state
  const operation: Operation = {
    id: randomUUID(),
    kind: "desktop-auth." + input.kind,
    actor: "desktop-auth:" + credentialDigest(input.actor),
    digest: credentialDigest(JSON.stringify(input.binding)),
  }
  return withStorageDeadline(Date.now() + 30_000, () =>
    owned.queue.run(async () => {
      if (owned.pending) {
        if (!(await reconcile(storage, owned.pending)))
          throw new StorageCommitUnknownError(owned.pending.id)
        setPending(owned, undefined)
      }
      for (let attempt = 0; ; attempt++) {
        let result: DesktopAuthMutationResult<T> | undefined
        try {
          return await storage.transaction(async (session) => {
            result = await work(session)
            if (result.changed) {
              const committedAt = Date.now()
              await pruneReceipts(session, committedAt)
              await session.execute({
                sql: "INSERT INTO capi_applied_operations (id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES (?,?,?,?,?,?,?)",
                args: [
                  operation.id,
                  operation.kind,
                  operation.actor,
                  operation.digest,
                  await readStoreRevision(session),
                  '{"status":"committed"}',
                  committedAt,
                ],
              })
            }
            return result.value
          })
        } catch (error) {
          if (error instanceof StorageCommitUnknownError) {
            if (result && !result.changed) return result.value
            setPending(owned, operation)
            if (result && (await reconcile(storage, operation))) {
              setPending(owned, undefined)
              return result.value
            }
            throw new StorageCommitUnknownError(operation.id)
          }
          if (
            !(error instanceof StorageConflictError)
            || !error.retryable
            || attempt >= 2
          )
            throw error
          const delay = 25 * (attempt + 1)
          if (remainingStorageMs() <= delay)
            throw new StorageUnavailableError("timeout")
          await Bun.sleep(delay)
        }
      }
    }),
  )
}
