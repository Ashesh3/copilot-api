import fs from "node:fs"

import { PATHS } from "~/lib/paths"

interface UsageRecord {
  timestamp: number
  inputTokens: number
  outputTokens: number
  model?: string
}

interface UsageData {
  records: Array<UsageRecord>
}

function sumTokens(recs: Array<UsageRecord>): number {
  return recs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0)
}

let cached: UsageData | null = null

function readFromDisk(): UsageData {
  try {
    const raw = fs.readFileSync(PATHS.USAGE_PATH, "utf8")
    if (!raw.trim()) return { records: [] }
    return JSON.parse(raw) as UsageData
  } catch {
    return { records: [] }
  }
}

function writeToDisk(data: UsageData): void {
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  fs.writeFileSync(PATHS.USAGE_PATH, `${JSON.stringify(data)}\n`, "utf8")
}

function getData(): UsageData {
  cached ??= readFromDisk()
  return cached
}

/**
 * Record a request's token usage.
 */
export function recordUsage(
  inputTokens: number,
  outputTokens: number,
  model?: string,
): void {
  const data = getData()
  data.records.push({
    timestamp: Date.now(),
    inputTokens,
    outputTokens,
    model,
  })
  cached = data
  writeToDisk(data)
}

/**
 * Build the usage response in the format Claude Code expects.
 */
export function getUsageResponse(): Record<string, unknown> {
  const data = getData()
  const now = Date.now()

  const fiveHoursAgo = now - 5 * 60 * 60 * 1000
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000

  const fiveHourRecords = data.records.filter(
    (r) => r.timestamp >= fiveHoursAgo,
  )
  const sevenDayRecords = data.records.filter(
    (r) => r.timestamp >= sevenDaysAgo,
  )

  const fiveHourTokens = sumTokens(fiveHourRecords)
  const sevenDayTokens = sumTokens(sevenDayRecords)
  const lifetimeTokens = sumTokens(data.records)

  // Resets timestamps (epoch seconds)
  const fiveHourResets = Math.floor((now + 5 * 60 * 60 * 1000) / 1000)
  const sevenDayResets = Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000)

  // Synthetic caps for the progress bar display
  const sessionCap = 10_000_000
  const weeklyCap = 50_000_000

  const lifetimeInput = data.records.reduce((s, r) => s + r.inputTokens, 0)
  const lifetimeOutput = data.records.reduce((s, r) => s + r.outputTokens, 0)

  return {
    five_hour: {
      utilization: Math.min(fiveHourTokens / sessionCap, 0.99),
      resets_at: fiveHourResets,
      tokens_used: fiveHourTokens,
      request_count: fiveHourRecords.length,
    },
    seven_day: {
      utilization: Math.min(sevenDayTokens / weeklyCap, 0.99),
      resets_at: sevenDayResets,
      tokens_used: sevenDayTokens,
      request_count: sevenDayRecords.length,
    },
    lifetime: {
      total_input_tokens: lifetimeInput,
      total_output_tokens: lifetimeOutput,
      total_tokens: lifetimeTokens,
      total_requests: data.records.length,
      first_request_at:
        data.records.length > 0 ?
          Math.floor(data.records[0].timestamp / 1000)
        : null,
    },
  }
}
