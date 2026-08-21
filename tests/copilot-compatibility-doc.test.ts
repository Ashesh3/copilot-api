import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { unzipSync } from "fflate"
import { Hono } from "hono"
import fs, { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  ERROR_ENVELOPE_CONTRACT,
  getGoogleRoutingContractRows,
  RECOVERY_TARGET_CONTRACT,
  SESSION_TOKEN_PRIVACY_CONTRACT,
  STREAM_BEHAVIOR_CONTRACT,
} from "~/lib/compatibility-contract"
import { createConfigExportZip } from "~/lib/config-export"
import {
  type CopilotContractEvent,
  recordCopilotContractEvent,
} from "~/lib/copilot-contract-observability"
import {
  sessionTokenMatchesAccount,
  sessionTokenMatchesModel,
} from "~/lib/copilot-session-token"
import {
  getModelEndpointSupport,
  selectCopilotEndpoint,
} from "~/lib/endpoint-routing"
import { HTTPError, forwardError } from "~/lib/error"
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  startLlmDebugLog,
} from "~/lib/llm-debug-log"
import { sanitizeHandlerLogArguments } from "~/lib/logger"
import { state } from "~/lib/state"
import { copilotControlPlaneRoutes } from "~/routes/copilot-control-plane/route"
import { forwardMessagesError } from "~/routes/messages/error"
import { server } from "~/server"
import { COPILOT_API_VERSION } from "~/services/copilot/copilot-contract"

const documentPath = new URL(
  "../docs/copilot-api-compatibility.md",
  import.meta.url,
)
const readmePath = new URL("../README.md", import.meta.url)

const requiredHeadings = [
  "## Contract version and source precedence",
  "## Public route and alias table",
  "## Model discovery and endpoint routing",
  "## Responses accepted, normalized, rejected, and local fields",
  "## Messages body, header, and count-tokens behavior",
  "## Chat compatibility behavior",
  "## Streaming and WebSocket termination and continuation semantics",
  "## Multi-account and session-token constraints",
  "## Intentional gateway extensions",
  "## Error privacy and LLM Debug exception",
  "## Verification matrix and last-audited date",
  "## Residual feature-flag, account, and provider limitations",
] as const

const routeMatrix = [
  { method: "GET", canonical: "/v1/models", alias: "/models" },
  {
    method: "GET",
    canonical: "/v1/models/:model",
    alias: "/models/:model",
  },
  {
    method: "POST",
    canonical: "/v1/models/:model/policy",
    alias: "/models/:model/policy",
  },
  {
    method: "POST",
    canonical: "/v1/chat/completions",
    alias: "/chat/completions",
  },
  { method: "POST", canonical: "/v1/responses", alias: "/responses" },
  {
    method: "POST",
    canonical: "/v1/responses/compact",
    alias: "/responses/compact",
  },
  { method: "POST", canonical: "/v1/messages" },
  { method: "POST", canonical: "/v1/messages/count_tokens" },
  { method: "POST", canonical: "/v1/embeddings", alias: "/embeddings" },
  {
    method: "POST",
    canonical: "/v1/alpha/search",
    alias: "/alpha/search",
  },
] as const

const googleDocumentedRoutes = [
  "/v1beta/models/:model:generateContent",
  "/v1/models/:model:generateContent",
  "/models/:model:generateContent",
  "/v1beta/models/:model:streamGenerateContent",
  "/v1/models/:model:streamGenerateContent",
  "/models/:model:streamGenerateContent",
] as const

const representativeForbiddenModelIds = `o1 o3-mini codex-mini-latest
claude-3-7-sonnet-latest claude-4-sonnet claude-sonnet-4
claude-opus-4-1-20250805 gpt-4.1 gpt-* gpt-oss-120b gpt-image-1
chatgpt-4o-latest text-embedding-3-small text-embedding-ada-002
gemini-2.5-pro gemini-pro dall-e-3 omni-moderation-latest
grok-3 grok-3-mini deepseek-r1 deepseek-v3.1 deepseek-chat llama-3.3-70b-instruct
meta-llama/Llama-3.1-405B-Instruct Qwen/Qwen3-235B-A22B qwen2.5-coder-32b
mistral-large-2411 mistral-large-latest qwen-max codestral-2501
microsoft/Phi-4-mini-instruct phi-3.5-mini-instruct
deepseek/deepseek-chat mistralai/mistral-large-latest qwen/qwen-max x-ai/grok-3`.split(
  /\s+/,
)

const allowedModelLanguage = `GPT-compatible clients|Codex-compatible transport
Claude-compatible API|Gemini-compatible clients|GPT family|Claude models
Codex workflows|OpenAI-compatible providers|ChatGPT-compatible clients
Claude-Sonnet-compatible clients|Codex-model discovery|GPT-5-series models
Gemini-compatible transports|Use model from discovery.|Use model-id from discovery.
Use MODEL_ID from discovery.|Use requestedModel from discovery.
POST /models/:model:generateContent|Grok-compatible clients|DeepSeek models
Llama-compatible APIs|Qwen family|Mistral-based providers|Phi models
latest model generation|large language models|chat capability|maximum output`.split(
  /\s*\|\s*|\n/,
)

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/g, " ").trim()

function registeredRoutes(): Set<string> {
  return new Set(server.routes.map((route) => `${route.method} ${route.path}`))
}

function googleRouteMatrix(): Record<string, string> {
  return Object.fromEntries(
    getGoogleRoutingContractRows().map(({ behavior, surface }) => [
      surface,
      behavior,
    ]),
  )
}

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`
}

function textTokens(value: string): Array<string> {
  const codeSpans = [...value.matchAll(/`+([^`]+)`+/g)].flatMap(
    (match) => match[1].match(/[A-Z0-9][\w./:*[\]-]*/gi) ?? [],
  )
  const prose = value.replaceAll(/`+[^`]+`+/g, " ")
  const proseTokens = prose.match(/[A-Z0-9][\w./:*[\]-]*/gi) ?? []
  return [...codeSpans, ...proseTokens]
}

function stripModelTokenSuffix(token: string): string {
  const withoutAction = token.replace(
    /:(?:countTokens|generateContent|streamGenerateContent)$/i,
    "",
  )
  const routeMatch = /(?:^|\/)models\/(.+)$/i.exec(withoutAction)
  return routeMatch?.[1] ?? withoutAction
}

function hasGenericModelSuffix(token: string): boolean {
  return /-(?:api|based|class|compatible|family|models?|series|style|transport|workflows?)$/i.test(
    token,
  )
}

function isProviderQualifiedStaticModelIdentifier(token: string): boolean {
  return (
    /^(?:meta-llama\/llama|microsoft\/phi)(?:-|(?=\d))(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(
      token,
    )
    || /^deepseek\/deepseek-(?:chat|coder|reasoner|r\d|v\d|(?=[\w.:[\]-]*\d)[\w.:[\]-]+)$/i.test(
      token,
    )
    || /^mistralai\/mistral-(?:large|medium|small|nemo|saba)(?:-[\w.:[\]-]+)?$/i.test(
      token,
    )
    || /^qwen\/qwen(?:-|(?=\d))(?:(?=[\w.:[\]-]*\d)[\w.:[\]-]+|max(?:-[\w.:[\]-]+)?)$/i.test(
      token,
    )
    || /^x-ai\/grok-(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(token)
  )
}

function isStaticModelIdentifier(token: string): boolean {
  const normalized = stripModelTokenSuffix(token).toLowerCase()
  if (hasGenericModelSuffix(normalized)) return false
  return (
    /^gpt-(?:\*|(?=[\w.:[\]-]*\d)[\w.:[\]-]+)$/i.test(normalized)
    || /^chatgpt-(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(normalized)
    || /^o\d(?:-[a-z0-9][\w.:[\]-]*)?$/i.test(normalized)
    || /^codex-(?:(?=[\w.:[\]-]*\d)[\w.:[\]-]+|mini(?:-[\w.:[\]-]+)?|latest|preview)$/i.test(
      normalized,
    )
    || /^claude-(?:\d|sonnet|opus|haiku)[\w.:[\]-]*$/i.test(normalized)
    || /^gemini-(?:\d[\w.:[\]-]*|pro|flash|nano|ultra)$/i.test(normalized)
    || /^(?:text-embedding|text-moderation)-[a-z0-9][\w.:[\]-]*$/i.test(
      normalized,
    )
    || /^(?:babbage|davinci|dall-e|tts|whisper)-[a-z0-9][\w.:[\]-]*$/i.test(
      normalized,
    )
    || /^omni-moderation-[a-z0-9][\w.:[\]-]*$/i.test(normalized)
    || /^(?:grok|llama|codestral|phi)-(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(
      normalized,
    )
    || /^deepseek-(?:chat|coder|reasoner|r\d|v\d|(?=[\w.:[\]-]*\d)[\w.:[\]-]+)$/i.test(
      normalized,
    )
    || /^mistral-(?:large|medium|small|nemo|saba)(?:-[\w.:[\]-]+)?$/i.test(
      normalized,
    )
    || /^qwen(?:-|(?=\d))(?:(?=[\w.:[\]-]*\d)[\w.:[\]-]+|max(?:-[\w.:[\]-]+)?)$/i.test(
      normalized,
    )
    || isProviderQualifiedStaticModelIdentifier(normalized)
  )
}

function staticModelIdentifiers(value: string): Array<string> {
  return [
    ...new Set(
      textTokens(value)
        .filter((token) => isStaticModelIdentifier(token))
        .map((token) => stripModelTokenSuffix(token)),
    ),
  ]
}

async function withTempDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compat-doc-"))
  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function failingNativeStream(path: string, privateMarker: string): Response {
  const encoder = new TextEncoder()
  let timeout: ReturnType<typeof setTimeout> | undefined
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        if (timeout !== undefined) clearTimeout(timeout)
      },
      start(controller) {
        const firstEvent =
          path.endsWith("/chat/completions") ?
            `data: ${JSON.stringify({
              id: "chat-placeholder",
              object: "chat.completion.chunk",
              created: 1,
              model: "model-placeholder",
              choices: [
                {
                  index: 0,
                  delta: { content: "partial-chat" },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          : `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              sequence_number: 1,
              item_id: "message-placeholder",
              output_index: 0,
              content_index: 0,
              delta: "buffered-responses-delta",
            })}\n\n`
        controller.enqueue(encoder.encode(firstEvent))
        timeout = setTimeout(
          () => controller.error(new Error(privateMarker)),
          25,
        )
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

async function probeThrownNativeStreamFailures(privateMarker: string): Promise<{
  chatBody: string
  responsesBody: string
}> {
  const originalFetch = globalThis.fetch
  const originalState = {
    accountType: state.accountType,
    copilotToken: state.copilotToken,
    githubToken: state.githubToken,
    isMultiToken: state.isMultiToken,
    manualApprove: state.manualApprove,
    models: state.models,
  }
  const consoleError = spyOn(console, "error").mockImplementation(() => {})

  state.accountType = "individual"
  state.copilotToken = "token-placeholder"
  state.githubToken = "token-placeholder"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "model-placeholder",
        name: "Model Placeholder",
        object: "model",
        preview: false,
        vendor: "placeholder",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions", "/responses"],
        capabilities: {
          family: "placeholder",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  globalThis.fetch = ((url: string | URL | Request) => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    return Promise.resolve(
      failingNativeStream(new URL(rawUrl).pathname, privateMarker),
    )
  }) as typeof fetch

  try {
    const chat = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model-placeholder",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    })
    const responses = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model-placeholder",
        input: "hello",
        stream: true,
      }),
    })
    expect(chat.status).toBe(200)
    expect(responses.status).toBe(200)
    return {
      chatBody: await chat.text(),
      responsesBody: await responses.text(),
    }
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
    Object.assign(state, originalState)
    consoleError.mockRestore()
  }
}

// The behavior matrix intentionally probes every public diagnostic boundary.

async function deriveCompatibilityMatrix(): Promise<{
  errors: Record<string, string>
  privacy: Record<string, string>
  streams: Record<string, string>
}> {
  const privateMarker = "compatibility-private-marker"
  const nativeFailures = await probeThrownNativeStreamFailures(privateMarker)
  expect(nativeFailures.chatBody).toContain("partial-chat")
  expect(nativeFailures.chatBody).not.toContain("event: error")
  expect(nativeFailures.chatBody).not.toContain(privateMarker)
  expect(nativeFailures.responsesBody).not.toContain("buffered-responses-delta")
  expect(nativeFailures.responsesBody).not.toContain("event: error")
  expect(nativeFailures.responsesBody).not.toContain(privateMarker)

  clearLlmDebugLogs()
  const token = jwt({ selected_model: "model-placeholder" })
  try {
    const debugId = startLlmDebugLog({
      method: "POST",
      path: "/responses",
      requestBody: "{}",
      requestHeaders: { "Copilot-Session-Token": token },
      url: "https://example.test/responses",
    })
    expect(
      getLlmDebugLog(debugId)?.request.headers["Copilot-Session-Token"],
    ).toBe(token)
  } finally {
    clearLlmDebugLogs()
  }

  expect(
    sanitizeHandlerLogArguments([{ "Copilot-Session-Token": token }]),
  ).toEqual([{ "Copilot-Session-Token": "[REDACTED]" }])

  const debugLog = spyOn(consola, "debug")
  const breadcrumb = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )
  try {
    recordCopilotContractEvent({
      kind: "endpoint_route",
      source: "responses",
      target: "/responses",
      translated: false,
      reason: "native",
      "Copilot-Session-Token": token,
    } as unknown as CopilotContractEvent)
    expect(
      JSON.stringify([debugLog.mock.calls, breadcrumb.mock.calls]),
    ).not.toContain(token)
  } finally {
    debugLog.mockRestore()
    breadcrumb.mockRestore()
  }

  await withTempDirectory(async (directory) => {
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ "Copilot-Session-Token": token }),
    )
    const archive = await createConfigExportZip({ appDir: directory })
    const config = new TextDecoder().decode(
      unzipSync(archive.zip)["config.json"],
    )
    expect(config).toContain("[REDACTED]")
    expect(config).not.toContain(token)
  })

  expect(
    sessionTokenMatchesModel({
      token,
      requestedModel: "model-placeholder",
      finalModel: "model-placeholder",
      modelWasRedirected: false,
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesModel({
      token,
      requestedModel: "model-placeholder",
      finalModel: "different-placeholder",
      modelWasRedirected: false,
    }),
  ).toBe(false)
  const issuerToken = jwt({
    selected_model: "model-placeholder",
    sub: "issuer-placeholder",
  })
  expect(
    sessionTokenMatchesAccount({
      accountToken: "tid=issuer-placeholder;exp=1900000000",
      sessionToken: issuerToken,
    }),
  ).toBe(true)
  expect(
    sessionTokenMatchesAccount({
      accountToken: "tid=other-placeholder;exp=1900000000",
      sessionToken: issuerToken,
    }),
  ).toBe(false)

  const error = new HTTPError(
    `private upstream error ${token}`,
    Response.json(
      { error: { message: `${privateMarker} ${token}` } },
      { status: 500 },
    ),
  )
  const errorLog = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  const openAIApp = new Hono()
  openAIApp.get("/error", async (c) => await forwardError(c, error))
  const messagesApp = new Hono()
  messagesApp.get("/error", async (c) => await forwardMessagesError(c, error))
  try {
    const openAIBody = (await (
      await openAIApp.request("/error")
    ).json()) as Record<string, unknown>
    const messagesBody = (await (
      await messagesApp.request("/error")
    ).json()) as Record<string, unknown>
    expect(openAIBody).toEqual({
      error: { message: "Upstream request failed", type: "error" },
    })
    expect(messagesBody).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "The Copilot Messages request failed.",
      },
    })
    expect(
      JSON.stringify([
        openAIBody,
        messagesBody,
        errorLog.mock.calls,
        captureException.mock.calls,
      ]),
    ).not.toContain(token)
    expect(JSON.stringify([openAIBody, messagesBody])).not.toContain(
      privateMarker,
    )
  } finally {
    errorLog.mockRestore()
    captureException.mockRestore()
  }

  const messagePaths = [...registeredRoutes()]
    .filter((route) => route.startsWith("POST /v1/messages"))
    .map((route) => route.slice("POST ".length))
    .filter((route) => !route.includes(":"))
    .sort()
  expect(messagePaths).toEqual(["/v1/messages", "/v1/messages/count_tokens"])

  return {
    errors: Object.fromEntries(
      ERROR_ENVELOPE_CONTRACT.map((row) => [row.surface, row.behavior]),
    ),
    privacy: Object.fromEntries(
      SESSION_TOKEN_PRIVACY_CONTRACT.map((row) => [row.surface, row.behavior]),
    ),
    streams: Object.fromEntries(
      STREAM_BEHAVIOR_CONTRACT.map((row) => [row.surface, row.behavior]),
    ),
  }
}

function expectMatrixRows(
  document: string,
  matrix: Record<string, string>,
): void {
  const normalized = normalizeWhitespace(document)
  for (const [surface, behavior] of Object.entries(matrix)) {
    expect(normalized).toContain(`| ${surface} | ${behavior} |`)
  }
}

function documentContractTable(
  document: string,
  marker: string,
): Array<[string, string]> {
  const match = new RegExp(
    `<!-- compatibility-contract:${marker}:start -->\\s*([\\s\\S]*?)\\s*<!-- compatibility-contract:${marker}:end -->`,
  ).exec(document)
  if (!match)
    throw new Error(`Missing compatibility contract marker: ${marker}`)

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("|")
        && !/^\|\s*(?:Surface|Google request condition|---)/i.test(line),
    )
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replaceAll("`", ""))
      if (cells.length !== 2) {
        throw new Error(`Expected two contract columns: ${line}`)
      }
      return [cells[0], cells[1]]
    })
}

test("documents the registered route matrix and reviewed endpoint authority", async () => {
  const text = await readFile(documentPath, "utf8")
  const normalizedText = normalizeWhitespace(text)
  const routes = registeredRoutes()

  for (const heading of requiredHeadings) expect(text).toContain(heading)
  expect(text).toContain(`\`${COPILOT_API_VERSION}\``)

  for (const route of routeMatrix) {
    expect(routes).toContain(`${route.method} ${route.canonical}`)
    expect(text).toContain(`\`${route.method} ${route.canonical}\``)
    if ("alias" in route) {
      expect(routes).toContain(`${route.method} ${route.alias}`)
      expect(text).toContain(`\`${route.method} ${route.alias}\``)
    }
  }

  for (const route of copilotControlPlaneRoutes.routes) {
    expect(routes).toContain(`${route.method} ${route.path}`)
    expect(text).toContain(`\`${route.method} ${route.path}\``)
  }

  for (const route of googleDocumentedRoutes) {
    expect(text).toContain(`\`POST ${route}\``)
  }
  expect(text).not.toContain(":countTokens")
  expectMatrixRows(text, googleRouteMatrix())
  expect(normalizedText).toContain(
    "Only `generateContent` and `streamGenerateContent` are supported public Google actions.",
  )
  expect(normalizedText).toContain(
    "A missing action suffix or any other suffix, including `countTokens`, returns a local Google `400` before body parsing or upstream dispatch.",
  )
  expect(normalizedText).toContain(
    "Ordinary request, authentication, console, and Sentry diagnostics use the Google route template instead of the model/action segment, and debug logging does not inspect bodies for unsupported actions.",
  )

  const legacySupport = getModelEndpointSupport({})
  expect(legacySupport).toMatchObject({
    chat: true,
    messages: false,
    responses: false,
  })
  expect(normalizedText).toContain(
    "Live `supported_endpoints` metadata is authoritative for inference routing.",
  )
  expect(normalizedText).toContain(
    "A model record that omits `supported_endpoints` receives the legacy `/chat/completions` assumption only.",
  )

  const nativeDecision = selectCopilotEndpoint({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/chat/completions", "/responses"],
    }),
    candidates: [
      {
        endpoint: "/responses",
        reason: "endpoint_unavailable",
        check: { blockers: [], supported: true },
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        check: { blockers: [], supported: true },
      },
    ],
  })
  expect(nativeDecision).toMatchObject({
    reason: "native",
    target: "/responses",
    translated: false,
  })
  expect(text).toContain(
    "prefer the caller's native dialect when the selected model advertises it",
  )
  expect(text).toContain("endpoint_translation_unsupported")
})

test("documents behavior-derived stream, privacy, and error matrices", async () => {
  const document = await readFile(documentPath, "utf8")
  const matrix = await deriveCompatibilityMatrix()

  expectMatrixRows(document, matrix.streams)
  expectMatrixRows(document, matrix.privacy)
  expectMatrixRows(document, matrix.errors)
})

test("enumerates the superseding upstream-error and attachment recovery targets", () => {
  expect(RECOVERY_TARGET_CONTRACT).toEqual([
    {
      surface: "Final non-empty upstream HTTP error body",
      behavior:
        "exact in normal client, ordinary logs, and Sentry; preserve upstream status and content type",
    },
    {
      surface: "Runtime-valid absolute HTTP(S) attachment/file URL",
      behavior:
        "fetchable without destination, DNS, IP, or redirect-target filtering; abort, time, byte, and redirect limits remain",
    },
  ])
})

test("documents the exact structured stream and privacy contract", async () => {
  const document = await readFile(documentPath, "utf8")
  const matrix = await deriveCompatibilityMatrix()

  expect(documentContractTable(document, "google-routing")).toEqual(
    getGoogleRoutingContractRows().map(({ behavior, surface }) => [
      surface,
      behavior,
    ]),
  )
  expect(documentContractTable(document, "stream-behavior")).toEqual(
    Object.entries(matrix.streams),
  )
  expect(documentContractTable(document, "session-token-privacy")).toEqual(
    Object.entries(matrix.privacy),
  )
  expect(documentContractTable(document, "error-envelope")).toEqual(
    Object.entries(matrix.errors),
  )
})

test("links the compatibility report from README", async () => {
  const text = await readFile(readmePath, "utf8")
  expect(text).toContain(
    "[detailed Copilot API compatibility contract](docs/copilot-api-compatibility.md)",
  )
})

test("detects concrete model IDs without flagging generic compatibility language", async () => {
  const document = await readFile(documentPath, "utf8")

  expect(staticModelIdentifiers(document)).toEqual([])
  const falseNegativeTable = representativeForbiddenModelIds.flatMap(
    (model) => [
      { expected: model, snippet: `Use ${model} for this request.` },
      { expected: model, snippet: `Use \`${model}\` for this request.` },
      { expected: model, snippet: `\`\`\`text\n${model}\n\`\`\`` },
      { expected: model, snippet: JSON.stringify({ model }) },
      {
        expected: model,
        snippet: `POST /v1/models/${model}:generateContent`,
      },
    ],
  )
  for (const { expected, snippet } of falseNegativeTable) {
    expect(staticModelIdentifiers(snippet)).toContain(expected)
  }
  for (const snippet of allowedModelLanguage) {
    expect(staticModelIdentifiers(snippet)).toEqual([])
  }
})

test("keeps the mounted Messages status oracle independent of production contract values", async () => {
  const source = await readFile(
    new URL("./messages-stream-lifecycle.test.ts", import.meta.url),
    "utf8",
  )

  expect(source).not.toContain("ANTHROPIC_HTTP_ERROR_STATUS_TYPES")
  for (const [status, type] of [
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
  ] as const) {
    expect(source).toContain(`[${status}, "${type}"]`)
  }
})

test("contains no private paths, credentials, hosts, or raw data", async () => {
  const text = await readFile(documentPath, "utf8")

  for (const forbidden of [
    "github_pat_",
    "gho_",
    "ghp_",
    "sk-",
    "Bearer ",
    "10.0.0.",
    "internal-host.tld",
    "api.githubcopilot.com",
    "private-upstream-marker",
    "raw prompt",
    "raw user data",
  ]) {
    expect(text).not.toContain(forbidden)
  }

  expect(text).not.toMatch(/[A-Z]:\\(?:Projects|Users)\\/i)
  expect(text).not.toMatch(/\/(?:home|root|Users)\/[\w.-]+\//)
  expect(text).not.toMatch(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/,
  )
})
