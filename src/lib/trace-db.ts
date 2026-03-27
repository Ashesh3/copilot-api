import { SCHEMA_SQL } from "@breadcrumb/server"
import { Database } from "bun:sqlite"
import { join } from "node:path"

import { PATHS } from "~/lib/paths"

let db: Database | null = null

export function getTraceDb(): Database {
  if (!db) {
    const dbPath = join(PATHS.APP_DIR, "traces.db")
    db = new Database(dbPath)
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA foreign_keys=ON")
    for (const stmt of SCHEMA_SQL.split(";")) {
      const sql = stmt.trim()
      if (sql) db.run(sql)
    }
  }
  return db
}

export function closeTraceDb(): void {
  db?.close()
  db = null
}
