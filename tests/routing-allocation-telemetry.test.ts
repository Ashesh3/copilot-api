import { beforeEach, expect, test } from "bun:test"

import {
  getRoutingTelemetrySnapshotForTest,
  recordRoutingSelection,
  resetRoutingTelemetryForTest,
} from "~/lib/routing-telemetry"

const NOW = Date.UTC(2026, 8, 19, 12)
const ACCOUNTS = [0, 1, 2, 3].map((id) => ({
  id,
  accountType: "individual",
  healthy: true,
}))
const WEIGHTS = [
  { accountId: 0, weight: 80 },
  { accountId: 1, weight: 10 },
  { accountId: 2, weight: 5 },
  { accountId: 3, weight: 5 },
]

beforeEach(() => resetRoutingTelemetryForTest(NOW))

function snapshot() {
  return getRoutingTelemetrySnapshotForTest({
    accounts: ACCOUNTS,
    multiToken: true,
    now: NOW,
    window: "1h",
  })
}

test("records committed assignments before dispatch without inventing request selections", () => {
  recordRoutingSelection({
    accountId: 0,
    eligibleAccountIds: [0, 1, 2, 3],
    eligibleAccountWeights: WEIGHTS,
    assignmentReason: "new",
    allocationVersion: 1,
    assignmentOnly: true,
    mode: "sticky",
    affinitySource: "codex_thread",
    model: "allocation-model",
    timestamp: NOW,
  })
  const committed = snapshot()
  expect(committed.accounts[0]).toMatchObject({
    selected: 0,
    expectedSelections: 0,
    newAssignments: 1,
    expectedNewAssignments: 0.8,
    balanceBasis: "new_assignments",
  })
  expect(committed.selectionModes).toEqual({ default: 0, sticky: 0, single: 0 })
  expect(committed.affinitySources.codex_thread).toBe(0)
  expect(committed.totals.requests).toBe(0)
  recordRoutingSelection({
    accountId: 0,
    eligibleAccountIds: [0, 1, 2, 3],
    eligibleAccountWeights: WEIGHTS,
    assignmentReason: "existing",
    allocationVersion: 1,
    mode: "sticky",
    affinitySource: "codex_thread",
    model: "allocation-model",
    timestamp: NOW,
  })
  const dispatched = snapshot()
  expect(dispatched.accounts[0]).toMatchObject({
    selected: 1,
    expectedSelections: 1,
    newAssignments: 1,
    expectedNewAssignments: 0.8,
  })
  expect(dispatched.selectionModes.sticky).toBe(1)
  expect(dispatched.affinitySources.codex_thread).toBe(1)
})

test("compares new assignments with 80/10/5/5 targets, excluding repeated owners", () => {
  for (let index = 0; index < 100; index++) {
    let accountId = 3
    if (index < 80) accountId = 0
    else if (index < 90) accountId = 1
    else if (index < 95) accountId = 2
    recordRoutingSelection({
      accountId,
      eligibleAccountIds: [0, 1, 2, 3],
      eligibleAccountWeights: WEIGHTS,
      assignmentReason: "new",
      allocationVersion: 1,
      mode: "sticky",
      model: "allocation-model",
      timestamp: NOW,
    })
  }
  for (let index = 0; index < 900; index++) {
    recordRoutingSelection({
      accountId: 3,
      eligibleAccountIds: [0, 1, 2, 3],
      eligibleAccountWeights: WEIGHTS,
      assignmentReason: "existing",
      allocationVersion: 1,
      mode: "sticky",
      model: "allocation-model",
      timestamp: NOW,
    })
  }
  const result = snapshot()
  for (const [index, count] of [80, 10, 5, 5].entries()) {
    expect(result.accounts[index]).toMatchObject({
      balanceBasis: "new_assignments",
      balanceStatus: "within_range",
      newAssignments: count,
      newAssignmentShare: count / 100,
    })
    expect(result.accounts[index].expectedNewAssignments).toBeCloseTo(count)
    expect(result.accounts[index].expectedNewAssignmentShare).toBeCloseTo(
      count / 100,
    )
    expect(result.accounts[index].newAssignmentDelta).toBeCloseTo(0)
  }
  expect(result.accounts[3]).toMatchObject({
    selected: 905,
    selectionShare: 0.905,
  })
})

test("normalizes targets over the positive model-eligible subset", () => {
  for (let index = 0; index < 40; index++) {
    let accountId = 3
    if (index < 20) accountId = 1
    else if (index < 30) accountId = 2
    recordRoutingSelection({
      accountId,
      eligibleAccountIds: [1, 2, 3],
      eligibleAccountWeights: WEIGHTS,
      assignmentReason: "new",
      allocationVersion: 2,
      mode: "sticky",
      model: "limited-model",
      timestamp: NOW,
    })
  }
  const result = snapshot()
  expect(
    result.accounts.map((account) => account.expectedNewAssignments),
  ).toEqual([0, 20, 10, 10])
  expect(result.accounts.map((account) => account.newAssignmentShare)).toEqual([
    0, 0.5, 0.25, 0.25,
  ])
  expect(
    result.accounts.every(
      (account) => account.balanceStatus === "within_range",
    ),
  ).toBe(true)
})

test("zero-share existing owners and issuer pins do not create new allocation samples", () => {
  for (const reason of ["existing", "issuer", "pinned"] as const) {
    for (let index = 0; index < 40; index++) {
      recordRoutingSelection({
        accountId: 3,
        eligibleAccountIds: [0, 1, 2, 3],
        eligibleAccountWeights: [
          { accountId: 0, weight: 100 },
          { accountId: 3, weight: 0 },
        ],
        assignmentReason: reason,
        allocationVersion: 3,
        mode: "sticky",
        model: "allocation-model",
        timestamp: NOW,
      })
    }
  }
  expect(snapshot().accounts[3]).toMatchObject({
    balanceBasis: "new_assignments",
    balanceStatus: "insufficient_data",
    selected: 120,
    expectedSelections: 120,
    newAssignments: 0,
    expectedNewAssignments: 0,
    newAssignmentShare: 0,
    expectedNewAssignmentShare: 0,
  })
})

test("retains historical equal expectations without mixing them into new allocation balance", () => {
  for (let index = 0; index < 40; index++) {
    recordRoutingSelection({
      accountId: 3,
      eligibleAccountIds: [0, 3],
      mode: "sticky",
      model: "allocation-model",
      timestamp: NOW - 60_000,
    })
  }
  recordRoutingSelection({
    accountId: 3,
    eligibleAccountIds: [0, 3],
    assignmentReason: "legacy",
    allocationVersion: 0,
    mode: "sticky",
    model: "allocation-model",
    timestamp: NOW,
  })
  expect(snapshot().accounts[3]).toMatchObject({
    selected: 41,
    expectedSelections: 20.5,
    balanceStatus: "skewed",
  })
  expect(snapshot().accounts[3]).not.toHaveProperty("balanceBasis")
  recordRoutingSelection({
    accountId: 0,
    eligibleAccountIds: [0, 3],
    eligibleAccountWeights: [
      { accountId: 0, weight: 80 },
      { accountId: 3, weight: 20 },
    ],
    assignmentReason: "new",
    allocationVersion: 1,
    mode: "sticky",
    model: "allocation-model",
    timestamp: NOW,
  })
  expect(snapshot().accounts[0]).toMatchObject({
    balanceBasis: "new_assignments",
    balanceStatus: "insufficient_data",
    selected: 1,
    expectedSelections: 21.3,
    newAssignments: 1,
    expectedNewAssignments: 0.8,
  })
  expect(snapshot().accounts[3]).toMatchObject({
    selected: 41,
    newAssignments: 0,
    expectedNewAssignments: 0.2,
  })
})

test("integrates changed policy targets without reweighting earlier assignments", () => {
  for (const [version, weights] of [
    [1, [80, 20]],
    [2, [20, 80]],
  ] as const) {
    for (let index = 0; index < 50; index++) {
      recordRoutingSelection({
        accountId: index < weights[0] / 2 ? 0 : 1,
        eligibleAccountIds: [0, 1],
        eligibleAccountWeights: [
          { accountId: 0, weight: weights[0] },
          { accountId: 1, weight: weights[1] },
        ],
        assignmentReason: "new",
        allocationVersion: version,
        mode: "sticky",
        model: "allocation-model",
        timestamp: NOW,
      })
    }
  }
  for (const account of snapshot().accounts.slice(0, 2)) {
    expect(account.newAssignments).toBe(50)
    expect(account.expectedNewAssignments).toBeCloseTo(50)
    expect(account.balanceStatus).toBe("within_range")
  }
})

test("rejects malformed allocation metadata without losing request selection counts", () => {
  for (const invalid of [
    { allocationVersion: -1 },
    { allocationVersion: Infinity },
    { allocationVersion: Number.MAX_SAFE_INTEGER + 1 },
    { eligibleAccountWeights: [{ accountId: 0, weight: Number.NaN }] },
    { eligibleAccountWeights: [{ accountId: 0, weight: -1 }] },
    { eligibleAccountWeights: [{ accountId: 0, weight: 101 }] },
    { eligibleAccountWeights: [{ accountId: 0, weight: 0.5 }] },
    { eligibleAccountWeights: [{ accountId: 0, weight: 0 }] },
    { eligibleAccountWeights: [{ accountId: 1, weight: 100 }] },
    { eligibleAccountIds: [1] },
    {
      eligibleAccountWeights: [
        { accountId: 0, weight: 50 },
        { accountId: 0, weight: 50 },
      ],
    },
  ]) {
    recordRoutingSelection({
      accountId: 0,
      eligibleAccountIds: [0, 1],
      eligibleAccountWeights: [{ accountId: 0, weight: 100 }],
      assignmentReason: "new",
      allocationVersion: 1,
      mode: "sticky",
      model: "allocation-model",
      timestamp: NOW,
      ...invalid,
    })
  }
  expect(snapshot().accounts[0].selected).toBe(11)
  expect(snapshot().accounts[0]).not.toHaveProperty("balanceBasis")
  expect(JSON.stringify(snapshot())).not.toContain("null")
})

test("counts all one-percent eligible accounts in new assignment targets", () => {
  const weights = Array.from({ length: 100 }, (_, accountId) => ({
    accountId,
    weight: 1,
  }))
  recordRoutingSelection({
    accountId: 99,
    eligibleAccountIds: weights.map(({ accountId }) => accountId),
    eligibleAccountWeights: weights,
    assignmentReason: "new",
    allocationVersion: 1,
    mode: "sticky",
    model: "allocation-model",
    timestamp: NOW,
  })
  const result = getRoutingTelemetrySnapshotForTest({
    accounts: [{ id: 99, accountType: "individual", healthy: true }],
    multiToken: true,
    now: NOW,
    window: "1h",
  })
  expect(result.accounts[0]).toMatchObject({
    newAssignments: 1,
    expectedNewAssignments: 0.01,
  })
})
