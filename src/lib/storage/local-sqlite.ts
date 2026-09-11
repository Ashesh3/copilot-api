import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { SqlSession, SqlStatement, Storage } from "~/lib/storage/types"

import {
  assertNotNested,
  normalizeRows,
  operationContext,
  rowsAffected,
  scopedSession,
  snapshotStatement,
  validateStatement,
  SerialQueue,
} from "~/lib/storage/adapter-utils"
import { storageError, StorageUnavailableError } from "~/lib/storage/errors"
import {
  deadlinePromise,
  getStorageDeadline,
} from "~/lib/storage/operation-budget"

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && /^SQLITE_(?:BUSY|LOCKED)/.test(String(error.code))
  )
}

function checkDeadline(expires: number): void {
  if (Date.now() >= expires) throw new StorageUnavailableError("timeout")
}

async function waitForLock(expires: number): Promise<void> {
  checkDeadline(expires)
  await Bun.sleep(Math.max(1, Math.min(10, expires - Date.now())))
}

async function queryRows(
  database: Database,
  statement: SqlStatement,
  options: { expires: number; readOnly: boolean; signal: AbortSignal },
): Promise<ReadonlyArray<Record<string, unknown>>> {
  for (;;) {
    checkDeadline(options.expires)
    if (options.signal.aborted) throw new StorageUnavailableError()
    try {
      return normalizeRows(database.query(statement.sql).all(...statement.args))
    } catch (error) {
      if (!options.readOnly || !database.inTransaction || !isSqliteBusy(error))
        throw storageError(error)
      // Only validated read statements can retry within the same snapshot.
      // A write failure still poisons its scope before any later SQL runs.
      await waitForLock(options.expires)
    }
  }
}

type Acquisition<T> = { acquired: false } | { acquired: true; value: T }

export class LocalSqliteStorage implements Storage {
  private readonly databasePath: string
  private readonly db: Database
  private readonly queue = new SerialQueue()
  private closed = false

  constructor(path: string) {
    this.databasePath = path
    let db: Database | undefined
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      db = new Database(path, {
        create: true,
        strict: true,
        safeIntegers: true,
      })
      if (process.platform !== "win32") chmodSync(path, 0o600)
      db.run(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL",
      )
      for (const [name, wanted] of [
        ["journal_mode", "wal"],
        ["foreign_keys", 1n],
        ["synchronous", 2n],
        ["busy_timeout", 0n],
      ] as const) {
        const row = db.query(`PRAGMA ${name}`).get() as Record<
          string,
          unknown
        > | null
        if (!row || Object.values(row)[0] !== wanted)
          throw new StorageUnavailableError()
      }
      this.db = db
    } catch (error) {
      db?.close()
      throw storageError(error)
    }
  }

  private driver(
    expires: number,
    readOnly: boolean,
    signal: AbortSignal,
  ): SqlSession {
    return {
      query: (statement) =>
        queryRows(this.db, statement, { expires, readOnly, signal }),
      execute: (statement) => {
        try {
          if (Date.now() >= expires)
            throw new StorageUnavailableError("timeout")
          return Promise.resolve({
            rowsAffected: rowsAffected(
              this.db.query(statement.sql).run(...statement.args).changes,
            ),
          })
        } catch (error) {
          return Promise.reject(storageError(error))
        }
      },
    }
  }

  private async operate<T>(
    work: (session: SqlSession) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> {
    assertNotNested(this)
    const expires = Math.min(
      Date.now() + 30_000,
      getStorageDeadline() ?? Infinity,
    )
    for (;;) {
      const result = await deadlinePromise(
        this.queue.run(() =>
          operationContext.run(this, async (): Promise<Acquisition<T>> => {
            checkDeadline(expires)
            if (this.closed) throw new StorageUnavailableError()
            try {
              this.db.run(readOnly ? "BEGIN" : "BEGIN IMMEDIATE")
            } catch (error) {
              if (!this.db.inTransaction && isSqliteBusy(error))
                return { acquired: false }
              throw storageError(error, !this.db.inTransaction)
            }
            return {
              acquired: true,
              value: await this.completeOperation(work, readOnly, expires),
            }
          }),
        ),
        expires,
      )
      if (result.acquired) return result.value
      // An unsuccessful BEGIN owns no transaction. Release the connection's
      // queue before waiting so WAL readers can pass a contended writer.
      await waitForLock(expires)
    }
  }

  private async completeOperation<T>(
    work: (session: SqlSession) => Promise<T>,
    readOnly: boolean,
    expires: number,
  ): Promise<T> {
    const cancelled = new AbortController()
    const scope = scopedSession(
      this.driver(expires, readOnly, cancelled.signal),
      readOnly,
    )
    try {
      const result = await deadlinePromise(
        Promise.resolve().then(() => {
          checkDeadline(expires)
          return work(scope.session)
        }),
        expires,
      )
      await scope.finish()
      checkDeadline(expires)
      this.db.run("COMMIT")
      return result
    } catch (error) {
      scope.revoke()
      cancelled.abort()
      await scope.finish().catch(() => {})
      let rolledBack = !this.db.inTransaction
      if (this.db.inTransaction) {
        try {
          this.db.run("ROLLBACK")
          rolledBack = true
        } catch {
          this.closed = true
          this.db.close()
        }
      }
      if (error instanceof Error && !("code" in error)) throw error
      throw storageError(error, rolledBack)
    } finally {
      scope.revoke()
      cancelled.abort()
    }
  }

  read<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.operate(work, true)
  }

  async readSnapshot<T>(
    work: (session: SqlSession) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    assertNotNested(this)
    if (this.closed) throw new StorageUnavailableError()
    options.signal?.throwIfAborted()
    const database = new Database(this.databasePath, {
      readonly: true,
      strict: true,
      safeIntegers: true,
    })
    const expires = Date.now() + (options.timeoutMs ?? 1_800_000)
    const cancelled = new AbortController()
    const scope = scopedSession(
      {
        query: (statement) =>
          queryRows(database, statement, {
            expires,
            readOnly: true,
            signal: cancelled.signal,
          }),
        execute: () => Promise.reject(new StorageUnavailableError()),
      },
      true,
    )
    let aborted: (() => void) | undefined
    const abort = new Promise<never>((_resolve, reject) => {
      aborted = () => {
        scope.revoke()
        cancelled.abort()
        reject(new StorageUnavailableError())
      }
      options.signal?.addEventListener("abort", aborted, { once: true })
    })
    try {
      database.run("PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN")
      options.signal?.throwIfAborted()
      const result = await deadlinePromise(
        Promise.race([work(scope.session), abort]),
        expires,
      )
      await scope.finish()
      checkDeadline(expires)
      database.run("COMMIT")
      return result
    } finally {
      scope.revoke()
      cancelled.abort()
      if (aborted) options.signal?.removeEventListener("abort", aborted)
      await scope.finish().catch(() => {})
      try {
        if (database.inTransaction) database.run("ROLLBACK")
      } finally {
        database.close()
      }
    }
  }
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.operate(work, false)
  }
  async atomicBatch(statements: ReadonlyArray<SqlStatement>): Promise<void> {
    const snapshots = statements.map((statement) =>
      snapshotStatement(statement),
    )
    for (const statement of snapshots) validateStatement(statement)
    await this.transaction(async (session) => {
      for (const statement of snapshots) await session.execute(statement)
    })
  }
  async close(): Promise<void> {
    assertNotNested(this)
    await this.queue.run(() => {
      if (!this.closed) {
        this.closed = true
        this.db.close()
      }
      return Promise.resolve()
    })
  }
}
