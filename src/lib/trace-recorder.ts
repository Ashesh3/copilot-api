import consola from "consola"

import { getTraceDb } from "~/lib/trace-db"

export interface SpanData {
  id: string
  traceId: string
  parentSpanId?: string
  name: string
  type: "llm" | "tool" | "retrieval" | "step" | "custom"
  startTime: string
  endTime: string
  status?: string
  statusMessage?: string
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  inputCostUsd?: number
  outputCostUsd?: number
  input?: string
  output?: string
  metadata?: string
}

interface TraceMeta {
  environment?: string
  userId?: string
  sessionId?: string
  tags?: string
}

interface StartTraceOptions {
  id: string
  name: string
  input?: string
  meta?: TraceMeta
}

interface EndTraceOptions {
  id: string
  status: string
  output?: string
  statusMessage?: string
}

class TraceRecorder {
  startTrace(options: StartTraceOptions): void {
    try {
      const db = getTraceDb()
      db.run(
        `INSERT INTO traces (id, name, start_time, input, environment, user_id, session_id, tags)
         VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
        [
          options.id,
          options.name,
          options.input ?? null,
          options.meta?.environment ?? null,
          options.meta?.userId ?? null,
          options.meta?.sessionId ?? null,
          options.meta?.tags ?? null,
        ],
      )
    } catch (error) {
      consola.debug(
        "Failed to start trace:",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  endTrace(options: EndTraceOptions): void {
    try {
      const db = getTraceDb()
      db.run(
        `UPDATE traces SET end_time = datetime('now'), status = ?, output = ?, status_message = ? WHERE id = ?`,
        [
          options.status,
          options.output ?? null,
          options.statusMessage ?? null,
          options.id,
        ],
      )
    } catch (error) {
      consola.debug(
        "Failed to end trace:",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  recordSpan(span: SpanData): void {
    try {
      const db = getTraceDb()
      db.run(
        `INSERT INTO spans (id, trace_id, parent_span_id, name, type, status, status_message, start_time, end_time, provider, model, input_tokens, output_tokens, input_cost_usd, output_cost_usd, input, output, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          span.id,
          span.traceId,
          span.parentSpanId ?? null,
          span.name,
          span.type,
          span.status ?? "ok",
          span.statusMessage ?? null,
          span.startTime,
          span.endTime,
          span.provider ?? null,
          span.model ?? null,
          span.inputTokens ?? 0,
          span.outputTokens ?? 0,
          span.inputCostUsd ?? 0,
          span.outputCostUsd ?? 0,
          span.input ?? null,
          span.output ?? null,
          span.metadata ?? null,
        ],
      )
    } catch (error) {
      consola.debug(
        "Failed to record span:",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  cleanup(retentionDays: number): void {
    try {
      const db = getTraceDb()
      db.run(
        `DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE start_time < datetime('now', ?))`,
        [`-${retentionDays} days`],
      )
      db.run(`DELETE FROM traces WHERE start_time < datetime('now', ?)`, [
        `-${retentionDays} days`,
      ])
      consola.debug(
        `Trace cleanup: removed entries older than ${retentionDays} days`,
      )
    } catch (error) {
      consola.debug(
        "Failed to clean up traces:",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export const traceRecorder = new TraceRecorder()
