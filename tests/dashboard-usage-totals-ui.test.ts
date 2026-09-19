// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
import { beforeEach, expect, mock, test } from "bun:test"

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"

const collection = {
  pendingRecords: 0,
  pendingBytes: 0,
  droppedRecords: 0,
  lastSuccessfulFlush: null,
  degraded: false,
  knownLostRecords: 0,
  knownLostBytes: 0,
  unknownGaps: 0,
}
const usage = {
  twenty_four_hour: {
    tokens_used: 1234,
    request_count: 7,
    total_input_tokens: 1000,
    total_output_tokens: 234,
  },
  lifetime: {
    total_tokens: 5678,
    total_requests: 19,
    total_input_tokens: 5000,
    total_output_tokens: 678,
    first_request_at: 1_700_000_000,
  },
  collection: { ...collection },
}
let routingData: unknown

await mock.module("../ui/src/lib/usePolling", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useAsyncData: (_load: unknown, dependencies: ReadonlyArray<unknown>) => ({
    data: dependencies.length === 0 ? usage : routingData,
    error: undefined,
    loading: false,
    reload: () => {},
    reloadSilently: () => {},
  }),

  useDelayedPolling: () => {},
}))
const { default: UsageScreen } = await import("../ui/src/screens/Usage")

beforeEach(() => {
  usage.collection = { ...collection }
  routingData = undefined
})

test("usage renders only last 24 hours and lifetime totals without fabricated limits", () => {
  const markup: string = renderToStaticMarkup(createElement(UsageScreen))
  expect(markup).toContain("Last 24 hours")
  expect(markup).toContain("Lifetime")
  expect(markup).toContain("1,234")
  expect(markup).toContain("5,678")
  expect(markup).toContain("First request:")
  expect(markup.match(/class="astryx-card /g)).toHaveLength(2)
  for (const obsolete of [
    "Five Hour",
    "Seven Day",
    "Collection",
    "utilization",
    "resets in",
    "progressbar",
  ])
    expect(markup).not.toContain(obsolete)
})

test("usage surfaces incomplete collection as a warning without another totals card", () => {
  usage.collection = { ...collection, degraded: true, unknownGaps: 1 }
  const markup: string = renderToStaticMarkup(createElement(UsageScreen))
  expect(markup).toContain("Usage history may be incomplete")
  expect(markup.match(/class="astryx-card /g)).toHaveLength(2)
  expect(markup).toContain("Last 24 hours")
})

test("account balance shows new assignment targets separately from repeat request counts", () => {
  routingData = {
    window: "1h",
    windowMinutes: 60,
    retentionMinutes: 1440,
    generatedAt: 1_700_000_000_000,
    telemetryStartedAt: 1_700_000_000_000,
    multiToken: true,
    totals: { requests: 1000, upstreamCalls: 1000, retries: 0, failovers: 0 },
    lifetime: { requests: 1000, upstreamCalls: 1000, retries: 0, failovers: 0 },
    timeSeries: [],
    models: [],
    routes: [],
    selectionModes: { sticky: 1000, default: 0, single: 0 },
    accounts: [
      {
        accountId: 3,
        label: "Account #3",
        healthy: true,
        selected: 905,
        selectionShare: 0.905,
        expectedSelections: 905,
        expectedShare: 0.905,
        selectionDelta: 0,
        upstreamCalls: 905,
        callShare: 0.905,
        balanceStatus: "within_range",
        balanceBasis: "new_assignments",
        newAssignments: 5,
        expectedNewAssignments: 5,
        newAssignmentShare: 0.05,
        expectedNewAssignmentShare: 0.05,
        newAssignmentDelta: 0,
      },
    ],
  }
  const markup: string = renderToStaticMarkup(createElement(UsageScreen))
  expect(markup).toContain("5 new conversations")
  expect(markup).toContain("5.0% actual")
  expect(markup).toContain("target 5.0%")
  expect(markup).toContain("905 selections")
  expect(markup).toContain("905 calls")
  expect(markup).toContain("Saved conversations")
  expect(markup).not.toContain("90.5% actual")
})
