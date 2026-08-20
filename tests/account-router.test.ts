import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { Model } from "../src/services/copilot/get-models"

import {
  getLastUsedAccountId,
  routedControlPlaneFetch,
  routedFetch,
} from "../src/lib/account-router"
import { runWithCopilotContractObservabilityScope } from "../src/lib/copilot-contract-observability"
import { runWithCopilotRequestAttribution } from "../src/lib/copilot-request-context"
import { LocalHTTPError } from "../src/lib/error"
import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import {
  clientSessionStorage,
  copilotResponseHeadersStorage,
  getCopilotResponseHeaders,
  requestIdStorage,
  routedAccountStorage,
  runWithRequestDiagnostics,
  suppressRequestModelDiagnostics,
} from "../src/lib/request-session"
/* eslint-disable max-lines -- account-router integration variants share singleton fixtures */
import { runWithRoutingAffinity } from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"

const originalFetch = globalThis.fetch
type FetchResultFactory = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response
const queuedResults: Array<
  DeferredFetchResponse | Error | FetchResultFactory | Response
> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []

interface DeferredFetchResponse {
  requestStarted: Promise<void>
  rejectResponse(error: Error): void
  resolveResponse(response: Response): void
  startRequest(): Promise<Response>
}

function createDeferredFetchResponse(): DeferredFetchResponse {
  let rejectResponse!: (error: Error) => void
  let resolveRequestStarted!: () => void
  let resolveResponse!: (response: Response) => void
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequestStarted = resolve
  })
  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })

  return {
    requestStarted,
    rejectResponse,
    resolveResponse,
    startRequest() {
      resolveRequestStarted()
      return responsePromise
    },
  }
}

function createObservedGitHubUserResponse(login: string): {
  loginRead: Promise<void>
  response: Response
} {
  let resolveLoginRead!: () => void
  const loginRead = new Promise<void>((resolve) => {
    resolveLoginRead = resolve
  })
  const response = new Response(JSON.stringify({ login }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  Object.defineProperty(response, "json", {
    value: () =>
      Promise.resolve({
        get login() {
          resolveLoginRead()
          return login
        },
      }),
  })
  return { loginRead, response }
}

function createWarningObserver(): {
  implementation: typeof consola.warn
  observed: Promise<void>
} {
  let resolveObserved!: () => void
  const observed = new Promise<void>((resolve) => {
    resolveObserved = resolve
  })
  const implementation = Object.assign(resolveObserved, {
    raw: resolveObserved,
  })
  return { implementation, observed }
}

function getRequestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url
  }
  if (url instanceof URL) {
    return url.toString()
  }
  return url.url
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getRequestUrl(url)
  capturedRequests.push({ url: requestUrl, init })

  const next = queuedResults.shift()
  if (!next) {
    throw new Error(`Unexpected fetch: ${requestUrl}`)
  }

  if (next instanceof Error) {
    throw next
  }
  if (typeof next === "function") {
    return next(requestUrl, init)
  }

  return next instanceof Response ? next : next.startRequest()
})

function createModel(id: string): Model {
  return {
    capabilities: {
      family: "gpt-4o",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  }
}

function registerAccount(
  id: number,
  modelId: string,
  copilotToken: string,
): void {
  const account = tokenPool.addAccount(`github-token-${id}`, "individual", id)
  account.copilotToken = copilotToken
  account.models = new Set([modelId])
  account.modelsData = [createModel(modelId)]
  account.healthy = true
}

function findKeyForAccount(modelId: string, accountId: number): string {
  const key = Array.from(
    { length: 1000 },
    (_, index) => `session-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      === accountId,
  )
  if (!key)
    throw new TypeError(`No affinity key found for account ${accountId}`)
  return key
}

function findAnotherKeyForAccount(
  modelId: string,
  accountId: number,
  excluded: string,
): string {
  const key = Array.from({ length: 1000 }, (_, index) => `other-${index}`).find(
    (candidate) =>
      candidate !== excluded
      && tokenPool.getAccountForModelBySession(modelId, candidate)?.id
        === accountId,
  )
  if (!key) throw new TypeError(`No second key found for account ${accountId}`)
  return key
}

function copilotTokenResponse(token: string): Response {
  return Response.json({
    expires_at: 1_900_000_000,
    refresh_in: 1800,
    token,
  })
}

function modelsResponse(modelIds: Array<string>): Response {
  return Response.json({
    data: modelIds.map((modelId) => createModel(modelId)),
    object: "list",
  })
}

function queuePersistent401Reinitialization(
  freshToken: string,
  modelIds: Array<string>,
): void {
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    copilotTokenResponse(freshToken),
    modelsResponse(modelIds),
    new Response("Unauthorized", { status: 401 }),
  )
}

function queueUrlAwarePersistent401(
  freshToken: string,
  modelIds: Array<string>,
): void {
  const responder: FetchResultFactory = (url) => {
    if (url.includes("/copilot_internal/v2/token")) {
      return copilotTokenResponse(freshToken)
    }
    if (url.endsWith("/models")) return modelsResponse(modelIds)
    return new Response("Unauthorized", { status: 401 })
  }
  queuedResults.push(responder, responder, responder, responder, responder)
}

function llmAuthorizationHeaders(): Array<string | null> {
  return capturedRequests
    .filter(
      ({ url }) =>
        !url.includes("/copilot_internal/") && !url.endsWith("/models"),
    )
    .map(({ init }) => new Headers(init?.headers).get("authorization"))
}

function responseMetadataEvents(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): Array<unknown> {
  return calls
    .filter(
      (call) =>
        call[0] === "[copilot-contract]"
        && (call[1] as { kind?: unknown } | undefined)?.kind
          === "response_metadata",
    )
    .map((call) => call[1])
}

async function routedFetchWithMetadataStore(modelId: string): Promise<{
  headers: Record<string, string>
  result: { account: unknown; response: Response }
}> {
  return await copilotResponseHeadersStorage.run(
    {},
    async () =>
      await runWithCopilotContractObservabilityScope(async () => {
        const result = await routedFetch(
          "/chat/completions",
          { method: "POST" },
          { maxHttpRetryDelaySeconds: 0, modelId },
        )
        return { result, headers: { ...getCopilotResponseHeaders() } }
      }),
  )
}

function retryableSocketError(): Error {
  return Object.assign(new Error("socket connection was closed unexpectedly"), {
    code: "ECONNRESET",
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  setModelRoutingOverridesForTest({})
  tokenPool.rebuildModelIndex()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  tokenPool.dispose()
  for (const account of tokenPool.getAllAccounts()) {
    tokenPool.removeAccountForTest(account.id)
  }
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
  setModelRoutingOverridesForTest({})
  state.isMultiToken = true
  state.sessionId = "router-test-session"
})

test("routes control-plane policy through raw advertised model membership", async () => {
  const modelId = "control-plane-disabled-inference-model"
  registerAccount(13_001, modelId, "raw-advertising-token")
  registerAccount(13_002, modelId, "inference-enabled-token")
  setModelRoutingOverridesForTest({ [modelId]: { "13001": false } })
  tokenPool.rebuildModelIndex()
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-policy-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountAdvertisingModelBySession(modelId, candidate)?.id
      === 13_001,
  )
  if (!affinityKey) throw new TypeError("Expected policy affinity key")
  queuedResults.push(Response.json({ success: true }))

  const result = await requestIdStorage.run("control-plane-request-id", () =>
    runWithCopilotRequestAttribution(
      {
        clientMachineId: "control-plane-machine",
        openaiIntent: "control-plane-intent",
        subsystemId: "control-plane-subsystem",
      },
      () =>
        routedAccountStorage.run({}, () =>
          runWithRoutingAffinity(
            { key: affinityKey, source: "copilot_session" },
            async () => {
              const routed = await routedControlPlaneFetch({
                modelId,
                path: `/models/${encodeURIComponent(modelId)}/policy`,
              })
              return { lastAccountId: getLastUsedAccountId(), routed }
            },
          ),
        ),
    ),
  )

  expect(tokenPool.getEligibleAccountIdsForModel(modelId)).toEqual([13_002])
  expect(result.routed.account?.id).toBe(13_001)
  expect(result.lastAccountId).toBe(13_001)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.url).toBe(
    `https://api.githubcopilot.com/models/${encodeURIComponent(modelId)}/policy`,
  )
  const headers = new Headers(capturedRequests[0]?.init?.headers)
  expect(headers.get("authorization")).toBe("Bearer raw-advertising-token")
  expect(headers.get("copilot-integration-id")).toBe(state.copilotIntegrationId)
  expect(headers.get("copilot-subsystem-id")).toBe("control-plane-subsystem")
  expect(headers.get("openai-intent")).toBe("control-plane-intent")
  expect(headers.get("x-client-machine-id")).toBe("control-plane-machine")
  expect(headers.get("x-github-api-version")).toBe("2026-08-01")
  expect(headers.get("x-request-id")).toBe("control-plane-request-id")
})

test("forwards typed control-plane body, session token, and abort signal", async () => {
  const matchingSessionToken = `e30.${Buffer.from(
    JSON.stringify({ sub: "control-plane-issuer" }),
  ).toString("base64url")}.c2ln`
  registerAccount(13_011, "model-a", "tid=control-plane-issuer;exp=1900000000")
  tokenPool.rebuildModelIndex()
  const controller = new AbortController()
  queuedResults.push(Response.json({ session: "created" }))

  const result = await runWithRoutingAffinity(
    { key: "control-plane-session", source: "copilot_session" },
    async () =>
      await routedControlPlaneFetch({
        body: { auto_mode: { model_hints: ["auto"] } },
        copilotSessionToken: matchingSessionToken,
        path: "/models/session",
        signal: controller.signal,
      }),
  )

  expect(result.account?.id).toBe(13_011)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.method).toBe("POST")
  expect(capturedRequests[0]?.init?.body).toBe(
    JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
  )
  expect(capturedRequests[0]?.init?.signal).toBe(controller.signal)
  expect(
    new Headers(capturedRequests[0]?.init?.headers).get(
      "copilot-session-token",
    ),
  ).toBe(matchingSessionToken)
})

test("returns local 503 without sending when no account advertises a policy model", async () => {
  registerAccount(13_021, "different-model", "unrelated-token")
  tokenPool.rebuildModelIndex()

  const { account, response } = await routedControlPlaneFetch({
    modelId: "missing-policy-model",
    path: "/models/missing-policy-model/policy",
  })

  expect(account).toBeUndefined()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: {
      code: "account_unavailable",
      message: "No healthy Copilot account is available for this request.",
      type: "account_unavailable",
    },
  })
  expect(capturedRequests).toHaveLength(0)
})

test("reinitializes a selected control-plane account without cross-account failover", async () => {
  registerAccount(13_031, "model-a", "tid=control-plane-issuer;exp=expired")
  registerAccount(13_032, "model-a", "tid=alternate-issuer;exp=current")
  tokenPool.rebuildModelIndex()
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-reinit-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === 13_031,
  )
  if (!affinityKey)
    throw new TypeError("Expected reinitialization affinity key")
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    copilotTokenResponse("tid=control-plane-issuer;exp=fresh"),
    modelsResponse(["model-a"]),
    Response.json({ refreshed: true }),
  )

  const { account, response } = await runWithRoutingAffinity(
    { key: affinityKey, source: "copilot_session" },
    async () =>
      await routedControlPlaneFetch({
        copilotSessionToken: `e30.${Buffer.from(
          JSON.stringify({ sub: "control-plane-issuer" }),
        ).toString("base64url")}.c2ln`,
        path: "/models/session",
      }),
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(13_031)
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer tid=control-plane-issuer;exp=expired",
    "Bearer tid=control-plane-issuer;exp=fresh",
  ])
  expect(llmAuthorizationHeaders()).not.toContain(
    "Bearer tid=alternate-issuer;exp=current",
  )
})

test("rejects a control-plane resend when refresh changes the selected account issuer", async () => {
  const matchingSessionToken = `e30.${Buffer.from(
    JSON.stringify({ sub: "original-issuer" }),
  ).toString("base64url")}.c2ln`
  registerAccount(13_041, "model-a", "tid=original-issuer;exp=expired")
  registerAccount(13_042, "model-a", "tid=alternate-issuer;exp=current")
  tokenPool.rebuildModelIndex()
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-changed-issuer-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === 13_041,
  )
  if (!affinityKey) throw new TypeError("Expected changed-issuer affinity")
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    copilotTokenResponse("tid=new-issuer;exp=fresh"),
    modelsResponse(["model-a"]),
  )

  const result = await runWithRoutingAffinity(
    { key: affinityKey, source: "copilot_session" },
    async () =>
      await routedControlPlaneFetch({
        copilotSessionToken: matchingSessionToken,
        path: "/models/session",
      }),
  )

  expect(result.response.status).toBe(409)
  expect(result.localError?.clientBody).toEqual({
    error: {
      code: "session_account_continuity_error",
      message: "The Copilot session token does not match the selected account.",
      type: "session_affinity_error",
    },
  })
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer tid=original-issuer;exp=expired",
  ])
  expect(llmAuthorizationHeaders()).not.toContain(
    "Bearer tid=new-issuer;exp=fresh",
  )
  expect(llmAuthorizationHeaders()).not.toContain(
    "Bearer tid=alternate-issuer;exp=current",
  )
})

test("uses the configured token for single-token control-plane calls", async () => {
  state.isMultiToken = false
  state.copilotToken = "single-control-plane-token"
  queuedResults.push(Response.json({ session: "created" }))

  const result = await routedControlPlaneFetch({ path: "/models/session" })

  expect(result.account).toBeUndefined()
  expect(
    new Headers(capturedRequests[0]?.init?.headers).get("authorization"),
  ).toBe("Bearer single-control-plane-token")
})

async function routedFetchWithAffinity(modelId: string, key: string) {
  return await runWithRoutingAffinity(
    { key, source: "copilot_session" },
    async () =>
      await routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )
}

test("keeps an identified session on its hashed account after persistent 401", async () => {
  const modelId = "identified-401-affinity"
  registerAccount(12_001, modelId, "bound-token")
  registerAccount(12_002, modelId, "alternate-token")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_001)
  queuePersistent401Reinitialization("fresh-bound-token", [modelId])

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(409)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      account_id: 12_001,
      code: "session_account_rejected",
      type: "session_affinity_error",
    },
  })
  expect(tokenPool.getEligibleAccountForModel(modelId, 12_001)).toBeDefined()
  expect(llmAuthorizationHeaders()).not.toContain("Bearer alternate-token")
})

test("one request rejection cannot remap another session", async () => {
  const modelId = "cross-session-health-regression"
  registerAccount(12_011, modelId, "shared-home")
  registerAccount(12_012, modelId, "other-home")
  tokenPool.rebuildModelIndex()
  const rejectedKey = findKeyForAccount(modelId, 12_011)
  const unaffectedKey = findAnotherKeyForAccount(modelId, 12_011, rejectedKey)
  queueUrlAwarePersistent401("refreshed-home", [modelId])

  await routedFetchWithAffinity(modelId, rejectedKey).catch(() => undefined)
  queuedResults.length = 0
  queuedResults.push(new Response("{}", { status: 200 }))
  const result = await routedFetchWithAffinity(modelId, unaffectedKey)

  expect(result.account?.id).toBe(12_011)
  expect(tokenPool.getHealthyAccountIds()).toContain(12_011)
})

test("returns a local conflict for identified 403 without failover", async () => {
  const modelId = "identified-403-affinity"
  registerAccount(12_021, modelId, "forbidden-home")
  registerAccount(12_022, modelId, "forbidden-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_021)
  queuedResults.push(new Response("Forbidden", { status: 403 }))

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(409)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "session_account_rejected",
      message:
        "The bound account rejected this conversation; affinity was preserved and no cross-account retry was attempted.",
    },
  })
  expect(llmAuthorizationHeaders()).toEqual(["Bearer forbidden-home"])
  expect(tokenPool.getHealthyAccountIds()).toContain(12_021)
})

test("reports reinitialization when the same-account retry returns 403", async () => {
  const modelId = "identified-reinitialized-403-affinity"
  registerAccount(12_025, modelId, "reinitialized-forbidden-home")
  registerAccount(12_026, modelId, "reinitialized-forbidden-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_025)
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    copilotTokenResponse("fresh-reinitialized-forbidden-home"),
    modelsResponse([modelId]),
    new Response("Forbidden", { status: 403 }),
  )

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "session_account_rejected",
      message:
        "The bound account rejected this conversation after successful account reinitialization; affinity was preserved and no cross-account retry was attempted.",
    },
  })
  expect(llmAuthorizationHeaders()).not.toContain(
    "Bearer reinitialized-forbidden-alternate",
  )
})

test("keeps identified 429 retries on the hashed account", async () => {
  const modelId = "identified-429-affinity"
  registerAccount(12_031, modelId, "limited-home")
  registerAccount(12_032, modelId, "limited-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_031)
  queuedResults.push(
    new Response("limited", {
      status: 429,
      headers: { "retry-after": "0" },
    }),
    new Response("still limited", {
      status: 429,
      headers: { "retry-after": "0" },
    }),
  )

  const result = await runWithRoutingAffinity(
    { key, source: "copilot_session" },
    async () =>
      await routedFetch(
        "/chat/completions",
        { method: "POST" },
        { maxHttpRetryDelaySeconds: 0, modelId },
      ),
  )

  expect(result.response.status).toBe(429)
  expect(result.account?.id).toBe(12_031)
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer limited-home",
    "Bearer limited-home",
  ])
})

test("returns local 503 without failover when reinitialization fails", async () => {
  const modelId = "identified-reinitialization-failure"
  registerAccount(12_041, modelId, "preserved-home")
  registerAccount(12_042, modelId, "unused-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_041)
  const account = tokenPool.getEligibleAccountForModel(modelId, 12_041)
  if (!account) throw new TypeError("Expected bound account")
  const originalModelsData = account.modelsData
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    copilotTokenResponse("unused-fresh-token"),
    new Response("model outage", { status: 503 }),
  )

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(503)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      account_id: 12_041,
      code: "account_reinitialization_failed",
      type: "account_unavailable",
    },
  })
  expect(account.copilotToken).toBe("preserved-home")
  expect(account.modelsData).toBe(originalModelsData)
  expect(account.models).toEqual(new Set([modelId]))
  expect(account.healthy).toBe(true)
  expect(llmAuthorizationHeaders()).toEqual(["Bearer preserved-home"])
})

test("preserves legacy WebSocket affinity and typed affinity precedence", async () => {
  const modelId = "router-legacy-websocket-affinity"
  registerAccount(1241, modelId, "legacy-first")
  registerAccount(1242, modelId, "legacy-second")
  tokenPool.rebuildModelIndex()
  const legacyKey = Array.from(
    { length: 100 },
    (_, index) => `legacy-websocket-session-${index}`,
  ).find(
    (key) => tokenPool.getAccountForModelBySession(modelId, key)?.id === 1241,
  )
  if (!legacyKey) throw new TypeError("Expected legacy key for first account")
  const typedKey = "typed-session"
  const legacyPreferred = tokenPool.getAccountForModelBySession(
    modelId,
    legacyKey,
  )
  if (!legacyPreferred) throw new TypeError("Expected legacy preferred account")
  queuedResults.push(new Response("{}", { status: 200 }))

  const legacyResult = await clientSessionStorage.run(
    legacyKey,
    async () =>
      await routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )
  expect(legacyResult.account?.id).toBe(legacyPreferred.id)

  const typedPreferred = tokenPool.getAccountForModelBySession(
    modelId,
    typedKey,
  )
  if (!typedPreferred) throw new TypeError("Expected typed preferred account")
  queuedResults.push(new Response("{}", { status: 200 }))
  const typedResult = await clientSessionStorage.run(
    legacyKey,
    async () =>
      await runWithRoutingAffinity(
        { key: typedKey, source: "copilot_session" },
        async () =>
          await routedFetch(
            "/chat/completions",
            { method: "POST" },
            { modelId },
          ),
      ),
  )
  expect(typedResult.account?.id).toBe(typedPreferred.id)
})

test("fails over to the next account immediately after a multi-token 401", async () => {
  const modelId = "router-401-failover-test"
  registerAccount(1001, modelId, "primary-copilot-token")
  registerAccount(1002, modelId, "secondary-copilot-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "retry-after": "0" },
    }),
    copilotTokenResponse("fresh-primary-copilot-token"),
    modelsResponse([modelId]),
    new Response("Unauthorized", {
      status: 401,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1002)
  expect(capturedRequests).toHaveLength(5)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer primary-copilot-token",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[2]?.url).toContain("/models")
  expect(capturedRequests[3]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-primary-copilot-token",
  })
  expect(capturedRequests[4]?.init?.headers).toMatchObject({
    Authorization: "Bearer secondary-copilot-token",
  })
})

test("records final response metadata once after a 403 account failover", async () => {
  const modelId = "router-metadata-failover"
  registerAccount(10_031, modelId, "metadata-primary")
  registerAccount(10_032, modelId, "metadata-secondary")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    new Response("Forbidden", {
      status: 403,
      headers: { "x-github-request-id": "failed-attempt" },
    }),
    new Response("{}", {
      status: 200,
      headers: {
        "x-github-request-id": "final-attempt",
        "x-quota-snapshot-premium": "final-quota",
      },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result, headers } = await routedFetchWithMetadataStore(modelId)

    expect(result.response.status).toBe(200)
    expect(headers).toEqual({
      "x-github-request-id": "final-attempt",
      "x-quota-snapshot-premium": "final-quota",
    })
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 2,
        quotaSnapshotCount: 1,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once after a transport retry", async () => {
  const modelId = "router-metadata-transport"
  registerAccount(10_041, modelId, "metadata-transport")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    retryableSocketError(),
    new Response("{}", {
      status: 200,
      headers: { "x-github-request-id": "transport-final" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    await routedFetchWithMetadataStore(modelId)

    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once after same-account reinitialization", async () => {
  const modelId = "router-metadata-reinitialize"
  registerAccount(10_051, modelId, "metadata-expired")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "x-github-request-id": "expired-attempt" },
    }),
    copilotTokenResponse("metadata-fresh"),
    modelsResponse([modelId]),
    new Response("{}", {
      status: 200,
      headers: { "x-github-request-id": "reinitialized-final" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result } = await routedFetchWithMetadataStore(modelId)

    expect(result.response.status).toBe(200)
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once for a returned terminal error", async () => {
  const modelId = "router-metadata-terminal"
  registerAccount(10_061, modelId, "metadata-terminal")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    new Response("unprocessable", {
      status: 422,
      headers: { "x-github-request-id": "terminal-final" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result } = await routedFetchWithMetadataStore(modelId)

    expect(result.response.status).toBe(422)
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once when affinity rejection throws", async () => {
  const modelId = "router-metadata-affinity-rejection"
  registerAccount(10_071, modelId, "metadata-affinity")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 10_071)
  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "x-github-request-id": "affinity-first" },
    }),
    copilotTokenResponse("metadata-affinity-fresh"),
    modelsResponse([modelId]),
    new Response("Unauthorized", {
      status: 401,
      headers: { "x-github-request-id": "affinity-final" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const error = await copilotResponseHeadersStorage
      .run(
        {},
        async () =>
          await runWithCopilotContractObservabilityScope(
            async () =>
              await runWithRoutingAffinity(
                { key, source: "copilot_session" },
                async () =>
                  await routedFetch(
                    "/chat/completions",
                    { method: "POST" },
                    { modelId },
                  ),
              ),
          ),
      )
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("refreshes a multi-token account and retries after a 401", async () => {
  const modelId = "router-401-refresh-test"
  registerAccount(1011, modelId, "expired-copilot-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("IDE token expired: unauthorized: token expired\n", {
      status: 401,
    }),
    copilotTokenResponse("fresh-copilot-token"),
    modelsResponse([modelId]),
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1011)
  expect(account?.copilotToken).toBe("fresh-copilot-token")
  expect(capturedRequests).toHaveLength(4)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-copilot-token",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    authorization: "token github-token-1011",
  })
  expect(capturedRequests[2]?.url).toContain("/models")
  expect(capturedRequests[3]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-copilot-token",
  })
})

test("disables pooling for multi-token model discovery", async () => {
  const account = tokenPool.addAccount("github-model-token", "individual", 1110)
  const githubUserResponse = createDeferredFetchResponse()
  const observedGitHubUser = createObservedGitHubUserResponse("model-user")
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-model-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    githubUserResponse,
  )

  const initialization = tokenPool.initializeAccount(account)
  await githubUserResponse.requestStarted
  githubUserResponse.resolveResponse(observedGitHubUser.response)
  await observedGitHubUser.loginRead
  await initialization

  expect(capturedRequests[1]?.url).toContain("/models")
  expect(capturedRequests[1]?.init?.keepalive).toBe(false)
})

test("resolves the GitHub username during account initialization", async () => {
  const account = tokenPool.addAccount(
    "github-username-token",
    "individual",
    1111,
  )
  const githubUserResponse = createDeferredFetchResponse()
  const observedGitHubUser = createObservedGitHubUserResponse("octocat")
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-username-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    githubUserResponse,
  )

  const initialization = tokenPool.initializeAccount(account)
  await githubUserResponse.requestStarted
  githubUserResponse.resolveResponse(observedGitHubUser.response)
  await observedGitHubUser.loginRead
  await initialization

  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "refreshed-copilot-username-token",
        expires_at: 1_900_003_600,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
  await tokenPool.refreshAccountToken(account)

  expect(account.githubUsername).toBe("octocat")
  expect(capturedRequests[2]?.url).toBe("https://api.github.com/user")
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    authorization: "token github-username-token",
  })
  expect(
    capturedRequests.filter(
      (request) => request.url === "https://api.github.com/user",
    ),
  ).toHaveLength(1)
})

test("does not block account initialization while GitHub username lookup is pending", async () => {
  const account = tokenPool.addAccount(
    "github-username-deferred-token",
    "individual",
    1114,
  )
  const githubUserResponse = createDeferredFetchResponse()
  const observedGitHubUser = createObservedGitHubUserResponse("deferred-user")
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-username-deferred-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    githubUserResponse,
  )

  let initializationSettled = false
  const initialization = tokenPool.initializeAccount(account).then(() => {
    initializationSettled = true
  })
  try {
    await githubUserResponse.requestStarted
    // requestStarted resolves before initializeAccount returns. Its completion
    // reaction is therefore already queued; one microtask lets it run without
    // releasing the still-pending GitHub response.
    await Promise.resolve()

    expect(initializationSettled).toBe(true)
    expect(account.healthy).toBe(true)
    expect(account.githubUsername).toBeUndefined()
    expect(
      capturedRequests.filter(
        (request) => request.url === "https://api.github.com/user",
      ),
    ).toHaveLength(1)
  } finally {
    githubUserResponse.resolveResponse(observedGitHubUser.response)
    await initialization
    await observedGitHubUser.loginRead
  }

  expect(account.githubUsername).toBe("deferred-user")
  expect(
    capturedRequests.filter(
      (request) => request.url === "https://api.github.com/user",
    ),
  ).toHaveLength(1)
})

test("keeps an account healthy when GitHub username lookup fails", async () => {
  const account = tokenPool.addAccount(
    "github-username-failure-token",
    "individual",
    1112,
  )
  const githubUserResponse = createDeferredFetchResponse()
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-username-failure-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    githubUserResponse,
  )

  const warnSpy = spyOn(consola, "warn")
  const warningObserver = createWarningObserver()
  warnSpy.mockImplementation(warningObserver.implementation)
  let warningOutput: string
  try {
    const initialization = tokenPool.initializeAccount(account)
    await githubUserResponse.requestStarted
    githubUserResponse.resolveResponse(
      new Response("Service unavailable", { status: 503 }),
    )
    await warningObserver.observed
    await initialization
    warningOutput = warnSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .join("\n")
  } finally {
    warnSpy.mockRestore()
  }

  expect(account.healthy).toBe(true)
  expect(account.githubUsername).toBeUndefined()
  expect(capturedRequests[2]?.url).toBe("https://api.github.com/user")
  expect(warningOutput).toContain("account #1112")
  expect(warningOutput).toContain("HTTP 503")
  expect(warningOutput).not.toContain("github-username-failure-token")
})

test("redacts arbitrary GitHub username lookup error messages", async () => {
  const account = tokenPool.addAccount(
    "github-username-redaction-token",
    "individual",
    1113,
  )
  const githubUserResponse = createDeferredFetchResponse()
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-username-redaction-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    githubUserResponse,
  )

  const warnSpy = spyOn(consola, "warn")
  const warningObserver = createWarningObserver()
  warnSpy.mockImplementation(warningObserver.implementation)
  let warningOutput: string
  try {
    const initialization = tokenPool.initializeAccount(account)
    await githubUserResponse.requestStarted
    githubUserResponse.rejectResponse(
      new Error("request failed for github-username-redaction-token"),
    )
    await warningObserver.observed
    await initialization
    warningOutput = warnSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .join("\n")
  } finally {
    warnSpy.mockRestore()
  }

  expect(account.healthy).toBe(true)
  expect(account.githubUsername).toBeUndefined()
  expect(warningOutput).toContain("account #1113")
  expect(warningOutput).toContain("Error")
  expect(warningOutput).not.toContain("request failed")
  expect(warningOutput).not.toContain("github-username-redaction-token")
})

test("does not fail over aborted multi-token requests", async () => {
  const modelId = "router-abort-test"
  registerAccount(1003, modelId, "abort-primary-token")
  registerAccount(1004, modelId, "abort-secondary-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Error("The operation was aborted"),
    new Response("{}", { status: 200 }),
  )

  let thrownError: unknown
  try {
    await routedFetch("/chat/completions", { method: "POST" }, { modelId })
  } catch (error) {
    thrownError = error
  }
  expect(thrownError).toBeInstanceOf(Error)
  if (!(thrownError instanceof Error)) {
    throw new TypeError("Expected routedFetch to throw an Error")
  }
  expect(thrownError.message).toContain("aborted")

  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer abort-primary-token",
  })
})

test("applies headerOptions when multi-token falls back with no matching account", async () => {
  state.copilotToken = "fallback-copilot-token"
  const modelId = "router-no-account-header-fallback"
  registerAccount(1012, "different-known-model", "healthy-fallback-token")
  tokenPool.rebuildModelIndex()
  const expectedAccount = tokenPool.getFirstHealthyAccount()
  if (!expectedAccount) {
    throw new Error("Expected a healthy fallback account")
  }
  expectedAccount.copilotToken = "healthy-fallback-token"

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    {
      modelId,
      headerOptions: {
        initiator: "agent",
        vision: true,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(expectedAccount.id)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer healthy-fallback-token",
    "X-Initiator": "agent",
    "Copilot-Vision-Request": "true",
  })
})

test("omits fallback model diagnostics only inside a suppressed request scope", async () => {
  const modelId = "router-private-fallback-model"
  registerAccount(10_212, "different-known-model", "healthy-fallback-token")
  tokenPool.rebuildModelIndex()
  queuedResults.push(new Response("{}", { status: 200 }))
  const warnSpy = spyOn(consola, "warn")

  try {
    await runWithRequestDiagnostics(async () => {
      suppressRequestModelDiagnostics()
      await routedFetch("/responses", { method: "POST" }, { modelId })
    })
    const suppressedOutput = JSON.stringify(warnSpy.mock.calls)
    expect(suppressedOutput).toContain("Using Account #10212 as fallback")
    expect(suppressedOutput).not.toContain("for model")
    expect(suppressedOutput).not.toContain(modelId)

    warnSpy.mockClear()
    queuedResults.push(new Response("{}", { status: 200 }))
    await routedFetch("/responses", { method: "POST" }, { modelId })
    expect(JSON.stringify(warnSpy.mock.calls)).toContain(modelId)
  } finally {
    warnSpy.mockRestore()
  }
})

test("refreshes the fallback account for unknown models after a 401", async () => {
  const modelId = "gpt-4.1-mini"
  registerAccount(1013, "different-known-model", "expired-fallback-token")
  tokenPool.rebuildModelIndex()
  const expectedAccount = tokenPool.getFirstHealthyAccount()
  if (!expectedAccount) {
    throw new Error("Expected a healthy fallback account")
  }
  expectedAccount.copilotToken = "expired-fallback-token"

  queuedResults.push(
    new Response("IDE token expired: unauthorized: token expired\n", {
      status: 401,
    }),
    copilotTokenResponse("fresh-fallback-token"),
    modelsResponse(["different-known-model"]),
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(expectedAccount.id)
  expect(account?.copilotToken).toBe("fresh-fallback-token")
  expect(capturedRequests).toHaveLength(4)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-fallback-token",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[2]?.url).toContain("/models")
  expect(capturedRequests[3]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-fallback-token",
  })
})

test("does not expose last used account globally outside request context", async () => {
  const modelId = "router-no-global-last-account"
  registerAccount(1005, modelId, "single-router-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1005)
  expect(getLastUsedAccountId()).toBeUndefined()
})

test("routes a model only to accounts where the model is enabled", async () => {
  const modelId = "router-model-disabled-primary"
  registerAccount(1006, modelId, "disabled-account-token")
  registerAccount(1007, modelId, "enabled-account-token")
  setModelRoutingOverridesForTest({ [modelId]: { "1006": false } })
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1007)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer enabled-account-token",
  })
})

test("routes a model that only one account advertises to that account", async () => {
  const exclusiveModelId = "claude-fable-5"
  registerAccount(1014, "claude-opus-4.8", "opus-account-token")
  registerAccount(1015, exclusiveModelId, "fable-account-token")
  registerAccount(1016, "claude-sonnet-4.6", "sonnet-account-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId: exclusiveModelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1015)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer fable-account-token",
  })
})

test("does not fail over to an account where the model is disabled", async () => {
  const modelId = "router-model-disabled-failover"
  registerAccount(1008, modelId, "enabled-failover-primary")
  registerAccount(1009, modelId, "disabled-failover-secondary")
  setModelRoutingOverridesForTest({ [modelId]: { "1009": false } })
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    copilotTokenResponse("fresh-enabled-failover-primary"),
    modelsResponse([modelId]),
    new Response("Unauthorized", { status: 401 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(1008)
  expect(capturedRequests).toHaveLength(4)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer enabled-failover-primary",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[2]?.url).toContain("/models")
  expect(capturedRequests[3]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-enabled-failover-primary",
  })
})

test("returns a routing error when every known account for a model is disabled", async () => {
  const modelId = "router-model-all-disabled"
  registerAccount(1010, modelId, "disabled-only-token")
  setModelRoutingOverridesForTest({ [modelId]: { "1010": false } })
  tokenPool.rebuildModelIndex()

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(403)
  expect(account).toBeUndefined()
  expect(capturedRequests).toHaveLength(0)

  const body = (await response.json()) as { error: { type: string } }
  expect(body.error.type).toBe("model_routing_error")
})

test("does not switch accounts on a transport connection error", async () => {
  const modelId = "router-network-error"
  registerAccount(1101, modelId, "network-primary-token")
  registerAccount(1102, modelId, "network-secondary-token")
  tokenPool.rebuildModelIndex()

  // Both sends come from copilotFetch's own bounded retry, on one account.
  const socketError = () =>
    Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
      { code: "ECONNRESET", errno: 0 },
    )
  queuedResults.push(socketError(), socketError())

  let thrownError: unknown
  try {
    await routedFetch("/chat/completions", { method: "POST" }, { modelId })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(capturedRequests).toHaveLength(2)
  for (const request of capturedRequests) {
    expect(request.init?.headers).toMatchObject({
      Authorization: "Bearer network-primary-token",
    })
  }
})

test("caps sends across a 401 refresh-resend and a failover transport retry", async () => {
  // Exact repro: 401 -> refresh -> 401 -> failover -> ECONNRESET -> would-be
  // success. The fourth LLM send must never be issued.
  const modelId = "router-401-refresh-then-failover"
  registerAccount(1105, modelId, "expired-primary-token")
  registerAccount(1106, modelId, "budget-failover-token")
  tokenPool.rebuildModelIndex()

  const tokenResponse = () =>
    new Response(
      JSON.stringify({
        token: "fresh-copilot-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

  queuedResults.push(
    new Response("unauthorized: token expired\n", { status: 401 }),
    tokenResponse(),
    modelsResponse([modelId]),
    new Response("unauthorized: token expired\n", { status: 401 }),
    Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
      { code: "ECONNRESET", errno: 0 },
    ),
    // A fourth LLM send would consume this; the budget must prevent it.
    new Response("{}", { status: 200 }),
  )

  let thrownError: unknown
  try {
    await routedFetch("/chat/completions", { method: "POST" }, { modelId })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )

  const llmSends = capturedRequests.filter(
    (request) =>
      !request.url.includes("/copilot_internal/")
      && !request.url.endsWith("/models"),
  )
  expect(llmSends).toHaveLength(3)
  expect(llmSends[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-primary-token",
  })
  expect(llmSends[1]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-copilot-token",
  })
  expect(llmSends[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-failover-token",
  })
})

test("caps total sends across a 429 failover and a transport retry", async () => {
  const modelId = "router-429-then-network"
  registerAccount(1103, modelId, "budget-primary-token")
  registerAccount(1104, modelId, "budget-secondary-token")
  tokenPool.rebuildModelIndex()

  // Account A 429s and the failover each draw one of the routed call's two
  // extra sends, so the ECONNRESET on account B cannot buy a fourth send.
  const retryAfterZero = { "retry-after": "0" }
  queuedResults.push(
    new Response("Too Many Requests", { status: 429, headers: retryAfterZero }),
    new Response("Too Many Requests", { status: 429, headers: retryAfterZero }),
    Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
      { code: "ECONNRESET", errno: 0 },
    ),
  )

  let thrownError: unknown
  try {
    await routedFetch("/chat/completions", { method: "POST" }, { modelId })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(capturedRequests).toHaveLength(3)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-primary-token",
  })
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-primary-token",
  })
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-secondary-token",
  })
})
