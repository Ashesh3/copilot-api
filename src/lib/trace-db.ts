import { Database } from "bun:sqlite"
import { join } from "node:path"

import { PATHS } from "~/lib/paths"

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    status_message TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT,
    input TEXT,
    output TEXT,
    environment TEXT,
    user_id TEXT,
    session_id TEXT,
    tags TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS spans (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    status_message TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    input_cost_usd REAL DEFAULT 0,
    output_cost_usd REAL DEFAULT 0,
    input TEXT,
    output TEXT,
    metadata TEXT,
    FOREIGN KEY (trace_id) REFERENCES traces(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status)`,
  `CREATE INDEX IF NOT EXISTS idx_traces_environment ON traces(environment)`,
  `CREATE INDEX IF NOT EXISTS idx_spans_model ON spans(model)`,
]

let db: Database | null = null

export function getTraceDb(): Database {
  if (!db) {
    const dbPath = join(PATHS.APP_DIR, "traces.db")
    db = new Database(dbPath)
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA foreign_keys=ON")
    for (const sql of SCHEMA_STATEMENTS) {
      db.run(sql)
    }
  }
  return db
}

export function closeTraceDb(): void {
  db?.close()
  db = null
}
