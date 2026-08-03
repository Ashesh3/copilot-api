const MINUTE_MS = 60_000
const RETENTION_MINUTES = 24 * 60
const MAX_MODEL_DIMENSIONS = 200
const MAX_ROUTE_DIMENSIONS = 100
const MAX_DIMENSION_LENGTH = 160
const OTHER_DIMENSION = "Other"
const UNKNOWN_DIMENSION = "Unknown"

export type RoutingWindow = "15m" | "1h" | "6h" | "24h"
export type UpstreamOutcome =
  | "success"
  | "client_error"
  | "server_error"
  | "transport_error"
  | "aborted"
export type UpstreamSendReason =
  | "initial"
  | "http_retry"
  | "transport_retry"
  | "token_refresh"
  | "failover"
export type RoutingSelectionMode = "sticky" | "default" | "single"
export type RoutingBalanceStatus =
  | "not_applicable"
  | "insufficient_data"
  | "within_range"
  | "skewed"

export interface RoutingRequestEvent {
  model: string
  provider: string
  route: string
  status: number
  timestamp?: number
}

export interface UpstreamCallEvent {
  accountId?: number
  model: string
  outcome: UpstreamOutcome
  provider: string
  reason: UpstreamSendReason
  route: string
  timestamp?: number
}

export interface RoutingSelectionEvent {
  accountId: number
  eligibleAccountIds: ReadonlyArray<number>
  mode: RoutingSelectionMode
  model: string
  timestamp?: number
}

export interface RoutingAccountMetadata {
  id: number
  accountType: string
  githubUsername?: string
  healthy: boolean
}

export interface RoutingTotals {
  requests: number
  upstreamCalls: number
  retries: number
  failovers: number
}

export interface RoutingTimeSeriesPoint extends RoutingTotals {
  timestamp: number
  extraCalls: number
}

export interface RoutingModelAccountUsage {
  accountId: number
  share: number
  upstreamCalls: number
}

export interface RoutingOutcomeCounts {
  success: number
  clientError: number
  serverError: number
  transportError: number
  aborted: number
}

export interface RoutingModelUsage extends RoutingTotals {
  id: string
  model: string
  provider: string
  share: number
  amplification: number
  successRate: number
  outcomes: RoutingOutcomeCounts
  accounts: Array<RoutingModelAccountUsage>
}

export interface RoutingAccountUsage {
  accountId: number | null
  label: string
  accountType?: string
  githubUsername?: string
  healthy: boolean
  selected: number
  selectionShare: number
  expectedSelections: number
  expectedShare: number
  selectionDelta: number
  upstreamCalls: number
  callShare: number
  balanceStatus: RoutingBalanceStatus
}

export interface RoutingRouteUsage {
  route: string
  requests: number
  upstreamCalls: number
  share: number
}

export interface RoutingSelectionModes {
  sticky: number
  default: number
  single: number
}

export interface RoutingTelemetrySnapshot {
  window: RoutingWindow
  windowMinutes: number
  retentionMinutes: number
  generatedAt: number
  telemetryStartedAt: number
  multiToken: boolean
  totals: RoutingTotals
  lifetime: RoutingTotals
  timeSeries: Array<RoutingTimeSeriesPoint>
  models: Array<RoutingModelUsage>
  accounts: Array<RoutingAccountUsage>
  routes: Array<RoutingRouteUsage>
  selectionModes: RoutingSelectionModes
}

export interface RoutingSnapshotOptions {
  accounts: ReadonlyArray<RoutingAccountMetadata>
  multiToken: boolean
  now?: number
  window: RoutingWindow
}

interface ModelCounters extends RoutingTotals {
  model: string
  provider: string
  outcomes: RoutingOutcomeCounts
  accountCalls: Map<number, number>
}

interface RouteCounters {
  requests: number
  upstreamCalls: number
}

interface AccountCounters {
  selected: number
  expectedSelections: number
  upstreamCalls: number
}

interface MinuteBucket {
  timestamp: number
  totals: RoutingTotals
  models: Map<string, ModelCounters>
  routes: Map<string, RouteCounters>
  accounts: Map<number, AccountCounters>
  defaultUpstreamCalls: number
  selectionModes: RoutingSelectionModes
}

const WINDOW_CONFIG: Record<
  RoutingWindow,
  { intervalMinutes: number; minutes: number }
> = {
  "15m": { intervalMinutes: 1, minutes: 15 },
  "1h": { intervalMinutes: 5, minutes: 60 },
  "6h": { intervalMinutes: 30, minutes: 360 },
  "24h": { intervalMinutes: 120, minutes: 1440 },
}

const VALID_OUTCOMES = new Set<UpstreamOutcome>([
  "success",
  "client_error",
  "server_error",
  "transport_error",
  "aborted",
])
const VALID_REASONS = new Set<UpstreamSendReason>([
  "initial",
  "http_retry",
  "transport_retry",
  "token_refresh",
  "failover",
])
const VALID_SELECTION_MODES = new Set<RoutingSelectionMode>([
  "sticky",
  "default",
  "single",
])
const RETRY_REASONS = new Set<UpstreamSendReason>([
  "http_retry",
  "transport_retry",
  "token_refresh",
])

let buckets = new Map<number, MinuteBucket>()
let lifetime = emptyTotals()
let telemetryStartedAt = Date.now()
let latestTimestamp = telemetryStartedAt
let modelDimensions = new Set<string>()
let routeDimensions = new Set<string>()

function emptyTotals(): RoutingTotals {
  return { requests: 0, upstreamCalls: 0, retries: 0, failovers: 0 }
}

function emptySelectionModes(): RoutingSelectionModes {
  return { sticky: 0, default: 0, single: 0 }
}

function emptyOutcomes(): RoutingOutcomeCounts {
  return {
    success: 0,
    clientError: 0,
    serverError: 0,
    transportError: 0,
    aborted: 0,
  }
}

function minuteFor(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS
}

function validTimestamp(timestamp: unknown): timestamp is number {
  return (
    typeof timestamp === "number"
    && Number.isFinite(timestamp)
    && timestamp >= 0
  )
}

function eventTimestamp(timestamp: number | undefined): number | undefined {
  const value = timestamp ?? Date.now()
  return validTimestamp(value) ? value : undefined
}

function normalizeDimension(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_DIMENSION
  const normalized = value.trim().replaceAll("\0", "")
  if (!normalized) return UNKNOWN_DIMENSION
  return normalized.slice(0, MAX_DIMENSION_LENGTH)
}

function boundedModelDimensions(
  model: string,
  provider: string,
): {
  key: string
  model: string
  provider: string
} {
  const normalizedModel = normalizeDimension(model)
  const normalizedProvider = normalizeDimension(provider)
  const key = `${normalizedProvider}\0${normalizedModel}`
  if (modelDimensions.has(key) || modelDimensions.size < MAX_MODEL_DIMENSIONS) {
    modelDimensions.add(key)
    return { key, model: normalizedModel, provider: normalizedProvider }
  }
  return {
    key: `${OTHER_DIMENSION}\0${OTHER_DIMENSION}`,
    model: OTHER_DIMENSION,
    provider: OTHER_DIMENSION,
  }
}

function boundedRoute(route: string): string {
  const normalized = normalizeDimension(route)
  if (
    routeDimensions.has(normalized)
    || routeDimensions.size < MAX_ROUTE_DIMENSIONS
  ) {
    routeDimensions.add(normalized)
    return normalized
  }
  return OTHER_DIMENSION
}

function createBucket(timestamp: number): MinuteBucket {
  return {
    timestamp,
    totals: emptyTotals(),
    models: new Map(),
    routes: new Map(),
    accounts: new Map(),
    defaultUpstreamCalls: 0,
    selectionModes: emptySelectionModes(),
  }
}

function getBucket(timestamp: number): MinuteBucket {
  const minute = minuteFor(timestamp)
  let bucket = buckets.get(minute)
  if (!bucket) {
    bucket = createBucket(minute)
    buckets.set(minute, bucket)
  }
  latestTimestamp = Math.max(latestTimestamp, timestamp)
  pruneBuckets(latestTimestamp)
  return bucket
}

function pruneBuckets(now: number): void {
  const cutoff = minuteFor(now - RETENTION_MINUTES * MINUTE_MS)
  for (const timestamp of buckets.keys()) {
    if (timestamp < cutoff) buckets.delete(timestamp)
  }
}

function getModelCounters(
  bucket: MinuteBucket,
  model: string,
  provider: string,
): ModelCounters {
  const dimensions = boundedModelDimensions(model, provider)
  let counters = bucket.models.get(dimensions.key)
  if (!counters) {
    counters = {
      ...emptyTotals(),
      model: dimensions.model,
      provider: dimensions.provider,
      outcomes: emptyOutcomes(),
      accountCalls: new Map(),
    }
    bucket.models.set(dimensions.key, counters)
  }
  return counters
}

function getRouteCounters(bucket: MinuteBucket, route: string): RouteCounters {
  const normalized = boundedRoute(route)
  let counters = bucket.routes.get(normalized)
  if (!counters) {
    counters = { requests: 0, upstreamCalls: 0 }
    bucket.routes.set(normalized, counters)
  }
  return counters
}

function getAccountCounters(
  bucket: MinuteBucket,
  accountId: number,
): AccountCounters {
  let counters = bucket.accounts.get(accountId)
  if (!counters) {
    counters = { expectedSelections: 0, selected: 0, upstreamCalls: 0 }
    bucket.accounts.set(accountId, counters)
  }
  return counters
}

function validAccountId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function incrementOutcome(
  outcomes: RoutingOutcomeCounts,
  outcome: UpstreamOutcome,
): void {
  switch (outcome) {
    case "success": {
      outcomes.success++
      break
    }
    case "client_error": {
      outcomes.clientError++
      break
    }
    case "server_error": {
      outcomes.serverError++
      break
    }
    case "transport_error": {
      outcomes.transportError++
      break
    }
    case "aborted": {
      outcomes.aborted++
      break
    }
    default: {
      break
    }
  }
}

export function recordRoutingRequest(event: RoutingRequestEvent): void {
  try {
    const timestamp = eventTimestamp(event.timestamp)
    if (timestamp === undefined) return
    if (
      !Number.isInteger(event.status)
      || event.status < 100
      || event.status > 599
    ) {
      return
    }
    const bucket = getBucket(timestamp)
    bucket.totals.requests++
    lifetime.requests++
    getModelCounters(bucket, event.model, event.provider).requests++
    getRouteCounters(bucket, event.route).requests++
  } catch {
    // Telemetry must never affect request handling.
  }
}

export function recordUpstreamCall(event: UpstreamCallEvent): void {
  try {
    const timestamp = eventTimestamp(event.timestamp)
    if (
      timestamp === undefined
      || !VALID_OUTCOMES.has(event.outcome)
      || !VALID_REASONS.has(event.reason)
    ) {
      return
    }
    const bucket = getBucket(timestamp)
    const model = getModelCounters(bucket, event.model, event.provider)
    const route = getRouteCounters(bucket, event.route)

    bucket.totals.upstreamCalls++
    lifetime.upstreamCalls++
    model.upstreamCalls++
    route.upstreamCalls++
    incrementOutcome(model.outcomes, event.outcome)

    if (RETRY_REASONS.has(event.reason)) {
      bucket.totals.retries++
      lifetime.retries++
      model.retries++
    } else if (event.reason === "failover") {
      bucket.totals.failovers++
      lifetime.failovers++
      model.failovers++
    }

    if (event.accountId !== undefined && validAccountId(event.accountId)) {
      getAccountCounters(bucket, event.accountId).upstreamCalls++
      model.accountCalls.set(
        event.accountId,
        (model.accountCalls.get(event.accountId) ?? 0) + 1,
      )
    } else if (normalizeDimension(event.provider) === "GitHub Copilot") {
      bucket.defaultUpstreamCalls++
    }
  } catch {
    // Telemetry must never affect provider calls.
  }
}

export function recordRoutingSelection(event: RoutingSelectionEvent): void {
  try {
    const timestamp = eventTimestamp(event.timestamp)
    if (
      timestamp === undefined
      || !validAccountId(event.accountId)
      || !VALID_SELECTION_MODES.has(event.mode)
    ) {
      return
    }
    const eligible = [
      ...new Set(
        event.eligibleAccountIds.filter((accountId) =>
          validAccountId(accountId),
        ),
      ),
    ].slice(0, 64)
    if (!eligible.includes(event.accountId)) eligible.push(event.accountId)
    if (eligible.length === 0) return

    const bucket = getBucket(timestamp)
    getAccountCounters(bucket, event.accountId).selected++
    const credit = 1 / eligible.length
    for (const accountId of eligible) {
      getAccountCounters(bucket, accountId).expectedSelections += credit
    }
    bucket.selectionModes[event.mode]++
  } catch {
    // Telemetry must never affect account selection.
  }
}

function addTotals(target: RoutingTotals, source: RoutingTotals): void {
  target.requests += source.requests
  target.upstreamCalls += source.upstreamCalls
  target.retries += source.retries
  target.failovers += source.failovers
}

function addOutcomes(
  target: RoutingOutcomeCounts,
  source: RoutingOutcomeCounts,
): void {
  target.success += source.success
  target.clientError += source.clientError
  target.serverError += source.serverError
  target.transportError += source.transportError
  target.aborted += source.aborted
}

function aggregateModel(
  target: Map<string, ModelCounters>,
  key: string,
  source: ModelCounters,
): void {
  let counters = target.get(key)
  if (!counters) {
    counters = {
      ...emptyTotals(),
      model: source.model,
      provider: source.provider,
      outcomes: emptyOutcomes(),
      accountCalls: new Map(),
    }
    target.set(key, counters)
  }
  addTotals(counters, source)
  addOutcomes(counters.outcomes, source.outcomes)
  for (const [accountId, calls] of source.accountCalls) {
    counters.accountCalls.set(
      accountId,
      (counters.accountCalls.get(accountId) ?? 0) + calls,
    )
  }
}

function aggregateBuckets(source: ReadonlyArray<MinuteBucket>): MinuteBucket {
  const aggregate = createBucket(0)
  for (const bucket of source) {
    addTotals(aggregate.totals, bucket.totals)
    aggregate.defaultUpstreamCalls += bucket.defaultUpstreamCalls
    for (const [key, model] of bucket.models) {
      aggregateModel(aggregate.models, key, model)
    }
    for (const [route, counters] of bucket.routes) {
      const target = getRouteCounters(aggregate, route)
      target.requests += counters.requests
      target.upstreamCalls += counters.upstreamCalls
    }
    for (const [accountId, counters] of bucket.accounts) {
      const target = getAccountCounters(aggregate, accountId)
      target.selected += counters.selected
      target.expectedSelections += counters.expectedSelections
      target.upstreamCalls += counters.upstreamCalls
    }
    aggregate.selectionModes.sticky += bucket.selectionModes.sticky
    aggregate.selectionModes.default += bucket.selectionModes.default
    aggregate.selectionModes.single += bucket.selectionModes.single
  }
  return aggregate
}

function snapshotModels(aggregate: MinuteBucket): Array<RoutingModelUsage> {
  return [...aggregate.models.entries()]
    .map(([id, counters]) => ({
      ...counters,
      id,
      share:
        aggregate.totals.upstreamCalls > 0 ?
          counters.upstreamCalls / aggregate.totals.upstreamCalls
        : 0,
      amplification:
        counters.requests > 0 ?
          counters.upstreamCalls / counters.requests
        : counters.upstreamCalls,
      successRate:
        counters.upstreamCalls > 0 ?
          counters.outcomes.success / counters.upstreamCalls
        : 0,
      outcomes: { ...counters.outcomes },
      accounts: [...counters.accountCalls.entries()]
        .map(([accountId, upstreamCalls]) => ({
          accountId,
          upstreamCalls,
          share:
            counters.upstreamCalls > 0 ?
              upstreamCalls / counters.upstreamCalls
            : 0,
        }))
        .sort((left, right) => left.accountId - right.accountId),
      accountCalls: undefined,
    }))
    .map(({ accountCalls: _accountCalls, ...model }) => model)
    .sort(
      (left, right) =>
        right.upstreamCalls - left.upstreamCalls
        || left.provider.localeCompare(right.provider)
        || left.model.localeCompare(right.model),
    )
}

function balanceStatus(
  multiToken: boolean,
  selections: number,
  delta: number,
): RoutingBalanceStatus {
  if (!multiToken) return "not_applicable"
  if (selections < 30) return "insufficient_data"
  return Math.abs(delta) >= 0.1 ? "skewed" : "within_range"
}

function snapshotAccounts(
  aggregate: MinuteBucket,
  configured: ReadonlyArray<RoutingAccountMetadata>,
  multiToken: boolean,
): Array<RoutingAccountUsage> {
  if (!multiToken) {
    return [
      {
        accountId: null,
        balanceStatus: "not_applicable",
        callShare: aggregate.defaultUpstreamCalls > 0 ? 1 : 0,
        expectedSelections: 0,
        expectedShare: 0,
        healthy: true,
        label: "Default credential",
        selected: 0,
        selectionDelta: 0,
        selectionShare: 0,
        upstreamCalls: aggregate.defaultUpstreamCalls,
      },
    ]
  }

  const totalSelections = [...aggregate.accounts.values()].reduce(
    (sum, account) => sum + account.selected,
    0,
  )
  const totalExpected = [...aggregate.accounts.values()].reduce(
    (sum, account) => sum + account.expectedSelections,
    0,
  )
  const totalCalls = [...aggregate.accounts.values()].reduce(
    (sum, account) => sum + account.upstreamCalls,
    0,
  )

  return [...configured]
    .sort((left, right) => left.id - right.id)
    .map((account) => {
      const counters = aggregate.accounts.get(account.id) ?? {
        expectedSelections: 0,
        selected: 0,
        upstreamCalls: 0,
      }
      const selectionShare =
        totalSelections > 0 ? counters.selected / totalSelections : 0
      const expectedShare =
        totalExpected > 0 ? counters.expectedSelections / totalExpected : 0
      const selectionDelta = selectionShare - expectedShare
      return {
        accountId: account.id,
        accountType: account.accountType,
        ...(account.githubUsername ?
          { githubUsername: account.githubUsername }
        : {}),
        balanceStatus: balanceStatus(
          multiToken,
          totalSelections,
          selectionDelta,
        ),
        callShare: totalCalls > 0 ? counters.upstreamCalls / totalCalls : 0,
        expectedSelections: counters.expectedSelections,
        expectedShare,
        healthy: account.healthy,
        label: `Account #${account.id}`,
        selected: counters.selected,
        selectionDelta,
        selectionShare,
        upstreamCalls: counters.upstreamCalls,
      }
    })
}

function snapshotRoutes(aggregate: MinuteBucket): Array<RoutingRouteUsage> {
  return [...aggregate.routes.entries()]
    .map(([route, counters]) => ({
      route,
      ...counters,
      share:
        aggregate.totals.upstreamCalls > 0 ?
          counters.upstreamCalls / aggregate.totals.upstreamCalls
        : 0,
    }))
    .sort(
      (left, right) =>
        right.upstreamCalls - left.upstreamCalls
        || left.route.localeCompare(right.route),
    )
}

function snapshotTimeSeries(
  selected: ReadonlyArray<MinuteBucket>,
  now: number,
  window: RoutingWindow,
): Array<RoutingTimeSeriesPoint> {
  const config = WINDOW_CONFIG[window]
  const intervalMs = config.intervalMinutes * MINUTE_MS
  const start = minuteFor(now - config.minutes * MINUTE_MS)
  const end = minuteFor(now)
  const points: Array<RoutingTimeSeriesPoint> = []

  for (let timestamp = start; timestamp <= end; timestamp += intervalMs) {
    const intervalEnd = Math.min(timestamp + intervalMs, end + MINUTE_MS)
    const aggregate = aggregateBuckets(
      selected.filter(
        (bucket) =>
          bucket.timestamp >= timestamp && bucket.timestamp < intervalEnd,
      ),
    )
    points.push({
      timestamp,
      ...aggregate.totals,
      extraCalls: Math.max(
        0,
        aggregate.totals.upstreamCalls - aggregate.totals.requests,
      ),
    })
  }
  return points
}

export function getRoutingTelemetrySnapshot(
  options: RoutingSnapshotOptions,
): RoutingTelemetrySnapshot {
  const now = validTimestamp(options.now) ? options.now : Date.now()
  pruneBuckets(now)
  const config = WINDOW_CONFIG[options.window]
  const cutoff = minuteFor(now - config.minutes * MINUTE_MS)
  const end = minuteFor(now)
  const selected = [...buckets.values()].filter(
    (bucket) => bucket.timestamp >= cutoff && bucket.timestamp <= end,
  )
  const aggregate = aggregateBuckets(selected)

  return {
    accounts: snapshotAccounts(aggregate, options.accounts, options.multiToken),
    generatedAt: now,
    lifetime: { ...lifetime },
    models: snapshotModels(aggregate),
    multiToken: options.multiToken,
    retentionMinutes: RETENTION_MINUTES,
    routes: snapshotRoutes(aggregate),
    selectionModes: { ...aggregate.selectionModes },
    telemetryStartedAt,
    timeSeries: snapshotTimeSeries(selected, now, options.window),
    totals: { ...aggregate.totals },
    window: options.window,
    windowMinutes: config.minutes,
  }
}

export function isRoutingWindow(value: string): value is RoutingWindow {
  return Object.hasOwn(WINDOW_CONFIG, value)
}

export function resetRoutingTelemetryForTest(startedAt = Date.now()): void {
  buckets = new Map()
  lifetime = emptyTotals()
  telemetryStartedAt = startedAt
  latestTimestamp = startedAt
  modelDimensions = new Set()
  routeDimensions = new Set()
}
