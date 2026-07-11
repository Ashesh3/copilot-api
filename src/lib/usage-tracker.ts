import { randomUUID } from "node:crypto"
import fs from "node:fs"

import { PATHS } from "~/lib/paths"

const STORAGE_VERSION = 2
const MINUTE_MS = 60_000
const RETENTION_MS = 7 * 24 * 60 * MINUTE_MS
const WRITE_DELAY_MS = 250
const MAX_MODEL_LENGTH = 128

interface LegacyUsageRecord {
  timestamp: number
  inputTokens: number
  outputTokens: number
  model?: string
}

export interface UsageBucket {
  timestamp: number
  inputTokens: number
  outputTokens: number
  requestCount: number
  model?: string
}

interface LifetimeUsage {
  inputTokens: number
  outputTokens: number
  requestCount: number
  firstRequestAt: number | null
}

export interface UsageData {
  version: typeof STORAGE_VERSION
  buckets: Array<UsageBucket>
  lifetime: LifetimeUsage
}

const EMPTY_LIFETIME: LifetimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0,
  firstRequestAt: null,
}

let cached: UsageData | null = null
let dirty = false
let writeInProgress = false
let writeTimer: ReturnType<typeof setTimeout> | undefined

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      Math.floor(value)
    : null
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const model = value.trim()
  return model && model.length <= MAX_MODEL_LENGTH ? model : undefined
}

function normalizeTimestamp(value: unknown, now = Date.now()): number | null {
  const timestamp = finiteNonnegative(value)
  return timestamp !== null && timestamp <= now + MINUTE_MS ? timestamp : null
}

function emptyUsageData(): UsageData {
  return {
    version: STORAGE_VERSION,
    buckets: [],
    lifetime: { ...EMPTY_LIFETIME },
  }
}

function minuteFor(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS
}

function bucketKey(timestamp: number, model?: string): string {
  return `${timestamp}\0${model ?? ""}`
}

function aggregateRecords(
  records: Array<LegacyUsageRecord>,
  cutoff: number,
): Array<UsageBucket> {
  const buckets = new Map<string, UsageBucket>()
  for (const record of records) {
    if (record.timestamp < cutoff) continue
    const timestamp = minuteFor(record.timestamp)
    const key = bucketKey(timestamp, record.model)
    const existing = buckets.get(key)
    if (existing) {
      existing.inputTokens += record.inputTokens
      existing.outputTokens += record.outputTokens
      existing.requestCount += 1
    } else {
      buckets.set(key, {
        timestamp,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        requestCount: 1,
        ...(record.model ? { model: record.model } : {}),
      })
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function parseLegacyRecords(
  raw: unknown,
  now: number,
): Array<LegacyUsageRecord> {
  if (
    typeof raw !== "object"
    || raw === null
    || !("records" in raw)
    || !Array.isArray(raw.records)
  ) {
    return []
  }

  const records: Array<LegacyUsageRecord> = []
  for (const item of raw.records) {
    if (typeof item !== "object" || item === null) continue
    const value = item as Record<string, unknown>
    const timestamp = normalizeTimestamp(value.timestamp, now)
    const inputTokens = finiteNonnegative(value.inputTokens)
    const outputTokens = finiteNonnegative(value.outputTokens)
    if (timestamp === null || inputTokens === null || outputTokens === null) {
      continue
    }
    records.push({
      timestamp,
      inputTokens,
      outputTokens,
      ...(normalizeModel(value.model) ?
        { model: normalizeModel(value.model) }
      : {}),
    })
  }
  return records.sort((a, b) => a.timestamp - b.timestamp)
}

function normalizeBuckets(
  raw: unknown,
  cutoff: number,
  now: number,
): Array<UsageBucket> {
  if (!Array.isArray(raw)) return []
  const buckets = new Map<string, UsageBucket>()
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const value = item as Record<string, unknown>
    const timestampRaw = normalizeTimestamp(value.timestamp, now)
    const inputTokens = finiteNonnegative(value.inputTokens)
    const outputTokens = finiteNonnegative(value.outputTokens)
    const requestCount = finiteNonnegative(value.requestCount)
    if (
      timestampRaw === null
      || timestampRaw < cutoff
      || inputTokens === null
      || outputTokens === null
      || requestCount === null
      || requestCount === 0
    ) {
      continue
    }
    const timestamp = minuteFor(timestampRaw)
    const model = normalizeModel(value.model)
    const key = bucketKey(timestamp, model)
    const existing = buckets.get(key)
    if (existing) {
      existing.inputTokens += inputTokens
      existing.outputTokens += outputTokens
      existing.requestCount += requestCount
    } else {
      buckets.set(key, {
        timestamp,
        inputTokens,
        outputTokens,
        requestCount,
        ...(model ? { model } : {}),
      })
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function normalizeLifetime(raw: unknown, now: number): LifetimeUsage {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_LIFETIME }
  const value = raw as Record<string, unknown>
  const inputTokens = finiteNonnegative(value.inputTokens)
  const outputTokens = finiteNonnegative(value.outputTokens)
  const requestCount = finiteNonnegative(value.requestCount)
  const firstRequestAt =
    value.firstRequestAt === null ?
      null
    : normalizeTimestamp(value.firstRequestAt, now)
  if (
    inputTokens === null
    || outputTokens === null
    || requestCount === null
    || (value.firstRequestAt !== null && firstRequestAt === null)
  ) {
    return { ...EMPTY_LIFETIME }
  }
  return { inputTokens, outputTokens, requestCount, firstRequestAt }
}

/** Parse v2 storage or migrate the old unbounded record list. */
export function parseUsageData(raw: unknown, now = Date.now()): UsageData {
  const cutoff = minuteFor(now - RETENTION_MS)
  if (
    typeof raw === "object"
    && raw !== null
    && "version" in raw
    && raw.version === STORAGE_VERSION
  ) {
    const value = raw as Record<string, unknown>
    return {
      version: STORAGE_VERSION,
      buckets: normalizeBuckets(value.buckets, cutoff, now),
      lifetime: normalizeLifetime(value.lifetime, now),
    }
  }

  const records = parseLegacyRecords(raw, now)
  if (records.length === 0) return emptyUsageData()
  return {
    version: STORAGE_VERSION,
    buckets: aggregateRecords(records, cutoff),
    lifetime: {
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce(
        (sum, record) => sum + record.outputTokens,
        0,
      ),
      requestCount: records.length,
      firstRequestAt: records[0]?.timestamp ?? null,
    },
  }
}

function readFromDisk(): UsageData {
  try {
    const raw = fs.readFileSync(PATHS.USAGE_PATH, "utf8")
    if (!raw.trim()) return emptyUsageData()
    const parsed = JSON.parse(raw) as unknown
    const migrated = parseUsageData(parsed)
    if (
      typeof parsed !== "object"
      || parsed === null
      || !("version" in parsed)
      || parsed.version !== STORAGE_VERSION
    ) {
      dirty = true
    }
    return migrated
  } catch {
    return emptyUsageData()
  }
}

function writeToDisk(data: UsageData): void {
  const temporaryPath = `${PATHS.USAGE_PATH}.${process.pid}.${randomUUID()}.tmp`
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(PATHS.APP_DIR, 0o700)
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, PATHS.USAGE_PATH)
    fs.chmodSync(PATHS.USAGE_PATH, 0o600)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

function getData(): UsageData {
  if (!cached) {
    cached = readFromDisk()
    if (dirty) scheduleWrite()
  }
  return cached
}

function scheduleWrite(): void {
  dirty = true
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    try {
      flushUsage()
    } catch (error) {
      console.error("Failed to persist usage telemetry", error)
    }
  }, WRITE_DELAY_MS)
  writeTimer.unref()
}

export function flushUsage(): void {
  if (!dirty || !cached || writeInProgress) return
  writeInProgress = true
  const dataToWrite = cached
  dirty = false
  try {
    writeToDisk(dataToWrite)
  } catch (error) {
    dirty = true
    throw error
  } finally {
    writeInProgress = false
  }
}

function prune(data: UsageData, now: number): void {
  const cutoff = minuteFor(now - RETENTION_MS)
  const retained = data.buckets.filter((bucket) => bucket.timestamp >= cutoff)
  if (retained.length !== data.buckets.length) {
    data.buckets = retained
    scheduleWrite()
  }
}

export function recordUsage(
  inputTokens: number,
  outputTokens: number,
  model?: string,
): void {
  const input = finiteNonnegative(inputTokens)
  const output = finiteNonnegative(outputTokens)
  if (input === null || output === null) return

  const now = Date.now()
  const data = getData()
  prune(data, now)
  const timestamp = minuteFor(now)
  const normalizedModel = normalizeModel(model)
  const existing = data.buckets.find(
    (bucket) =>
      bucket.timestamp === timestamp && bucket.model === normalizedModel,
  )
  if (existing) {
    existing.inputTokens += input
    existing.outputTokens += output
    existing.requestCount += 1
  } else {
    data.buckets.push({
      timestamp,
      inputTokens: input,
      outputTokens: output,
      requestCount: 1,
      ...(normalizedModel ? { model: normalizedModel } : {}),
    })
  }

  data.lifetime.inputTokens += input
  data.lifetime.outputTokens += output
  data.lifetime.requestCount += 1
  data.lifetime.firstRequestAt ??= now
  scheduleWrite()
}

function sumBuckets(buckets: Array<UsageBucket>): {
  tokens: number
  requests: number
} {
  return buckets.reduce(
    (sum, bucket) => ({
      tokens: sum.tokens + bucket.inputTokens + bucket.outputTokens,
      requests: sum.requests + bucket.requestCount,
    }),
    { tokens: 0, requests: 0 },
  )
}

export function getUsageResponse(): Record<string, unknown> {
  const data = getData()
  const now = Date.now()
  prune(data, now)

  const fiveHoursAgo = minuteFor(now - 5 * 60 * MINUTE_MS)
  const sevenDaysAgo = minuteFor(now - RETENTION_MS)
  const fiveHour = sumBuckets(
    data.buckets.filter((bucket) => bucket.timestamp >= fiveHoursAgo),
  )
  const sevenDay = sumBuckets(
    data.buckets.filter((bucket) => bucket.timestamp >= sevenDaysAgo),
  )
  const lifetimeTokens = data.lifetime.inputTokens + data.lifetime.outputTokens

  return {
    five_hour: {
      utilization: Math.min(fiveHour.tokens / 10_000_000, 0.99),
      resets_at: Math.floor((now + 5 * 60 * MINUTE_MS) / 1000),
      tokens_used: fiveHour.tokens,
      request_count: fiveHour.requests,
    },
    seven_day: {
      utilization: Math.min(sevenDay.tokens / 50_000_000, 0.99),
      resets_at: Math.floor((now + RETENTION_MS) / 1000),
      tokens_used: sevenDay.tokens,
      request_count: sevenDay.requests,
    },
    lifetime: {
      total_input_tokens: data.lifetime.inputTokens,
      total_output_tokens: data.lifetime.outputTokens,
      total_tokens: lifetimeTokens,
      total_requests: data.lifetime.requestCount,
      first_request_at:
        data.lifetime.firstRequestAt === null ?
          null
        : Math.floor(data.lifetime.firstRequestAt / 1000),
    },
  }
}

export function resetUsageForTest(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = undefined
  cached = null
  dirty = false
  writeInProgress = false
}

process.once("beforeExit", flushUsage)
