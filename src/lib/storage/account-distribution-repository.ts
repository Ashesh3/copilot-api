import { createHash } from "node:crypto"

import type {
  Committed,
  MutationContext,
  SqlSession,
  Storage,
} from "~/lib/storage/types"

import { bindAccountMutation } from "~/lib/storage/account-mutation"
import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import { readStoreRevision, runMutation } from "~/lib/storage/operations"

export interface AccountAllocation {
  accountId: number
  percentage: number
}
export interface AccountDistributionPolicy {
  configured: boolean
  version: number
  allocations: Array<AccountAllocation>
}
export interface EligibleAccountWeight {
  accountId: number
  weight: number
}
export interface AccountAssignmentInput {
  affinityKey: string
  modelId: string
  eligibleAccountIds: ReadonlyArray<number>
  preferredAccountId?: number
  preferredReason?: "issuer" | "pinned"
  legacyAccountId?: number
  expectedRevision?: number
  /** Synchronous runtime-generation guard; no IO or storage calls are permitted. */
  validateCandidates?: () => void
}
export interface AccountAssignment {
  accountId: number
  reason: "new" | "existing" | "legacy" | "issuer" | "pinned"
  eligibleAccountWeights: Array<EligibleAccountWeight>
  allocationVersion: number
}

export class AccountDistributionConflictError extends StorageConflictError {
  readonly ownerAccountId: number
  readonly requestedAccountId: number
  constructor(ownerAccountId: number, requestedAccountId: number) {
    super("Conversation account conflicts with its recorded owner")
    this.name = "AccountDistributionConflictError"
    this.ownerAccountId = ownerAccountId
    this.requestedAccountId = requestedAccountId
  }
}
export class AccountDistributionUnavailableError extends StorageConflictError {
  constructor() {
    super("No eligible account is available for conversation assignment")
    this.name = "AccountDistributionUnavailableError"
  }
}
export class AccountDistributionRevisionError extends StorageConflictError {
  constructor() {
    super("Configuration revision changed before conversation assignment", {
      retryable: true,
    })
    this.name = "AccountDistributionRevisionError"
  }
}

function validAccountId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** The digest compacts identity; account selection never uses its contents. */
function conversationKey(affinityKey: string): Uint8Array {
  if (typeof affinityKey !== "string" || affinityKey.length === 0)
    throw new StorageConflictError("A conversation affinity key is required")
  return createHash("sha256")
    .update(JSON.stringify(["copilot-account-affinity-v1", affinityKey]))
    .digest()
}

function canonicalAllocations(input: unknown): Array<AccountAllocation> {
  const ids = new Set<number>()
  if (!Array.isArray(input))
    throw new StorageConflictError("Invalid account allocations")
  const allocations: Array<AccountAllocation> = []
  for (const value of input as Array<unknown>) {
    if (
      !value
      || typeof value !== "object"
      || !("accountId" in value)
      || !("percentage" in value)
      || !validAccountId(value.accountId)
      || typeof value.percentage !== "number"
      || !Number.isSafeInteger(value.percentage)
      || value.percentage < 0
      || value.percentage > 100
      || ids.has(value.accountId)
    )
      throw new StorageConflictError("Invalid account allocations")
    ids.add(value.accountId)
    allocations.push({
      accountId: value.accountId,
      percentage: value.percentage,
    })
  }
  if (allocations.reduce((sum, row) => sum + row.percentage, 0) !== 100)
    throw new StorageConflictError("Account allocations must total exactly 100")
  return allocations
    .map(({ accountId, percentage }) => ({ accountId, percentage }))
    .sort((left, right) => left.accountId - right.accountId)
}

export async function readAccountDistributionPolicy(
  session: SqlSession,
): Promise<AccountDistributionPolicy> {
  const versions = await session.query({
    sql: "SELECT version FROM capi_account_distribution WHERE id = 1",
    args: [],
  })
  const rows = await session.query({
    sql: "SELECT account_id,percentage FROM capi_account_allocations ORDER BY account_id",
    args: [],
  })
  if (versions.length === 0) {
    if (rows.length > 0)
      throw new StorageSchemaError("Unconfigured allocation policy has weights")
    return { configured: false, version: 0, allocations: [] }
  }
  const version = versions[0].version
  if (!Number.isSafeInteger(version) || Number(version) < 1)
    throw new StorageSchemaError("Invalid account allocation version")
  let allocations: Array<AccountAllocation>
  try {
    allocations = canonicalAllocations(
      rows.map((row) => ({
        accountId: row.account_id as number,
        percentage: row.percentage as number,
      })),
    )
  } catch {
    throw new StorageSchemaError("Invalid stored account allocations")
  }
  return { configured: true, version: Number(version), allocations }
}

async function findOwner(session: SqlSession, key: Uint8Array) {
  const rows = await session.query({
    sql: "SELECT account_id FROM capi_conversation_accounts WHERE conversation_key = ?",
    args: [key],
  })
  if (!rows[0]) return undefined
  if (!validAccountId(rows[0].account_id))
    throw new StorageSchemaError("Invalid conversation owner")
  return rows[0].account_id
}

async function eligibleWeights(
  session: SqlSession,
  policy: AccountDistributionPolicy,
  eligibleIds: ReadonlyArray<number>,
): Promise<{ weights: Array<EligibleAccountWeight>; ids: Set<number> }> {
  const requested = new Set(eligibleIds)
  const active = await session.query({
    sql: "SELECT id FROM capi_accounts WHERE enabled = 1 AND deleted_at IS NULL AND deleting_at IS NULL ORDER BY id",
    args: [],
  })
  const ids = new Set(
    active.map((row) => Number(row.id)).filter((id) => requested.has(id)),
  )
  const weights =
    policy.configured ?
      policy.allocations
        .filter((row) => ids.has(row.accountId) && row.percentage > 0)
        .map((row) => ({ accountId: row.accountId, weight: row.percentage }))
    : [...ids].map((accountId) => ({ accountId, weight: 1 }))
  return { weights, ids }
}

interface SchedulerCredit extends EligibleAccountWeight {
  credit: number
}

// eslint-disable-next-line complexity -- Validate every credit and its aggregate balance at the stored JSON trust boundary.
function decodeCredits(value: unknown): Array<SchedulerCredit> {
  let decoded: unknown
  try {
    decoded = JSON.parse(String(value))
  } catch {
    throw new StorageSchemaError("Invalid stored scheduler credits")
  }
  if (!Array.isArray(decoded) || decoded.length === 0)
    throw new StorageSchemaError("Invalid stored scheduler credits")
  let previous = -1
  let sum = 0
  const credits: Array<SchedulerCredit> = []
  for (const entry of decoded as Array<unknown>) {
    if (
      !entry
      || typeof entry !== "object"
      || !("accountId" in entry)
      || !("weight" in entry)
      || !("credit" in entry)
      || !validAccountId(entry.accountId)
      || entry.accountId <= previous
      || typeof entry.weight !== "number"
      || !Number.isSafeInteger(entry.weight)
      || entry.weight < 1
      || entry.weight > 100
      || typeof entry.credit !== "number"
      || !Number.isSafeInteger(entry.credit)
      || Math.abs(entry.credit) > 100 * decoded.length
    )
      throw new StorageSchemaError("Invalid stored scheduler credits")
    previous = entry.accountId
    sum += entry.credit
    credits.push({
      accountId: entry.accountId,
      weight: entry.weight,
      credit: entry.credit,
    })
  }
  if (sum !== 0)
    throw new StorageSchemaError("Invalid stored scheduler balance")
  return credits
}

// eslint-disable-next-line max-params -- The owned transaction, model scope, applied policy and eligible weights are separate invariants.
async function advanceScheduler(
  session: SqlSession,
  modelId: string,
  policy: AccountDistributionPolicy,
  weights: Array<EligibleAccountWeight>,
): Promise<number> {
  if (weights.length === 0) throw new AccountDistributionUnavailableError()
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        "copilot-account-scheduler-v1",
        modelId,
        policy.version,
        weights,
      ]),
    )
    .digest("hex")
  const rows = await session.query({
    sql: "SELECT version,credits_json FROM capi_account_scheduler WHERE scope = ?",
    args: [scope],
  })
  const credits =
    rows[0] ?
      decodeCredits(rows[0].credits_json)
    : weights.map((row) => ({ ...row, credit: 0 }))
  if (
    rows[0]
    && (rows[0].version !== policy.version
      || JSON.stringify(
        credits.map(({ accountId, weight }) => ({ accountId, weight })),
      ) !== JSON.stringify(weights))
  )
    throw new StorageSchemaError(
      "Scheduler scope does not match current allocation",
    )
  let winner = credits[0]
  let total = 0
  for (const entry of credits) {
    entry.credit += entry.weight
    total += entry.weight
    if (entry.credit > winner.credit) winner = entry
  }
  winner.credit -= total
  await session.execute({
    sql: "INSERT INTO capi_account_scheduler(scope,version,credits_json) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET credits_json=excluded.credits_json",
    args: [scope, policy.version, JSON.stringify(credits)],
  })
  return winner.accountId
}

// eslint-disable-next-line max-params -- The indexed key and previously read owner remain separate from caller input.
async function resolveAssignment(
  session: SqlSession,
  input: AccountAssignmentInput,
  key: Uint8Array,
  existing?: number,
): Promise<AccountAssignment> {
  if (
    existing !== undefined
    && input.preferredAccountId !== undefined
    && existing !== input.preferredAccountId
  )
    throw new AccountDistributionConflictError(
      existing,
      input.preferredAccountId,
    )
  const policy = await readAccountDistributionPolicy(session)
  const eligible = await eligibleWeights(
    session,
    policy,
    input.eligibleAccountIds,
  )
  const metadata = {
    eligibleAccountWeights: eligible.weights,
    allocationVersion: policy.version,
  }
  if (existing !== undefined)
    return { ...metadata, accountId: existing, reason: "existing" }
  if (
    input.expectedRevision !== undefined
    && input.expectedRevision !== (await readStoreRevision(session))
  )
    throw new AccountDistributionRevisionError()
  input.validateCandidates?.()
  const seed =
    input.preferredAccountId
    ?? (policy.configured ? undefined : input.legacyAccountId)
  let accountId: number
  let reason: AccountAssignment["reason"]
  if (seed !== undefined) {
    if (!eligible.ids.has(seed)) throw new AccountDistributionUnavailableError()
    accountId = seed
    reason =
      input.preferredAccountId !== undefined ?
        (input.preferredReason ?? "pinned")
      : "legacy"
  } else {
    if (!policy.configured) throw new AccountDistributionUnavailableError()
    accountId = await advanceScheduler(
      session,
      input.modelId,
      policy,
      eligible.weights,
    )
    reason = "new"
  }
  await session.execute({
    sql: "INSERT INTO capi_conversation_accounts(conversation_key,account_id) VALUES(?,?)",
    args: [key, accountId],
  })
  input.validateCandidates?.()
  return { ...metadata, accountId, reason }
}

/** Called during restore after all records have arrived, including tombstones. */
export async function validateAccountDistributionState(
  session: SqlSession,
): Promise<void> {
  const policy = await readAccountDistributionPolicy(session)
  const rows = await session.query({
    sql: "SELECT scope,version,credits_json FROM capi_account_scheduler",
    args: [],
  })
  const accounts = await session.query({
    sql: "SELECT id FROM capi_accounts",
    args: [],
  })
  const ids = new Set(accounts.map((row) => row.id))
  for (const row of rows) {
    if (
      !policy.configured
      || row.version !== policy.version
      || typeof row.scope !== "string"
      || !/^[a-f\d]{64}$/.test(row.scope)
    )
      throw new StorageSchemaError("Invalid imported account scheduler")
    for (const credit of decodeCredits(row.credits_json))
      if (
        !ids.has(credit.accountId)
        || !policy.allocations.some(
          (allocation) =>
            allocation.accountId === credit.accountId
            && allocation.percentage === credit.weight,
        )
      )
        throw new StorageSchemaError(
          "Imported scheduler references an invalid allocation",
        )
  }
}

// eslint-disable-next-line max-lines-per-function -- Repository operations share the same explicitly owned storage handle.
export function createAccountDistributionRepository(storage: Storage) {
  return {
    lookup: (affinityKey: string): Promise<number | undefined> => {
      const key = conversationKey(affinityKey)
      return storage.read((session) => findOwner(session, key))
    },
    load: (): Promise<AccountDistributionPolicy & { revision: number }> =>
      storage.read(async (session) => {
        const policy = await readAccountDistributionPolicy(session)
        const active = await session.query({
          sql: "SELECT id FROM capi_accounts WHERE deleted_at IS NULL AND deleting_at IS NULL ORDER BY id",
          args: [],
        })
        const percentages = new Map(
          policy.allocations.map((row) => [row.accountId, row.percentage]),
        )
        return {
          ...policy,
          revision: await readStoreRevision(session),
          allocations: active.map((row) => ({
            accountId: Number(row.id),
            percentage: percentages.get(Number(row.id)) ?? 0,
          })),
        }
      }),
    replace: async (
      allocations: ReadonlyArray<AccountAllocation>,
      context: MutationContext,
    ): Promise<Committed<AccountDistributionPolicy>> => {
      const canonical = canonicalAllocations(allocations)
      const positive = canonical.filter((row) => row.percentage > 0)
      return runMutation(
        storage,
        bindAccountMutation(context, "account.distribution.replace", {
          allocations: canonical,
        }),
        async (session) => {
          const rows = await session.query({
            sql: "SELECT id FROM capi_accounts WHERE deleted_at IS NULL AND deleting_at IS NULL ORDER BY id",
            args: [],
          })
          const ids = new Set(rows.map((row) => row.id))
          if (canonical.some((row) => !ids.has(row.accountId)))
            throw new StorageConflictError(
              "Allocations reference an inactive account",
            )
          const current = await readAccountDistributionPolicy(session)
          const percentages = new Map(
            positive.map((row) => [row.accountId, row.percentage]),
          )
          const complete = rows.map((row) => ({
            accountId: Number(row.id),
            percentage: percentages.get(Number(row.id)) ?? 0,
          }))
          if (
            current.configured
            && JSON.stringify(current.allocations) === JSON.stringify(positive)
          )
            return { ...current, allocations: complete }
          const version = current.version + 1
          if (!Number.isSafeInteger(version))
            throw new StorageSchemaError("Allocation version exhausted")
          await session.execute({
            sql: "INSERT INTO capi_account_distribution(id,version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",
            args: [version],
          })
          await session.execute({
            sql: "DELETE FROM capi_account_allocations",
            args: [],
          })
          for (const row of positive)
            await session.execute({
              sql: "INSERT INTO capi_account_allocations(account_id,percentage) VALUES(?,?)",
              args: [row.accountId, row.percentage],
            })
          await session.execute({
            sql: "DELETE FROM capi_account_scheduler",
            args: [],
          })
          return { configured: true, version, allocations: complete }
        },
      )
    },
    assign: async (
      input: AccountAssignmentInput,
    ): Promise<AccountAssignment> => {
      const key = conversationKey(input.affinityKey)
      if (
        !input.modelId
        || input.eligibleAccountIds.some((id) => !validAccountId(id))
      )
        throw new StorageConflictError("Invalid account assignment input")
      // Capture caller-owned inputs before the first await.
      const owned = {
        ...input,
        eligibleAccountIds: [...input.eligibleAccountIds],
      }
      const found = await storage.read(async (session) => {
        const existing = await findOwner(session, key)
        return existing === undefined ? undefined : (
            resolveAssignment(session, owned, key, existing)
          )
      })
      if (found) return found
      return storage.transaction(async (session) =>
        resolveAssignment(session, owned, key, await findOwner(session, key)),
      )
    },
  }
}
