import { expect, test } from "bun:test"

import {
  canConfirmDistributionRow,
  canPublishDistribution,
  canSaveDistribution,
  confirmDistributionRow,
  createDistributionDraft,
  distributionTotal,
  shouldAcceptDistributionSnapshot,
  rebaseDistributionDraft,
  setDistributionInput,
  stepDistributionInput,
  syncDistributionAccounts,
  type AccountDistribution,
} from "../ui/src/lib/account-distribution"

const configured: AccountDistribution = {
  revision: 11,
  configured: true,
  version: 3,
  allocations: [
    { accountId: 7, percentage: 50 },
    { accountId: 42, percentage: 30 },
    { accountId: 1001, percentage: 15 },
    { accountId: 900001, percentage: 5 },
  ],
}

test("inactive routing starts with a deterministic equal-share suggestion", () => {
  const draft = createDistributionDraft([42, 7, 1001], {
    revision: 4,
    configured: false,
    version: 0,
    allocations: [],
  })

  expect(
    draft.rows.map(({ accountId, confirmed }) => [accountId, confirmed]),
  ).toEqual([
    [7, 34],
    [42, 33],
    [1001, 33],
  ])
  expect(draft.isEqualShareSuggestion).toBe(true)
  expect(distributionTotal(draft)).toBe(100)
  expect(canSaveDistribution(draft)).toBe(true)
})

test("typing stays in place until confirmation then sorts by confirmed share and stable id", () => {
  const initial = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    configured,
  )
  const typed = setDistributionInput(initial, 900001, "55")

  expect(typed.rows.map(({ accountId }) => accountId)).toEqual([
    7, 42, 1001, 900001,
  ])
  expect(canConfirmDistributionRow(typed, 900001)).toBe(false)

  const balanced = setDistributionInput(
    setDistributionInput(typed, 7, "0"),
    1001,
    "15",
  )
  const confirmedLow = confirmDistributionRow(balanced, 7)
  const confirmedHigh = confirmDistributionRow(confirmedLow, 900001)
  expect(confirmedHigh.rows.map(({ accountId }) => accountId)).toEqual([
    900001, 42, 1001, 7,
  ])
})

test("five-point controls block overflow increases but always permit a decrease", () => {
  const initial = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    configured,
  )
  expect(stepDistributionInput(initial, 7, 5)).toBe(initial)

  const over = setDistributionInput(initial, 7, "110")
  const reduced = stepDistributionInput(over, 7, -5)
  expect(reduced.rows.find(({ accountId }) => accountId === 7)?.input).toBe(
    "105",
  )
  const decimal = stepDistributionInput(
    setDistributionInput(initial, 7, "103.5"),
    7,
    -5,
  )
  expect(decimal.rows.find(({ accountId }) => accountId === 7)?.input).toBe(
    "98.5",
  )
})

test("save requires whole confirmed values totaling exactly 100", () => {
  const initial = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    configured,
  )
  const below = setDistributionInput(initial, 7, "45")
  expect(canConfirmDistributionRow(below, 7)).toBe(true)
  expect(canSaveDistribution(confirmDistributionRow(below, 7))).toBe(false)

  const decimal = setDistributionInput(initial, 7, "49.5")
  expect(canConfirmDistributionRow(decimal, 7)).toBe(false)
})

test("account polling preserves edits and blocks save until explicit reconciliation", () => {
  const initial = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    configured,
  )
  const edited = setDistributionInput(initial, 42, "25")
  const polled = syncDistributionAccounts(edited, [7, 42, 1001, 900001, 99])

  expect(polled.rows.find(({ accountId }) => accountId === 42)?.input).toBe(
    "25",
  )
  expect(polled.accountSetChanged).toBe(true)
  expect(canSaveDistribution(polled)).toBe(false)
})

test("explicit rebase keeps surviving draft values, adds new accounts at zero and removes absent accounts", () => {
  const initial = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    configured,
  )
  const edited = confirmDistributionRow(
    setDistributionInput(setDistributionInput(initial, 42, "25"), 7, "55"),
    42,
  )
  const latest: AccountDistribution = {
    revision: 12,
    configured: true,
    version: 4,
    allocations: [
      { accountId: 7, percentage: 60 },
      { accountId: 42, percentage: 40 },
      { accountId: 99, percentage: 0 },
    ],
  }
  const rebased = rebaseDistributionDraft(edited, [7, 42, 99], latest)

  expect(rebased.revision).toBe(12)
  expect(
    rebased.rows.map(({ accountId, input }) => [accountId, input]),
  ).toEqual([
    [7, "55"],
    [42, "25"],
    [99, "0"],
  ])
  expect(rebased.accountSetChanged).toBe(false)
})

test("older polling snapshots cannot replace a newer saved or reloaded draft", () => {
  const current = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    { ...configured, revision: 15, version: 6 },
  )

  expect(
    shouldAcceptDistributionSnapshot(current, {
      ...configured,
      revision: 14,
      version: 5,
    }),
  ).toBe(false)
  expect(
    shouldAcceptDistributionSnapshot(current, {
      ...configured,
      revision: 15,
      version: 6,
    }),
  ).toBe(true)
  expect(
    shouldAcceptDistributionSnapshot(current, {
      ...configured,
      revision: 16,
      version: 7,
    }),
  ).toBe(true)
})

test("publish readiness blocks both page and dialog actions for stale, changed, conflicting or pending drafts", () => {
  const draft = createDistributionDraft(
    configured.allocations.map(({ accountId }) => accountId),
    { ...configured, configured: false, allocations: [] },
  )
  expect(canPublishDistribution(draft, {})).toBe(true)
  expect(canPublishDistribution(draft, { hasConflict: true })).toBe(false)
  expect(canPublishDistribution(draft, { hasNewerRevision: true })).toBe(false)
  expect(canPublishDistribution(draft, { isSaving: true })).toBe(false)
  expect(
    canPublishDistribution({ ...draft, accountSetChanged: true }, {}),
  ).toBe(false)
})

test("distribution API mutations publish the whole draft with the draft revision", async () => {
  const originalFetch = globalThis.fetch
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  )
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-copilot_admin_csrf=fixture" },
  })
  let request: RequestInit | undefined
  globalThis.fetch = ((_input, init) => {
    request = init
    return Promise.resolve(Response.json(configured))
  }) as typeof fetch
  try {
    const distributionApiPath = "../ui/src/lib/account-distribution-api"
    const { saveAccountDistribution } = (await import(distributionApiPath)) as {
      saveAccountDistribution: (
        allocations: Array<{ accountId: number; percentage: number }>,
        expectedRevision: number,
      ) => Promise<unknown>
    }
    await saveAccountDistribution(configured.allocations, 11)
    expect(request?.method).toBe("PUT")
    expect(request?.body).toBe(
      JSON.stringify({ allocations: configured.allocations }),
    )
    const headers = new Headers(request?.headers)
    expect(headers.get("if-match")).toBe('"11"')
    expect(headers.get("idempotency-key")).toMatch(/^[\da-f-]{36}$/)
    expect(headers.get("x-copilot-csrf")).toBe("fixture")
  } finally {
    // eslint-disable-next-line require-atomic-updates -- Restore the process-global test double after the awaited request finishes.
    globalThis.fetch = originalFetch
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument)
    else Reflect.deleteProperty(globalThis, "document")
  }
})
