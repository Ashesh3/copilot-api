import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { unzipSync } from "fflate"
import { Hono } from "hono"
import fs, { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createConfigExportZip } from "~/lib/config-export"
import {
  type CopilotContractEvent,
  recordCopilotContractEvent,
} from "~/lib/copilot-contract-observability"
import { sessionTokenMatchesModel } from "~/lib/copilot-session-token"
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
import {
  createAnthropicStreamError,
  forwardMessagesError,
} from "~/routes/messages/error"
import { emitResponsesFailureAsStream } from "~/routes/messages/web-search-helpers"
import { server } from "~/server"
import { COPILOT_API_VERSION } from "~/services/copilot/copilot-contract"
import { sanitizeResponsesStreamEvent } from "~/services/copilot/create-responses"

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

const representativeForbiddenModelIds = [
  "o1",
  "o3-mini",
  "codex-mini-latest",
  "claude-3-7-sonnet-latest",
  "claude-4-sonnet",
  "gpt-4.1",
  "gpt-*",
] as const

const genericModelPlaceholders = [
  "model",
  "models",
  "model-id",
  "MODEL_ID",
  "requestedModel",
  ":model",
] as const

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/g, " ").trim()

function registeredRoutes(): Set<string> {
  return new Set(server.routes.map((route) => `${route.method} ${route.path}`))
}

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`
}

function textTokens(value: string): Array<string> {
  return value.match(/[A-Z0-9][\w.:*[\]-]*/gi) ?? []
}

function isStaticModelIdentifier(token: string): boolean {
  return (
    /^gpt-(?:\*|[a-z0-9][\w.:*[\]-]*)$/i.test(token)
    || /^o\d(?:-[a-z0-9][\w.:*[\]-]*)?$/i.test(token)
    || /^codex-[a-z0-9][\w.:*[\]-]*$/i.test(token)
    || /^claude-(?:\d|sonnet|opus|haiku)[\w.:*[\]-]*$/i.test(token)
    || /^gemini-\d[\w.:*[\]-]*$/i.test(token)
  )
}

function staticModelIdentifiers(value: string): Array<string> {
  return [
    ...new Set(
      textTokens(value).filter((token) => isStaticModelIdentifier(token)),
    ),
  ]
}

function sentences(value: string): Array<string> {
  return normalizeWhitespace(value)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function blanketStreamClaims(value: string): Array<string> {
  return sentences(value).filter((sentence) => {
    const lower = sentence.toLowerCase()
    const committed =
      /after (?:http )?headers|post-commit|late stream|once (?:the )?(?:response|stream) (?:starts|begins)|following commitment/.test(
        lower,
      )
    const failure = /failures?|errors?/.test(lower)
    const universal =
      /\b(?:all|always|every|invariably|necessarily|the source protocol)\b|without exception/.test(
        lower,
      )
    const inBand =
      /in-band|error event|event stream|sent (?:to|on) the (?:client|stream)|protocol event/.test(
        lower,
      )
    return committed && failure && universal && inBand
  })
}

function blanketTokenPrivacyClaims(value: string): Array<string> {
  return sentences(value).filter((sentence) => {
    const lower = sentence.toLowerCase()
    const token = /session token|copilot-session-token/.test(lower)
    const blanket =
      /never (?:logged|captured|exposed|stored)|cannot appear|no .*diagnostic.*(?:captures?|contains?)/.test(
        lower,
      )
    const scoped = /ordinary|outside llm debug|except|administrator-only/.test(
      lower,
    )
    return token && blanket && !scoped
  })
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

async function deriveCompatibilityMatrix(): Promise<{
  errors: Record<string, string>
  privacy: Record<string, string>
  streams: Record<string, string>
}> {
  const privateMarker = "compatibility-private-marker"
  const anthropicStreamError = createAnthropicStreamError(
    new Error(privateMarker),
  )
  expect(JSON.stringify(anthropicStreamError)).not.toContain(privateMarker)

  const syntheticEvents: Array<{ data: string; event?: string }> = []
  await emitResponsesFailureAsStream(
    {
      writeSSE: (event) => {
        syntheticEvents.push(event)
        return Promise.resolve()
      },
    },
    { model: "model-placeholder", responseId: "response-placeholder" },
  )

  const terminal = sanitizeResponsesStreamEvent({
    event: "response.failed",
    data: JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: { message: privateMarker },
      },
    }),
  })
  expect(terminal.data).not.toContain(privateMarker)

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

  return {
    errors: {
      "Chat and Responses HTTP":
        "OpenAI/Copilot envelope with fixed safe message",
      "Messages and count-tokens HTTP":
        "Anthropic envelope with fixed safe message",
    },
    privacy: {
      "Administrator-only LLM Debug": "exact forwarded token may be captured",
      "Ordinary handler logs": "session token value is redacted",
      "Configuration export": "token-keyed values are redacted",
      "Inference forwarding": "only a matching unredirected model receives it",
    },
    streams: {
      "Messages handled failure": "safe Anthropic error event",
      "Synthetic Responses-from-Messages failure": "error then response.failed",
      "Native Responses terminal event": "sanitized protocol terminal event",
      "Thrown native Chat transport failure":
        "written chunks then close without synthesized error event",
      "Thrown native Responses transport failure":
        "buffered unwritten chunks may be absent when the stream closes",
    },
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

test("rejects adversarial blanket stream and session-token claims", async () => {
  const document = await readFile(documentPath, "utf8")

  expect(blanketStreamClaims(document)).toEqual([])
  expect(blanketTokenPrivacyClaims(document)).toEqual([])

  for (const claim of [
    "After headers are committed, all failures use an in-band error event.",
    "Every late stream error is sent through the source protocol error event.",
    "Post-commit failures always become in-band protocol errors.",
    "Following commitment, stream failures invariably appear in the event stream.",
    "Once the response starts, errors are sent to the client as protocol events without exception.",
  ]) {
    expect(blanketStreamClaims(claim)).toEqual([claim])
  }
  for (const claim of [
    "The session token is never logged or captured.",
    "Copilot-Session-Token cannot appear in diagnostics.",
    "No diagnostic surface ever captures the session token.",
  ]) {
    expect(blanketTokenPrivacyClaims(claim)).toEqual([claim])
  }
  expect(
    blanketTokenPrivacyClaims(
      "Ordinary logs never expose the session token; administrator-only LLM Debug may capture it.",
    ),
  ).toEqual([])
})

test("links the compatibility report from README", async () => {
  const text = await readFile(readmePath, "utf8")
  expect(text).toContain(
    "[detailed Copilot API compatibility contract](docs/copilot-api-compatibility.md)",
  )
})

test("detects static model IDs across prose and code while allowing placeholders", async () => {
  const document = await readFile(documentPath, "utf8")

  expect(staticModelIdentifiers(document)).toEqual([])
  for (const model of representativeForbiddenModelIds) {
    for (const snippet of [
      `Use ${model} for this request.`,
      `Use \`${model}\` for this request.`,
      `\`\`\`text\n${model}\n\`\`\``,
    ]) {
      expect(staticModelIdentifiers(snippet)).toContain(model)
    }
  }
  for (const placeholder of genericModelPlaceholders) {
    expect(
      staticModelIdentifiers(`Use ${placeholder} from discovery.`),
    ).toEqual([])
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
