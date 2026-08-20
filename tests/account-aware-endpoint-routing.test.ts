/* eslint-disable max-lines -- endpoint authority and token continuity share singleton route fixtures */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { Account } from "~/lib/token-pool"
import type { Model } from "~/services/copilot/get-models"

import {
  routedFetch,
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import { LocalHTTPError } from "~/lib/error"
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
} from "~/lib/llm-debug-log"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalModels = state.models
const testAccountIds = new Set<number>()
const queuedFetchResults: Array<Response> = []
let onAttachmentFetch: (() => void) | undefined
const upstreamRequests: Array<{
  authorization: string | null
  path: string
}> = []
const upstreamSessionTokens: Array<{
  path: string
  token: string | null
}> = []

function sessionToken(options: { modelId: string; subject?: string }): string {
  return `e30.${Buffer.from(
    JSON.stringify({
      selected_model: options.modelId,
      ...(options.subject ? { sub: options.subject } : {}),
    }),
  ).toString("base64url")}.c2ln`
}

function toRequest(url: string | URL | Request, init?: RequestInit): Request {
  if (url instanceof Request) return new Request(url, init)
  return new Request(url.toString(), init)
}

function createModel(id: string, supportedEndpoints: Array<string>): Model {
  return {
    capabilities: {
      family: "test",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: { streaming: true, tool_calls: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    supported_endpoints: [...supportedEndpoints],
    vendor: "openai",
    version: "test",
  }
}

function registerAccount(options: {
  accountId: number
  endpoints: Array<string>
  modelId: string
  token: string
}): Account {
  const account = tokenPool.addAccount(
    `github-${options.accountId}`,
    "individual",
    options.accountId,
  )
  testAccountIds.add(options.accountId)
  account.copilotToken = options.token
  account.healthy = true
  account.models = new Set([options.modelId])
  account.modelsData = [createModel(options.modelId, options.endpoints)]
  return account
}

function installConflictingCatalogs(options: {
  first: Array<string>
  modelId: string
  second: Array<string>
}): string {
  registerAccount({
    accountId: 52_401,
    endpoints: options.first,
    modelId: options.modelId,
    token: "first-account-token",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: options.second,
    modelId: options.modelId,
    token: "second-account-token",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()

  const affinityKey = Array.from(
    { length: 10_000 },
    (_, index) => `account-aware-affinity-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(options.modelId, candidate)?.id
      === 52_402,
  )
  if (!affinityKey) throw new TypeError("Expected affinity for second account")
  return affinityKey
}

function chatResponse(model: string): Response {
  return Response.json({
    id: "chat_account_aware",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function responsesResponse(model: string): Response {
  return Response.json({
    id: "resp_account_aware",
    object: "response",
    created_at: 1,
    model,
    output: [
      {
        id: "msg_account_aware",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    output_text: "ok",
    status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  })
}

function messagesResponse(model: string): Response {
  return Response.json({
    id: "msg_account_aware",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const request = toRequest(url, init)
  const path = new URL(request.url).pathname
  upstreamRequests.push({
    authorization: request.headers.get("authorization"),
    path,
  })

  if (new URL(request.url).hostname === "attachment.test") {
    onAttachmentFetch?.()
    return new Response("normalized image", {
      headers: { "content-type": "image/png" },
    })
  }
  upstreamSessionTokens.push({
    path,
    token: request.headers.get("copilot-session-token"),
  })

  const queued = queuedFetchResults.shift()
  if (queued) return queued

  const body =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as { model?: string })
    : {}
  const model = body.model ?? "account-aware-model"
  if (path === "/responses") return responsesResponse(model)
  if (path === "/v1/messages") return messagesResponse(model)
  if (path === "/chat/completions") return chatResponse(model)
  return new Response("unexpected path", { status: 500 })
})

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  state.models = originalModels
})

beforeEach(() => {
  upstreamRequests.length = 0
  upstreamSessionTokens.length = 0
  queuedFetchResults.length = 0
  onAttachmentFetch = undefined
  fetchMock.mockClear()
  clearLlmDebugLogs()
  state.accountType = "individual"
  state.copilotToken = "single-token-fallback"
  state.githubToken = "github-token"
  state.isMultiToken = true
  state.manualApprove = false
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([
  {
    path: "/v1/chat/completions",
    upstreamPath: "/chat/completions",
    body: (modelId: string) => ({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
    }),
  },
  {
    path: "/v1/responses",
    upstreamPath: "/responses",
    body: (modelId: string) => ({ model: modelId, input: "hello" }),
  },
  {
    path: "/v1/messages",
    upstreamPath: "/v1/messages",
    body: (modelId: string) => ({
      model: modelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  },
] as const)(
  "$path forwards a model-matched session token only to its issuer-matched selected account",
  async ({ body, path, upstreamPath }) => {
    const modelId = `session-continuity-${upstreamPath.replaceAll("/", "-")}`
    registerAccount({
      accountId: 52_401,
      endpoints: [upstreamPath],
      modelId,
      token: "tid=issuer-a;exp=1900000000",
    })
    registerAccount({
      accountId: 52_402,
      endpoints: [upstreamPath],
      modelId,
      token: "tid=issuer-b;exp=1900000000",
    })
    tokenPool.rebuildModelIndex()
    state.models = tokenPool.getAllModels()
    const affinityKey = Array.from(
      { length: 10_000 },
      (_, index) => `session-continuity-${index}`,
    ).find(
      (candidate) =>
        tokenPool.getAccountForModelBySession(modelId, candidate)?.id
        === 52_401,
    )
    if (!affinityKey) throw new TypeError("Expected issuer affinity")
    const token = sessionToken({ modelId, subject: "issuer-a" })

    const response = await server.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "copilot-session-token": token,
        "x-client-session-id": affinityKey,
      },
      body: JSON.stringify(body(modelId)),
    })

    expect(response.status).toBe(200)
    expect(upstreamSessionTokens).toEqual([{ path: upstreamPath, token }])
    const debugEntry = getLlmDebugLog(
      listLlmDebugLogs().entries.find((entry) => entry.path === upstreamPath)
        ?.id ?? "",
    )
    expect(debugEntry?.request.headers["Copilot-Session-Token"]).toBe(token)
  },
)

test("omits a session issued by account A when eligibility moves inference to account B", async () => {
  const modelId = "session-continuity-eligibility-change"
  const accountA = registerAccount({
    accountId: 52_401,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-a;exp=1900000000",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-b;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  const affinityKey = Array.from(
    { length: 10_000 },
    (_, index) => `session-issuance-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === 52_401,
  )
  if (!affinityKey) throw new TypeError("Expected account A affinity")
  const issuedToken = sessionToken({ modelId, subject: "issuer-a" })
  queuedFetchResults.push(Response.json({ session_token: issuedToken }))

  const sessionResponse = await server.request("/models/session", {
    method: "POST",
    headers: { "x-client-session-id": affinityKey },
  })
  expect(sessionResponse.status).toBe(200)
  expect(await sessionResponse.json()).toEqual({
    session_token: issuedToken,
  })
  expect(upstreamRequests[0]).toEqual({
    authorization: "Bearer tid=issuer-a;exp=1900000000",
    path: "/models/session",
  })

  accountA.models.clear()
  tokenPool.rebuildModelIndex()
  upstreamSessionTokens.length = 0

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "copilot-session-token": issuedToken,
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({ model: modelId, input: "hello" }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests.at(-1)).toEqual({
    authorization: "Bearer tid=issuer-b;exp=1900000000",
    path: "/responses",
  })
  expect(upstreamSessionTokens).toEqual([{ path: "/responses", token: null }])
  for (const entry of listLlmDebugLogs().entries) {
    expect(JSON.stringify(getLlmDebugLog(entry.id))).not.toContain(issuedToken)
  }
})

test("fails closed when the issuer becomes unhealthy", async () => {
  const modelId = "session-continuity-issuer-unhealthy"
  const accountA = registerAccount({
    accountId: 52_401,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-a;exp=1900000000",
  })
  const accountB = registerAccount({
    accountId: 52_402,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-b;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  const affinityKey = Array.from(
    { length: 20_000 },
    (_, index) => `session-change-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      === accountA.id,
  )
  if (!affinityKey) throw new TypeError("Expected issuer affinity")
  const token = sessionToken({ modelId, subject: "issuer-a" })
  tokenPool.markUnhealthy(accountA)
  expect(accountB.healthy).toBe(true)
  state.models = tokenPool.getAllModels()

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "copilot-session-token": token,
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({ model: modelId, input: "hello" }),
  })

  expect(response.status).toBe(200)
  expect(upstreamSessionTokens).toEqual([{ path: "/responses", token: null }])
})

test("fails closed when adding an account changes the affinity winner", async () => {
  const modelId = "session-continuity-account-addition"
  const accountA = registerAccount({
    accountId: 52_401,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-a;exp=1900000000",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-b;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  const initialCandidates = Array.from(
    { length: 20_000 },
    (_, index) => `session-addition-${index}`,
  ).filter(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      === accountA.id,
  )
  registerAccount({
    accountId: 52_403,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-c;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  const affinityKey = initialCandidates.find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      !== accountA.id,
  )
  if (!affinityKey) throw new TypeError("Expected changed affinity winner")
  state.models = tokenPool.getAllModels()
  const token = sessionToken({ modelId, subject: "issuer-a" })

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "copilot-session-token": token,
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({ model: modelId, input: "hello" }),
  })

  expect(response.status).toBe(200)
  expect(upstreamSessionTokens).toEqual([{ path: "/responses", token: null }])
})

test("fails closed after a no-affinity account-order change", async () => {
  const modelId = "session-continuity-account-order"
  const accountA = registerAccount({
    accountId: 52_401,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-a;exp=1900000000",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-b;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  expect(tokenPool.getHealthyAccountBySession()?.id).toBe(accountA.id)
  const token = sessionToken({ modelId, subject: "issuer-a" })

  tokenPool.removeAccountForTest(accountA.id)
  registerAccount({
    accountId: 52_401,
    endpoints: ["/responses"],
    modelId,
    token: "tid=issuer-a;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  expect(tokenPool.getAccountForModelBySession(modelId)?.id).toBe(52_402)

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "copilot-session-token": token,
    },
    body: JSON.stringify({ model: modelId, input: "hello" }),
  })

  expect(response.status).toBe(200)
  expect(upstreamSessionTokens).toEqual([{ path: "/responses", token: null }])
})

test("pins an unidentified forwarded session token instead of failing over to another issuer", async () => {
  const modelId = "session-continuity-unidentified-failover"
  registerAccount({
    accountId: 52_401,
    endpoints: ["/chat/completions"],
    modelId,
    token: "tid=issuer-a;exp=1900000000",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: ["/chat/completions"],
    modelId,
    token: "tid=issuer-b;exp=1900000000",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  const token = sessionToken({ modelId, subject: "issuer-a" })
  queuedFetchResults.push(new Response("forbidden", { status: 403 }))

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "copilot-session-token": token,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(403)
  expect(upstreamSessionTokens).toEqual([{ path: "/chat/completions", token }])
  expect(upstreamRequests).toEqual([
    {
      authorization: "Bearer tid=issuer-a;exp=1900000000",
      path: "/chat/completions",
    },
  ])
})

test.each([
  "exp=1900000000",
  "tid=issuer-a;tid=issuer-a",
  "tid=issuer-a=ambiguous;exp=1900000000",
] as const)(
  "omits a model-matched token when the selected account issuer is unprovable: %s",
  async (accountToken) => {
    const modelId = "session-continuity-unprovable-account"
    registerAccount({
      accountId: 52_401,
      endpoints: ["/responses"],
      modelId,
      token: accountToken,
    })
    tokenPool.rebuildModelIndex()
    state.models = tokenPool.getAllModels()

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "copilot-session-token": sessionToken({
          modelId,
          subject: "issuer-a",
        }),
      },
      body: JSON.stringify({ model: modelId, input: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(upstreamSessionTokens).toEqual([{ path: "/responses", token: null }])
  },
)

afterEach(() => {
  for (const accountId of testAccountIds) {
    tokenPool.removeAccountForTest(accountId)
  }
  testAccountIds.clear()
  state.models = originalModels
  state.isMultiToken = false
})

test("Chat routes from the affinity-selected account's raw endpoint catalog", async () => {
  const modelId = "account-aware-chat"
  const affinityKey = installConflictingCatalogs({
    first: ["/chat/completions"],
    modelId,
    second: ["/responses"],
  })

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toEqual([
    {
      authorization: "Bearer second-account-token",
      path: "/responses",
    },
  ])
})

test("Responses routes from the affinity-selected account's raw endpoint catalog", async () => {
  const modelId = "account-aware-responses"
  const affinityKey = installConflictingCatalogs({
    first: ["/responses"],
    modelId,
    second: ["/chat/completions"],
  })

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({ model: modelId, input: "hello" }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toEqual([
    {
      authorization: "Bearer second-account-token",
      path: "/chat/completions",
    },
  ])
})

test("Messages routes from the affinity-selected account's raw endpoint catalog", async () => {
  const modelId = "account-aware-messages"
  const affinityKey = installConflictingCatalogs({
    first: ["/v1/messages"],
    modelId,
    second: ["/responses"],
  })

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toEqual([
    {
      authorization: "Bearer second-account-token",
      path: "/responses",
    },
  ])
})

test("unidentified failover skips accounts that do not advertise the chosen endpoint", async () => {
  const modelId = "account-aware-failover"
  registerAccount({
    accountId: 52_401,
    endpoints: ["/chat/completions"],
    modelId,
    token: "first-account-token",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: ["/responses"],
    modelId,
    token: "wrong-endpoint-token",
  })
  registerAccount({
    accountId: 52_403,
    endpoints: ["/chat/completions"],
    modelId,
    token: "eligible-failover-token",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  fetchMock.mockImplementationOnce((url, init) => {
    const request = toRequest(url, init)
    upstreamRequests.push({
      authorization: request.headers.get("authorization"),
      path: new URL(request.url).pathname,
    })
    return new Response("forbidden", { status: 403 })
  })

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toEqual([
    {
      authorization: "Bearer first-account-token",
      path: "/chat/completions",
    },
    {
      authorization: "Bearer eligible-failover-token",
      path: "/chat/completions",
    },
  ])
})

test("does not resend after refresh removes the chosen endpoint", async () => {
  const modelId = "account-aware-refresh"
  registerAccount({
    accountId: 52_401,
    endpoints: ["/chat/completions"],
    modelId,
    token: "expired-account-token",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  queuedFetchResults.push(
    new Response("unauthorized", { status: 401 }),
    Response.json({
      expires_at: 1_900_000_000,
      refresh_in: 1800,
      token: "refreshed-account-token",
    }),
    Response.json({
      object: "list",
      data: [createModel(modelId, ["/responses"])],
    }),
  )

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot account no longer advertises the chosen endpoint.",
      type: "invalid_request_error",
    },
  })
  expect(upstreamRequests.map((request) => request.path)).toEqual([
    "/chat/completions",
    "/copilot_internal/v2/token",
    "/models",
  ])
  expect(
    upstreamRequests.filter((request) => request.path === "/chat/completions"),
  ).toHaveLength(1)
})

test.each(["/chat/completions", "/responses", "/v1/messages"] as const)(
  "rejects stale %s endpoint authority at the shared account transport boundary",
  async (path) => {
    const modelId = `account-aware-stale-${path.replaceAll("/", "-")}`
    const account = registerAccount({
      accountId: 52_401,
      endpoints: [path],
      modelId,
      token: "selected-account-token",
    })
    tokenPool.rebuildModelIndex()
    state.models = tokenPool.getAllModels()
    const selection = selectRoutedModel(modelId)
    expect(selection.accountPin?.accountId).toBe(account.id)

    account.modelsData = [
      createModel(
        modelId,
        path === "/responses" ? ["/chat/completions"] : ["/responses"],
      ),
    ]

    let thrown: unknown
    try {
      await runWithRoutedModelSelection(selection, async () => {
        await routedFetch(
          path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: modelId }),
          },
          { modelId },
        )
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(LocalHTTPError)
    expect((thrown as LocalHTTPError).clientBody).toEqual({
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot account no longer advertises the chosen endpoint.",
        type: "invalid_request_error",
      },
    })
    expect(upstreamRequests).toEqual([])
  },
)

test("rejects dispatch when the selected account model row disappears", async () => {
  const modelId = "account-aware-missing-row"
  const account = registerAccount({
    accountId: 52_401,
    endpoints: ["/responses"],
    modelId,
    token: "selected-account-token",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  const selection = selectRoutedModel(modelId)
  expect(selection.accountPin?.accountId).toBe(account.id)
  account.modelsData = []

  let thrown: unknown
  try {
    await runWithRoutedModelSelection(selection, async () => {
      await routedFetch(
        "/responses",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: modelId }),
        },
        { modelId },
      )
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({
    clientBody: {
      error: { code: "endpoint_translation_unsupported" },
    },
  })
  expect(upstreamRequests).toEqual([])
})

test("revalidates native Messages authority after asynchronous attachment preparation", async () => {
  const modelId = "account-aware-messages-pre-send"
  const account = registerAccount({
    accountId: 52_401,
    endpoints: ["/v1/messages"],
    modelId,
    token: "selected-account-token",
  })
  registerAccount({
    accountId: 52_402,
    endpoints: ["/v1/messages"],
    modelId,
    token: "alternate-account-token",
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  const affinityKey = Array.from(
    { length: 10_000 },
    (_, index) => `pre-send-affinity-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      === account.id,
  )
  if (!affinityKey) throw new TypeError("Expected selected-account affinity")
  let catalogMutated = false
  onAttachmentFetch = () => {
    catalogMutated = true
    account.modelsData = [createModel(modelId, ["/responses"])]
  }

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-session-id": affinityKey,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://attachment.test/a.png",
              },
            },
          ],
        },
      ],
    }),
  })

  expect(catalogMutated).toBe(true)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    type: "error",
    error: {
      code: "endpoint_translation_unsupported",
      message: "The Copilot Messages request was rejected.",
      type: "invalid_request_error",
    },
  })
  expect(upstreamRequests.map((request) => request.path)).toEqual(["/a.png"])
  expect(
    upstreamRequests.filter((request) =>
      ["/chat/completions", "/responses", "/v1/messages"].includes(
        request.path,
      ),
    ),
  ).toEqual([])
})
