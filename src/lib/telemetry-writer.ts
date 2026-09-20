import { randomUUID } from "node:crypto"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import type { HistoryRepository } from "~/lib/storage/history-repository"
import type { HistoryResetState } from "~/lib/storage/history-reset"
import type { JsonValue, MutationContext, Storage } from "~/lib/storage/types"

import { StorageUnavailableError } from "~/lib/storage/errors"
import {
  createHistoryRepository,
  historyObject,
  isHistoryRecordKind,
} from "~/lib/storage/history-repository"
import {
  historyRecordSurvivesReset,
  normalizeHistoryRecordAfterReset,
} from "~/lib/storage/history-reset"
import { withStorageDeadline } from "~/lib/storage/operation-budget"

export interface HistoryRecord {
  id: string
  kind: "usage" | "routing" | "collection-gap"
  recordedAt: number
  generation: number
  payload: JsonValue
}
export interface PendingHistoryRecord {
  record: HistoryRecord
  batchId?: string
}
export interface TelemetryStatus {
  pendingRecords: number
  pendingBytes: number
  droppedRecords: number
  lastSuccessfulFlush: number | null
  degraded: boolean
}
export interface TelemetryWriter {
  enqueue(record: HistoryRecord): boolean
  flush(): Promise<void>
  reset(context: MutationContext): Promise<HistoryResetState>
  status(): TelemetryStatus
  close(deadlineMs: number): Promise<TelemetryStatus>
  read<T>(
    work: (pending: ReadonlyArray<PendingHistoryRecord>) => Promise<T>,
  ): Promise<T>
}
export interface HistoryRuntime {
  storage: Storage
  repository: HistoryRepository
  writer: TelemetryWriter
  close(deadlineMs: number): Promise<TelemetryStatus>
}
interface Queued {
  record: HistoryRecord
  bytes: number
  enqueuedAt: number
}
interface Batch {
  id: string
  items: Array<Queued>
  records: Array<HistoryRecord>
  createdAt: number
}
interface TelemetryWriterOptions {
  autoFlush?: boolean
  beforeFlush?: () => Promise<void>
}
const MAX_RECORDS = 2000,
  MAX_BYTES = 16 * 1024 * 1024,
  MAX_AGE = 300_000
let lastWarning = -Infinity
export function reportTelemetryFailure(): void {
  if (Date.now() - lastWarning < 60_000) return
  lastWarning = Date.now()
  process.stderr.write(
    "History collection is degraded; buffered records may be lost.\n",
  )
}

function mergeGapPayload(
  incoming: { [key: string]: JsonValue },
  previous: { [key: string]: JsonValue } | undefined,
  recordedAt: number,
): { [key: string]: JsonValue } {
  const prior = previous ?? {}
  const payload = structuredClone(incoming)
  for (const field of ["startedAt", "firstRecordAt", "lastRecordAt"]) {
    const next = Number(incoming[field] ?? recordedAt)
    const before = Number(prior[field] ?? next)
    payload[field] =
      field === "lastRecordAt" ? Math.max(next, before) : Math.min(next, before)
  }
  if (incoming.unknown === true) {
    delete payload.lostRecords
    delete payload.lostBytes
    if (prior.reason === "reset-overlapping-collection-gap")
      payload.reason = prior.reason
  } else {
    for (const field of ["lostRecords", "lostBytes"])
      payload[field] = Number(prior[field] ?? 0) + Number(incoming[field] ?? 0)
  }
  if (
    typeof incoming.discardedRecords === "number"
    && (!previous || typeof previous.discardedRecords === "number")
  )
    payload.discardedRecords =
      Number(prior.discardedRecords ?? 0) + incoming.discardedRecords
  else delete payload.discardedRecords
  return payload
}

// eslint-disable-next-line max-lines-per-function -- One closure owns queue, retry batch and admission state.
export function createTelemetryWriter(
  repository: HistoryRepository,
  clock: { now(): number } = { now: Date.now },
  options: TelemetryWriterOptions = {},
): TelemetryWriter {
  const queue: Array<Queued> = []
  const gaps = new Map<string, HistoryRecord>()
  let active: Batch | undefined,
    pendingBytes = 0,
    droppedRecords = 0
  let lastSuccessfulFlush: number | null = null,
    failed = false,
    closed = false
  let resetState: HistoryResetState | null = null
  let failedAt = 0,
    failedGeneration = 0
  let closing: Promise<TelemetryStatus> | undefined
  let flushing: Promise<void> | undefined
  let flushDeadline = Infinity
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work)
    tail = result.catch(() => undefined)
    return result
  }
  const count = () => queue.length + (active?.items.length ?? 0)
  const markFailed = (
    at = clock.now(),
    generation = resetState?.revision ?? 0,
  ) => {
    if (!failed || at >= failedAt) {
      failedAt = at
      failedGeneration = generation
    }
    failed = true
  }
  const retainGap = (record: HistoryRecord) => {
    const incoming = historyObject(record.payload)
    const historyKind =
      isHistoryRecordKind(incoming.historyKind) ?
        incoming.historyKind
      : "collection-gap"
    const unknown = incoming.unknown === true
    // Only the current generation needs the same-millisecond exemption.
    // Older intervals are compared by time and share one bounded partition.
    const generation =
      resetState && record.generation >= resetState.revision ?
        resetState.revision
      : 0
    const key = JSON.stringify([historyKind, unknown, generation])
    const prior = gaps.get(key)
    const previous = prior ? historyObject(prior.payload) : undefined
    const payload = mergeGapPayload(incoming, previous, record.recordedAt)
    payload.historyKind = historyKind
    gaps.set(key, {
      ...record,
      id: prior?.id ?? record.id,
      generation,
      payload,
    })
  }
  const pendingGaps = (): Array<HistoryRecord> =>
    [
      ...gaps.values(),
      ...(active?.records.filter((record) => record.kind === "collection-gap")
        ?? []),
    ].flatMap((record) => {
      const retained = normalizeHistoryRecordAfterReset(record, resetState)
      return retained ? [retained] : []
    })
  const resetActive = (state: HistoryResetState) => {
    if (!active) return
    active.items = active.items.filter((item) =>
      historyRecordSurvivesReset(item.record, state),
    )
    // Keep the original records/digest for an uncertain batch's receipt.
    if (
      !active.records.some((record) =>
        historyRecordSurvivesReset(record, state),
      )
    )
      active = undefined
  }
  const applyReset = (state: HistoryResetState | null) => {
    if (!state || state.revision <= (resetState?.revision ?? 0)) return
    resetState = state
    for (let i = queue.length - 1; i >= 0; i--)
      if (!historyRecordSurvivesReset(queue[i].record, state))
        queue.splice(i, 1)
    resetActive(state)
    const previousGaps = [...gaps.values()]
    gaps.clear()
    for (const record of previousGaps) {
      const retained = normalizeHistoryRecordAfterReset(record, state)
      if (retained) retainGap(retained)
    }
    pendingBytes = [...queue, ...(active?.items ?? [])].reduce(
      (sum, item) => sum + item.bytes,
      0,
    )
    droppedRecords = pendingGaps().reduce(
      (sum, record) =>
        sum + Number(historyObject(record.payload).discardedRecords ?? 0),
      0,
    )
    if (failedAt <= state.resetAt && failedGeneration < state.revision)
      failed = false
    if (lastSuccessfulFlush !== null && lastSuccessfulFlush <= state.resetAt)
      lastSuccessfulFlush = null
  }
  const syncReset = async () => {
    applyReset(await repository.resetState())
  }
  const loss = (item: Queued, unknown = false) => {
    retainGap({
      id: randomUUID(),
      kind: "collection-gap",
      generation: item.record.generation,
      recordedAt: clock.now(),
      payload: {
        historyKind: item.record.kind,
        startedAt: item.enqueuedAt,
        firstRecordAt: item.record.recordedAt,
        lastRecordAt: item.record.recordedAt,
        discardedRecords: 1,
        ...(unknown ?
          { unknown: true, reason: "expired-unconfirmed-batch" }
        : { lostRecords: 1, lostBytes: item.bytes }),
      },
    })
    markFailed(item.record.recordedAt, item.record.generation)
  }
  const drop = (item: Queued) => {
    pendingBytes -= item.bytes
    droppedRecords++
    loss(item)
  }
  const expire = () => {
    for (let i = queue.length - 1; i >= 0; i--)
      if (clock.now() - queue[i].enqueuedAt > MAX_AGE)
        drop(queue.splice(i, 1)[0])
    if (active && clock.now() - active.createdAt > MAX_AGE) {
      for (const item of active.items) {
        pendingBytes -= item.bytes
        droppedRecords++
        loss(item, true)
      }
      // A response may have been lost after commit. Never assert an exact loss.
      for (const record of active.records)
        if (record.kind === "collection-gap") {
          const retained = normalizeHistoryRecordAfterReset(record, resetState)
          if (!retained) continue
          const payload = historyObject(retained.payload)
          retainGap({
            ...retained,
            id: randomUUID(),
            recordedAt: clock.now(),
            payload: {
              ...payload,
              unknown: true,
              reason: "expired-unconfirmed-batch",
            },
          })
        }
      markFailed()
      active = undefined
    }
  }
  const snapshot = (): TelemetryStatus => ({
    pendingRecords: count(),
    pendingBytes,
    droppedRecords,
    lastSuccessfulFlush,
    degraded: failed || gaps.size > 0,
  })
  const flushOnce = async () => {
    try {
      await withStorageDeadline(
        Math.min(Date.now() + 5000, flushDeadline),
        syncReset,
      )
      if (options.beforeFlush)
        await withStorageDeadline(
          Math.min(Date.now() + 5000, flushDeadline),
          options.beforeFlush,
        )
    } catch {
      markFailed()
      reportTelemetryFailure()
      return
    }
    expire()
    if (!active) {
      const items: Array<Queued> = []
      let batchBytes = 0
      while (
        queue.length > 0
        && items.length < 100
        && (items.length === 0 || batchBytes + queue[0].bytes <= 1024 * 1024)
      ) {
        const item = queue.shift()
        if (!item) break
        items.push(item)
        batchBytes += item.bytes
      }
      if (items.length === 0 && gaps.size === 0) {
        failed = false
        return
      }
      // The database filters individual events against a concurrent reset
      // before aggregating events in the same minute.
      const records = items.map((item) => item.record)
      records.push(...gaps.values())
      gaps.clear()
      active = { id: randomUUID(), items, records, createdAt: clock.now() }
    }
    try {
      const batch = active
      await withStorageDeadline(
        Math.min(Date.now() + 5000, flushDeadline),
        () => repository.applyBatch(batch.id, batch.records),
      )
      for (const item of active.items) pendingBytes -= item.bytes
      active = undefined
      lastSuccessfulFlush = clock.now()
      failed = false
    } catch {
      markFailed()
      reportTelemetryFailure()
    }
  }
  const timer =
    options.autoFlush === false ?
      undefined
    : setInterval(() => {
        if (!closed) void writer.flush()
      }, 1000)
  timer?.unref()
  const writer: TelemetryWriter = {
    enqueue(record) {
      if (closed || !isHistoryRecordKind(record.kind)) return false
      try {
        const serialized = JSON.stringify({
          ...record,
          generation: resetState?.revision ?? record.generation,
        })
        const bytes = Buffer.byteLength(serialized)
        const item: Queued = {
          record: JSON.parse(serialized) as HistoryRecord,
          bytes,
          enqueuedAt: clock.now(),
        }
        if (bytes > MAX_BYTES) {
          droppedRecords++
          loss(item)
          return false
        }
        while (count() >= MAX_RECORDS || pendingBytes + bytes > MAX_BYTES) {
          const oldest = queue.shift()
          if (!oldest) {
            droppedRecords++
            loss(item)
            return false
          }
          drop(oldest)
        }
        queue.push(item)
        pendingBytes += bytes
        if (options.autoFlush !== false && queue.length >= 100)
          void writer.flush()
        return true
      } catch {
        markFailed()
        reportTelemetryFailure()
        return false
      }
    },
    flush() {
      flushing ??= serialize(async () => {
        for (let batch = 0; batch < 20; batch++) {
          await flushOnce()
          if (failed || (!count() && gaps.size === 0)) break
          await yieldToEventLoop()
        }
      }).finally(() => {
        flushing = undefined
      })
      return flushing
    },
    reset(context) {
      return serialize(async () => {
        if (closed) throw new StorageUnavailableError()
        const state = await repository.reset(context)
        applyReset(state)
        return state
      })
    },
    status: snapshot,
    read(work) {
      return serialize(async () => {
        await syncReset()
        return work([
          ...(active?.items.map((item) => ({
            record: structuredClone(item.record),
            batchId: active?.id,
          })) ?? []),
          ...queue.map((item) => ({ record: structuredClone(item.record) })),
          ...(active?.records
            .filter((record) => record.kind === "collection-gap")
            .flatMap((record) => {
              const retained = normalizeHistoryRecordAfterReset(
                record,
                resetState,
              )
              return retained ?
                  [{ record: structuredClone(retained), batchId: active?.id }]
                : []
            }) ?? []),
          ...[...gaps.values()].map((record) => ({
            record: structuredClone(record),
          })),
        ])
      })
    },
    close(deadlineMs) {
      if (closing) return closing
      closed = true
      flushDeadline = Date.now() + Math.max(0, deadlineMs)
      if (timer) clearInterval(timer)
      closing = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          serialize(async () => {
            do {
              await flushOnce()
              if (failed) break
              if ((count() || gaps.size > 0) && Date.now() < flushDeadline)
                await yieldToEventLoop()
            } while ((count() || gaps.size > 0) && Date.now() < flushDeadline)
          }),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, Math.max(0, deadlineMs))
          }),
        ])
        if (deadline) clearTimeout(deadline)
        if (count() || gaps.size > 0 || active) {
          markFailed()
          reportTelemetryFailure()
        }
        return snapshot()
      })()
      return closing
    },
  }
  return writer
}

let current: HistoryRuntime | undefined

export async function createHistoryRuntime(
  storage: Storage,
  options: { now?: () => number; autoFlush?: boolean } = {},
): Promise<HistoryRuntime> {
  const now = options.now ?? Date.now,
    runId = randomUUID()
  const repository = createHistoryRepository(storage, { runId, now })
  await repository.startRun(runId, now())
  let lastHeartbeat = now()
  const writer = createTelemetryWriter(
    repository,
    { now },
    {
      autoFlush: options.autoFlush,
      async beforeFlush() {
        if (now() - lastHeartbeat < 30_000) return
        await repository.heartbeatRun(runId, now())
        // eslint-disable-next-line require-atomic-updates -- Only the writer's serialized flush owner invokes this callback.
        lastHeartbeat = now()
      },
    },
  )
  let closing: Promise<TelemetryStatus> | undefined
  const runtime: HistoryRuntime = {
    storage,
    repository,
    writer,
    close(deadlineMs) {
      closing ??= (async () => {
        const started = Date.now()
        const status = await writer.close(deadlineMs)
        if (!status.pendingRecords && !status.degraded) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            withStorageDeadline(started + deadlineMs, () =>
              repository.endRun(runId, now()),
            ).catch(() => {
              status.degraded = true
            }),
            new Promise<void>((resolve) => {
              timer = setTimeout(
                () => {
                  status.degraded = true
                  resolve()
                },
                Math.max(0, deadlineMs - (Date.now() - started)),
              )
            }),
          ])
          if (timer) clearTimeout(timer)
        }
        if (current === runtime) current = undefined
        return status
      })()
      return closing
    },
  }
  current = runtime
  return runtime
}
export function peekHistoryRuntime(): HistoryRuntime | undefined {
  return current
}
export function getHistoryRuntime(): HistoryRuntime {
  if (!current) throw new StorageUnavailableError()
  return current
}
export function getTelemetryWriter(): TelemetryWriter | undefined {
  return current?.writer
}
