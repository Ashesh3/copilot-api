import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { exportDatabaseResponse } from "~/lib/database-export"
import { LocalHTTPError } from "~/lib/error"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "capi-native-export-test-"))
  const path = join(directory, "data with 'quote.sqlite")
  const database = new Database(path, { create: true, strict: true })
  database.run("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
  database.run(
    "CREATE TABLE secrets(id INTEGER PRIMARY KEY, value TEXT, payload BLOB)",
  )
  database.run("PRAGMA wal_checkpoint(TRUNCATE)")
  database
    .query("INSERT INTO secrets VALUES (1, ?, ?)")
    .run("stored-fixture-secret", new Uint8Array([0, 1, 255]))
  return {
    directory,
    path,
    database,
    exports: async () =>
      (await readdir(directory)).filter((name) =>
        name.startsWith(".database-export-"),
      ),
    async close() {
      database.close()
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    },
  }
}

test("database download is a standalone SQLite snapshot including committed WAL secrets", async () => {
  const f = await fixture()
  try {
    expect((await stat(`${f.path}-wal`)).size).toBeGreaterThan(0)
    const response = await exportDatabaseResponse(f.path)
    expect(response.headers.get("content-type")).toBe("application/vnd.sqlite3")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-disposition")).toMatch(
      /attachment; filename="copilot-api-database-.*\.sqlite"/,
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(new TextDecoder().decode(bytes.subarray(0, 16))).toBe(
      "SQLite format 3\u0000",
    )
    const copy = Database.deserialize(bytes)
    try {
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      })
      expect(copy.query("SELECT * FROM secrets").all()).toEqual([
        {
          id: 1,
          value: "stored-fixture-secret",
          payload: new Uint8Array([0, 1, 255]),
        },
      ])
      expect(copy.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "memory",
      })
    } finally {
      copy.close()
    }
    expect(await f.exports()).toEqual([])
  } finally {
    await f.close()
  }
})

test("slow downloads release the source snapshot and cancellation removes the private export", async () => {
  const f = await fixture()
  try {
    const response = await exportDatabaseResponse(f.path)
    f.database
      .query("INSERT INTO secrets VALUES (2, ?, NULL)")
      .run("after-snapshot")
    expect(
      f.database.query("PRAGMA wal_checkpoint(TRUNCATE)").get(),
    ).toMatchObject({ busy: 0 })
    expect(await f.exports()).toHaveLength(1)
    await response.body?.cancel()
    expect(await f.exports()).toEqual([])
    expect(
      f.database.query("SELECT COUNT(*) AS count FROM secrets").get(),
    ).toEqual({ count: 2 })
  } finally {
    await f.close()
  }
})

test("export failure and already-cancelled requests leave no temporary database", async () => {
  const f = await fixture()
  try {
    let failure: unknown
    try {
      await exportDatabaseResponse(join(f.directory, "missing.sqlite"))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(f.directory)
    expect(await f.exports()).toEqual([])
    const aborted = new AbortController()
    aborted.abort()
    try {
      await exportDatabaseResponse(f.path, aborted.signal)
      throw new Error("Expected cancelled export")
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException)
    }
    expect(await f.exports()).toEqual([])
  } finally {
    await f.close()
  }
})

test("only one export can generate or await download consumption", async () => {
  const f = await fixture()
  let response: Response | undefined
  try {
    const generating = exportDatabaseResponse(f.path)
    const generatingConflict: unknown = await exportDatabaseResponse(
      f.path,
    ).catch((error: unknown) => error)
    expect(generatingConflict).toBeInstanceOf(LocalHTTPError)
    if (!(generatingConflict instanceof LocalHTTPError))
      throw new Error("Expected conflict")
    expect(generatingConflict.response.status).toBe(409)
    response = await generating
    const downloadConflict: unknown = await exportDatabaseResponse(
      f.path,
    ).catch((error: unknown) => error)
    expect(downloadConflict).toBeInstanceOf(LocalHTTPError)
    if (!(downloadConflict instanceof LocalHTTPError))
      throw new Error("Expected conflict")
    expect(downloadConflict.response.status).toBe(409)
    await response.body?.cancel()
    response = await exportDatabaseResponse(f.path)
    await response.arrayBuffer()
    expect(await f.exports()).toEqual([])
  } finally {
    await response?.body?.cancel().catch(() => {})
    await f.close()
  }
})

test("request cancellation closes an unconsumed download and releases the export slot", async () => {
  const f = await fixture()
  const aborted = new AbortController()
  try {
    const response = await exportDatabaseResponse(f.path, aborted.signal)
    aborted.abort()
    const failure: unknown = await response
      .arrayBuffer()
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ name: "AbortError" })
    expect(await f.exports()).toEqual([])
    const replacement = await exportDatabaseResponse(f.path)
    await replacement.body?.cancel()
  } finally {
    aborted.abort()
    await f.close()
  }
})

test("a database lock leaves the event loop free to cancel snapshot generation", async () => {
  const f = await fixture()
  const aborted = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    f.database.run("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE")
    const pending = exportDatabaseResponse(f.path, aborted.signal).catch(
      (error: unknown) => error,
    )
    timer = setTimeout(() => aborted.abort(), 100)
    const failure: unknown = await pending
    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ name: "AbortError" })
    expect(await f.exports()).toEqual([])
    f.database.run("ROLLBACK")
    const replacement = await exportDatabaseResponse(f.path)
    await replacement.body?.cancel()
  } finally {
    clearTimeout(timer)
    aborted.abort()
    if (f.database.inTransaction) f.database.run("ROLLBACK")
    await f.close()
  }
})

test("signal abort and body cancellation share cleanup safely", async () => {
  const f = await fixture()
  const aborted = new AbortController()
  try {
    const response = await exportDatabaseResponse(f.path, aborted.signal)
    aborted.abort()
    await response.body?.cancel()
    expect(await f.exports()).toEqual([])
    const replacement = await exportDatabaseResponse(f.path)
    await replacement.body?.cancel()
  } finally {
    aborted.abort()
    await f.close()
  }
})

test("an interrupted export file fails safely and releases its download resources", async () => {
  const f = await fixture()
  try {
    const response = await exportDatabaseResponse(f.path)
    const [directory] = await f.exports()
    if (!directory) throw new Error("Expected private export directory")
    const path = join(f.directory, directory, "database.sqlite")
    await truncate(path, 0)
    const failure: unknown = await response
      .arrayBuffer()
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LocalHTTPError)
    expect(String(failure)).not.toContain(path)
    expect(await f.exports()).toEqual([])
    const replacement = await exportDatabaseResponse(f.path)
    await replacement.body?.cancel()
  } finally {
    await f.close()
  }
})
