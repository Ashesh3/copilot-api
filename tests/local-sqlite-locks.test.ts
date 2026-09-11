import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { SqlSession } from "~/lib/storage/types"

import { StorageUnavailableError } from "~/lib/storage/errors"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { withStorageDeadline } from "~/lib/storage/operation-budget"

const sql = (sql: string) => ({ sql, args: [] })
const LOCK_SCRIPT = `
import { Database } from "bun:sqlite";
const database = new Database(process.argv[1]);
database.run("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
console.log("locked");
let timeout;
await Promise.race([
  Bun.stdin.text(),
  new Promise((resolve) => { timeout = setTimeout(resolve, 1500); }),
]);
clearTimeout(timeout);
database.run("ROLLBACK");
database.close();
`

async function fixture() {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, "capi-sqlite-lock-"))
  const path = join(directory, "copilot-api.sqlite")
  const storage = new LocalSqliteStorage(path)
  await storage.atomicBatch([
    sql("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT NOT NULL)"),
    sql("INSERT INTO sample VALUES(1,'committed')"),
  ])
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--eval", LOCK_SCRIPT, path],
    {
      cwd: directory,
      windowsHide: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const reader = child.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  if (!new TextDecoder().decode(ready.value).includes("locked")) {
    child.kill()
    await child.exited
    await storage.close()
    throw new Error("External SQLite lock was not acquired")
  }
  let releasing: Promise<void> | undefined
  const release = () => {
    releasing ??= (async () => {
      await child.stdin.end()
      if ((await child.exited) !== 0)
        throw new Error("External SQLite lock did not release cleanly")
    })()
    return releasing
  }
  return {
    storage,
    release,
    async close() {
      await release()
      await storage.close()
      if (dirname(directory) !== parent) throw new Error("Invalid fixture path")
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    },
  }
}

test("external write contention respects its deadline while timers and queued WAL reads progress", async () => {
  const f = await fixture()
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  try {
    let callbacks = 0
    const started = performance.now()
    const writing = withStorageDeadline(Date.now() + 100, () =>
      f.storage.transaction((session) => {
        callbacks++
        return session.execute(
          sql("UPDATE sample SET value='unexpected' WHERE id=1"),
        )
      }),
    ).catch((error: unknown) => error)
    const read = await withStorageDeadline(Date.now() + 300, () =>
      f.storage.read((session) =>
        session.query(sql("SELECT value FROM sample")),
      ),
    ).catch((error: unknown) => error)
    const readMs = performance.now() - started
    const failure: unknown = await writing
    expect(read).toEqual([{ value: "committed" }])
    expect(readMs).toBeLessThan(300)
    expect(failure).toBeInstanceOf(StorageUnavailableError)
    expect(failure).toMatchObject({ reason: "timeout" })
    expect(performance.now() - started).toBeLessThan(600)
    expect(ticks).toBeGreaterThanOrEqual(2)
    expect(callbacks).toBe(0)
    await f.release()
    await f.storage.transaction((session) =>
      session.execute(
        sql("UPDATE sample SET value='after-timeout' WHERE id=1"),
      ),
    )
    expect(
      await f.storage.read((session) =>
        session.query(sql("SELECT value FROM sample")),
      ),
    ).toEqual([{ value: "after-timeout" }])
  } finally {
    clearInterval(timer)
    await f.close()
  }
})

test("a waiting writer acquires after release and calls its transaction callback once", async () => {
  const f = await fixture()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let callbacks = 0
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 10)
    const writing = withStorageDeadline(Date.now() + 1000, () =>
      f.storage.transaction((session) => {
        callbacks++
        return session.execute(
          sql("UPDATE sample SET value='written' WHERE id=1"),
        )
      }),
    )
    const outcome = writing.catch((error: unknown) => error)
    timer = setTimeout(() => {
      void f.release()
    }, 80)
    try {
      expect(await outcome).toEqual({ rowsAffected: 1 })
      expect(callbacks).toBe(1)
      expect(ticks).toBeGreaterThanOrEqual(2)
      expect(
        await f.storage.read((session) =>
          session.query(sql("SELECT value FROM sample")),
        ),
      ).toEqual([{ value: "written" }])
    } finally {
      clearInterval(heartbeat)
    }
  } finally {
    clearTimeout(timer)
    await f.close()
  }
})

test("closing storage stops a writer still waiting for an external lock", async () => {
  const f = await fixture()
  try {
    let callbacks = 0
    const writing = f.storage
      .transaction(async () => {
        callbacks++
        await Promise.resolve()
      })
      .catch((error: unknown) => error)
    await Bun.sleep(20)
    const started = performance.now()
    await f.storage.close()
    expect(performance.now() - started).toBeLessThan(300)
    expect(await writing).toBeInstanceOf(StorageUnavailableError)
    expect(callbacks).toBe(0)
  } finally {
    await f.close()
  }
})

test("isolated read snapshots keep WAL data visible while a writer waits", async () => {
  const f = await fixture()
  try {
    const writing = withStorageDeadline(Date.now() + 100, () =>
      f.storage.transaction((session) =>
        session.execute(sql("DELETE FROM sample")),
      ),
    ).catch((error: unknown) => error)
    const rows = await f.storage.readSnapshot(
      async (session) => ({
        timeout: await session.query(sql("PRAGMA busy_timeout")),
        rows: await session.query(sql("SELECT value FROM sample")),
      }),
      { timeoutMs: 300 },
    )
    expect(rows.rows).toEqual([{ value: "committed" }])
    expect(Object.values(rows.timeout[0] ?? {})).toEqual([0])
    expect(await writing).toBeInstanceOf(StorageUnavailableError)
  } finally {
    await f.close()
  }
})

test("closing storage still waits for an acquired transaction to finish once", async () => {
  const f = await fixture()
  await f.release()
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  try {
    let callbacks = 0
    const writing = f.storage.transaction(async (session) => {
      callbacks++
      await session.execute(sql("UPDATE sample SET value='owned' WHERE id=1"))
      admitted.resolve(undefined)
      await release.promise
    })
    await admitted.promise
    let closed = false
    const closing = f.storage.close().then(() => {
      closed = true
    })
    await Bun.sleep(20)
    expect(closed).toBe(false)
    release.resolve(undefined)
    await writing
    await closing
    expect(callbacks).toBe(1)
    expect(closed).toBe(true)
  } finally {
    release.resolve(undefined)
    await f.close()
  }
})

test("cancelled isolated snapshots revoke their session without blocking the main connection", async () => {
  const f = await fixture()
  const abort = new AbortController()
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let leaked: SqlSession | undefined
  try {
    const snapshot = f.storage
      .readSnapshot(
        async (session) => {
          leaked = session
          await session.query(sql("SELECT value FROM sample"))
          admitted.resolve(undefined)
          await release.promise
          return session.query(sql("SELECT value FROM sample"))
        },
        { signal: abort.signal },
      )
      .catch((error: unknown) => error)
    await admitted.promise
    abort.abort()
    expect(await snapshot).toBeInstanceOf(StorageUnavailableError)
    expect(
      await leaked
        ?.query(sql("SELECT value FROM sample"))
        .catch((error: unknown) => error),
    ).toMatchObject({ code: "storage_schema" })
    expect(
      await f.storage.read((session) =>
        session.query(sql("SELECT value FROM sample")),
      ),
    ).toEqual([{ value: "committed" }])
  } finally {
    release.resolve(undefined)
    await f.close()
  }
})
