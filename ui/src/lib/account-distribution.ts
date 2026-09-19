export interface AccountAllocation {
  accountId: number
  percentage: number
}

export interface AccountDistribution {
  revision: number
  configured: boolean
  version: number
  allocations: Array<AccountAllocation>
}

export interface DistributionDraftRow {
  accountId: number
  active: number | null
  confirmed: number
  input: string
}

export interface DistributionDraft {
  revision: number
  version: number
  configured: boolean
  isEqualShareSuggestion: boolean
  accountSetChanged: boolean
  accountIds: Array<number>
  rows: Array<DistributionDraftRow>
}

function stableIds(accountIds: ReadonlyArray<number>): Array<number> {
  return [...new Set(accountIds)].sort((left, right) => left - right)
}

function equalShares(accountIds: ReadonlyArray<number>): Map<number, number> {
  const shares = new Map<number, number>()
  if (accountIds.length === 0) return shares
  const base = Math.floor(100 / accountIds.length)
  let remainder = 100 - base * accountIds.length
  for (const accountId of accountIds) {
    shares.set(accountId, base + (remainder > 0 ? 1 : 0))
    remainder--
  }
  return shares
}

function parsePercentage(value: string): number | undefined {
  if (value.trim() === "") return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return undefined
  return parsed
}

function sortRows(
  rows: ReadonlyArray<DistributionDraftRow>,
): Array<DistributionDraftRow> {
  return [...rows].sort(
    (left, right) =>
      right.confirmed - left.confirmed || left.accountId - right.accountId,
  )
}

export function createDistributionDraft(
  currentAccountIds: ReadonlyArray<number>,
  distribution: AccountDistribution,
): DistributionDraft {
  const accountIds = stableIds(currentAccountIds)
  const active = new Map(
    distribution.allocations.map(({ accountId, percentage }) => [
      accountId,
      percentage,
    ]),
  )
  const suggested = equalShares(accountIds)
  const rows = accountIds.map((accountId) => {
    const percentage =
      distribution.configured ?
        (active.get(accountId) ?? 0)
      : (suggested.get(accountId) ?? 0)
    return {
      accountId,
      active: distribution.configured ? (active.get(accountId) ?? 0) : null,
      confirmed: percentage,
      input: String(percentage),
    }
  })
  return {
    revision: distribution.revision,
    version: distribution.version,
    configured: distribution.configured,
    isEqualShareSuggestion: !distribution.configured,
    accountSetChanged: false,
    accountIds,
    rows: sortRows(rows),
  }
}

export function distributionTotal(draft: DistributionDraft): number {
  return draft.rows.reduce((total, row) => {
    const percentage = parsePercentage(row.input)
    return total + (percentage ?? 0)
  }, 0)
}

export function distributionHasPendingRows(draft: DistributionDraft): boolean {
  return draft.rows.some((row) => parsePercentage(row.input) !== row.confirmed)
}

export function distributionIsDirty(draft: DistributionDraft): boolean {
  if (!draft.configured) return draft.rows.length > 0
  return draft.rows.some((row) => row.confirmed !== row.active)
}

export function shouldAcceptDistributionSnapshot(
  draft: DistributionDraft,
  distribution: AccountDistribution,
): boolean {
  return distribution.revision >= draft.revision
}

export function canConfirmDistributionRow(
  draft: DistributionDraft,
  accountId: number,
): boolean {
  const row = draft.rows.find((candidate) => candidate.accountId === accountId)
  if (!row) return false
  const percentage = parsePercentage(row.input)
  return (
    percentage !== undefined
    && percentage >= 0
    && percentage <= 100
    && percentage !== row.confirmed
    && distributionTotal(draft) <= 100
  )
}

export function canSaveDistribution(draft: DistributionDraft): boolean {
  if (
    draft.rows.length === 0
    || draft.accountSetChanged
    || distributionHasPendingRows(draft)
    || distributionTotal(draft) !== 100
    || !distributionIsDirty(draft)
  )
    return false
  return draft.rows.every((row) => {
    const value = parsePercentage(row.input)
    return value !== undefined && value >= 0 && value <= 100
  })
}

export function canPublishDistribution(
  draft: DistributionDraft,
  state: {
    hasConflict?: boolean
    hasNewerRevision?: boolean
    isSaving?: boolean
  },
): boolean {
  return (
    canSaveDistribution(draft)
    && !state.hasConflict
    && !state.hasNewerRevision
    && !state.isSaving
  )
}

export function setDistributionInput(
  draft: DistributionDraft,
  accountId: number,
  input: string,
): DistributionDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) =>
      row.accountId === accountId ? { ...row, input } : row,
    ),
  }
}

export function stepDistributionInput(
  draft: DistributionDraft,
  accountId: number,
  delta: -5 | 5,
): DistributionDraft {
  const row = draft.rows.find((candidate) => candidate.accountId === accountId)
  if (!row) return draft
  const current = row.input.trim() === "" ? Number.NaN : Number(row.input)
  if (!Number.isFinite(current)) return draft
  const next = delta < 0 ? Math.max(0, current + delta) : current + delta
  if (delta > 0 && (next > 100 || distributionTotal(draft) + delta > 100))
    return draft
  if (next === current) return draft
  return setDistributionInput(draft, accountId, String(next))
}

export function revertDistributionRow(
  draft: DistributionDraft,
  accountId: number,
): DistributionDraft {
  const row = draft.rows.find((candidate) => candidate.accountId === accountId)
  return row ?
      setDistributionInput(draft, accountId, String(row.confirmed))
    : draft
}

export function confirmDistributionRow(
  draft: DistributionDraft,
  accountId: number,
): DistributionDraft {
  if (!canConfirmDistributionRow(draft, accountId)) return draft
  return {
    ...draft,
    rows: sortRows(
      draft.rows.map((row) =>
        row.accountId === accountId ?
          { ...row, confirmed: Number(row.input) }
        : row,
      ),
    ),
  }
}

export function syncDistributionAccounts(
  draft: DistributionDraft,
  currentAccountIds: ReadonlyArray<number>,
): DistributionDraft {
  const accountIds = stableIds(currentAccountIds)
  const changed =
    accountIds.length !== draft.accountIds.length
    || accountIds.some(
      (accountId, index) => accountId !== draft.accountIds[index],
    )
  return changed ? { ...draft, accountIds, accountSetChanged: true } : draft
}

export function rebaseDistributionDraft(
  draft: DistributionDraft,
  currentAccountIds: ReadonlyArray<number>,
  distribution: AccountDistribution,
): DistributionDraft {
  const latest = createDistributionDraft(currentAccountIds, distribution)
  const previous = new Map(draft.rows.map((row) => [row.accountId, row]))
  return {
    ...latest,
    isEqualShareSuggestion: latest.isEqualShareSuggestion,
    rows: sortRows(
      latest.rows.map((row) => {
        const retained = previous.get(row.accountId)
        return retained ?
            {
              ...row,
              confirmed: retained.confirmed,
              input: retained.input,
            }
          : row
      }),
    ),
  }
}

export function distributionAllocations(
  draft: DistributionDraft,
): Array<AccountAllocation> {
  return stableIds(draft.accountIds).map((accountId) => ({
    accountId,
    percentage:
      draft.rows.find((row) => row.accountId === accountId)?.confirmed ?? 0,
  }))
}
