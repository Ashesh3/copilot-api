// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"
import * as commonModule from "../ui/src/components/common"
import * as toastModule from "../ui/src/lib/toast"

interface ResetAction {
  confirmDescription: string
  onConfirm: () => void | Promise<void>
}
const common = commonModule as {
  ConfirmButton: (props: ResetAction) => unknown
}
const ConfirmButton = common.ConfirmButton
let resetAction: ResetAction | undefined
const reloadUsage = mock(() => {})
const reloadRouting = mock(() => {})
const notifications = {
  success: mock((_message: string) => {}),
  error: mock((_message: string) => {}),
}
const toast = toastModule as { useToast: () => typeof notifications }
const originalFetch = globalThis.fetch
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
let confirmSpy: { mockRestore: () => void }
let toastSpy: { mockRestore: () => void }

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
    reload: dependencies.length === 0 ? reloadUsage : reloadRouting,
    reloadSilently: () => {},
  }),

  useDelayedPolling: () => {},
}))
const { default: UsageScreen } = await import("../ui/src/screens/Usage")

beforeEach(() => {
  usage.collection = { ...collection }
  routingData = undefined
  resetAction = undefined
  reloadUsage.mockClear()
  reloadRouting.mockClear()
  notifications.success.mockClear()
  notifications.error.mockClear()
  confirmSpy = spyOn(common, "ConfirmButton").mockImplementation((props) => {
    resetAction = props
    return createElement(ConfirmButton, props) as unknown
  })
  toastSpy = spyOn(toast, "useToast").mockReturnValue(notifications)
})

afterEach(() => {
  confirmSpy.mockRestore()
  toastSpy.mockRestore()
  globalThis.fetch = originalFetch
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument)
  else Reflect.deleteProperty(globalThis, "document")
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

test("usage requires confirmation before clearing token, request, routing and collection history", () => {
  const request = mock(() => Promise.resolve(Response.json({ success: true })))
  globalThis.fetch = request as typeof fetch

  const markup: string = renderToStaticMarkup(createElement(UsageScreen))

  expect(markup).toContain("Reset usage")
  expect(request).not.toHaveBeenCalled()
  expect(resetAction?.onConfirm).toBeFunction()
  expect(resetAction?.confirmDescription).toMatch(/24.hour/i)
  expect(resetAction?.confirmDescription).toMatch(/lifetime/i)
  expect(resetAction?.confirmDescription).toMatch(/token/i)
  expect(resetAction?.confirmDescription).toMatch(/request/i)
  expect(resetAction?.confirmDescription).toMatch(/routing/i)
  expect(resetAction?.confirmDescription).toMatch(/historical collection/i)
  expect(resetAction?.confirmDescription).toMatch(/permanent/i)
  expect(resetAction?.confirmDescription).toMatch(
    /collection.*(fresh|restart)/i,
  )
})

test("confirmed usage reset refreshes both datasets only after the protected mutation succeeds", async () => {
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<RequestInit>()
  let requestedPath: unknown
  globalThis.fetch = ((path, init) => {
    requestedPath = path
    started.resolve(init ?? {})
    return response.promise
  }) as typeof fetch
  renderToStaticMarkup(createElement(UsageScreen))
  expect(resetAction?.onConfirm).toBeFunction()
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-copilot_admin_csrf=usage-reset-fixture" },
  })

  const pending = resetAction?.onConfirm()
  const request = await started.promise

  expect(requestedPath).toBe("/dashboard/api/usage")
  expect(request.method).toBe("DELETE")
  expect(request.credentials).toBe("same-origin")
  const headers = new Headers(request.headers)
  expect(headers.get("x-copilot-csrf")).toBe("usage-reset-fixture")
  expect(headers.get("idempotency-key")).toMatch(/^[\da-f-]{36}$/)
  expect(reloadUsage).not.toHaveBeenCalled()
  expect(reloadRouting).not.toHaveBeenCalled()
  expect(notifications.success).not.toHaveBeenCalled()

  response.resolve(Response.json({ success: true }))
  await pending

  expect(reloadUsage).toHaveBeenCalledTimes(1)
  expect(reloadRouting).toHaveBeenCalledTimes(1)
  expect(notifications.success).toHaveBeenCalledWith(
    expect.stringMatching(/usage.*reset/i),
  )
  expect(notifications.error).not.toHaveBeenCalled()
})

test("a failed usage reset preserves totals and collection warnings and reports the error", async () => {
  usage.collection = { ...collection, unknownGaps: 1 }
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ error: "Usage storage unavailable" }, { status: 503 }),
    )) as typeof fetch
  renderToStaticMarkup(createElement(UsageScreen))
  expect(resetAction?.onConfirm).toBeFunction()
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-copilot_admin_csrf=usage-reset-fixture" },
  })

  await resetAction?.onConfirm()

  expect(reloadUsage).not.toHaveBeenCalled()
  expect(reloadRouting).not.toHaveBeenCalled()
  expect(notifications.success).not.toHaveBeenCalled()
  expect(notifications.error).toHaveBeenCalledWith("Usage storage unavailable")
  const markup: string = renderToStaticMarkup(createElement(UsageScreen))
  expect(markup).toContain("1,234")
  expect(markup).toContain("5,678")
  expect(markup).toContain("Usage history may be incomplete")
})

test("collection warnings follow refreshed status and remain visible for current failures", () => {
  usage.collection = { ...collection, unknownGaps: 1 }
  expect(renderToStaticMarkup(createElement(UsageScreen))).toContain(
    "Usage history may be incomplete",
  )

  usage.collection = { ...collection }
  expect(renderToStaticMarkup(createElement(UsageScreen))).not.toContain(
    "Usage history may be incomplete",
  )

  usage.collection = { ...collection, degraded: true }
  expect(renderToStaticMarkup(createElement(UsageScreen))).toContain(
    "Usage history may be incomplete",
  )
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
