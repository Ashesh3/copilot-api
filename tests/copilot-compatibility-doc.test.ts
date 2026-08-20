/* eslint-disable max-lines -- compatibility matrices share one live behavior harness */
import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { unzipSync } from "fflate"
import { Hono } from "hono"
import fs, { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Model } from "~/services/copilot/get-models"

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
import { selectGoogleUpstreamEndpoint } from "~/routes/google-ai/handler"
import {
  createAnthropicStreamError,
  forwardMessagesError,
} from "~/routes/messages/error"
import { messageRoutes } from "~/routes/messages/route"
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

const representativeForbiddenModelIds = `o1 o3-mini codex-mini-latest
claude-3-7-sonnet-latest claude-4-sonnet claude-sonnet-4
claude-opus-4-1-20250805 gpt-4.1 gpt-* gpt-oss-120b gpt-image-1
chatgpt-4o-latest text-embedding-3-small text-embedding-ada-002
gemini-2.5-pro gemini-pro dall-e-3 omni-moderation-latest
grok-3 grok-3-mini deepseek-r1 deepseek-v3.1 llama-3.3-70b-instruct
meta-llama/Llama-3.1-405B-Instruct Qwen/Qwen3-235B-A22B qwen2.5-coder-32b
mistral-large-2411 codestral-2501 microsoft/Phi-4-mini-instruct phi-3.5-mini-instruct`.split(
  /\s+/,
)

const allowedModelLanguage = `GPT-compatible clients|Codex-compatible transport
Claude-compatible API|Gemini-compatible clients|GPT family|Claude models
Codex workflows|OpenAI-compatible providers|ChatGPT-compatible clients
Claude-Sonnet-compatible clients|Codex-model discovery|GPT-5-series models
Gemini-compatible transports|Use model from discovery.|Use model-id from discovery.
Use MODEL_ID from discovery.|Use requestedModel from discovery.
POST /models/:model:generateContent|Grok-compatible clients|DeepSeek models
Llama-compatible APIs|Qwen family|Mistral-based providers|Phi models`.split(
  /\s*\|\s*|\n/,
)

const blanketStreamExamples =
  `After headers are committed, all failures use an in-band error event.
Every late stream error is sent through the source protocol error event.
Post-commit failures always become in-band protocol errors.
Following commitment, stream failures invariably appear in the event stream.
Once the response starts, errors are sent to the client as protocol events without exception.
After HTTP headers have been sent, each exception is delivered as an event.
In every case following commitment, disconnects are emitted to the client through the event stream.
Committed-stream errors are universally surfaced as protocol events.
After response bytes are written, any fault is framed as an SSE event.
Once streaming begins, all exceptions are encoded in-band.
All errors after the first byte are represented within the protocol.
Once committed, failures become protocol-native frames.
Late failures are always encoded in the SSE.
Post-header exceptions are reported as stream frames.
After commit. Every failure is returned in-band.
The response has started. Any later error is carried by the event stream.
Headers are already sent | Failures always arrive as protocol events
| After headers are sent | Every failure is reported through a stream event |`.split(
    "\n",
  )

const blanketTokenExamples = `The session token is never logged or captured.
Copilot-Session-Token cannot appear in diagnostics.
No diagnostic surface ever captures the session token.
The session token does not appear in any diagnostic.
Copilot-Session-Token is absent from every diagnostic log.
Session-token values are universally absent from diagnostic output.
\`Copilot-Session-Token\` is guaranteed absent from all diagnostics.
Diagnostics are universally free of session-token values.
All logging and tracing omit Copilot-Session-Token.
The session token never reaches logs or traces.
Copilot-Session-Token is redacted everywhere.
The session token is sensitive. It is never logged or captured.
No logs, traces, or LLM Debug captures contain session credentials.
The session token is sensitive. Every diagnostic redacts it.
Session-token values are secrets | They never appear in logs or traces
Diagnostics contain no credentials. This includes Copilot-Session-Token.
| Session-token | Always redacted in every diagnostic |
Administrator-only LLM Debug exists, but Copilot-Session-Token never appears in any diagnostic.`.split(
  "\n",
)

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/g, " ").trim()

function registeredRoutes(): Set<string> {
  return new Set(server.routes.map((route) => `${route.method} ${route.path}`))
}

function modelWithEndpoints(
  supportedEndpoints: Array<string> | undefined,
  vendor = "placeholder",
): Model {
  return {
    id: "model-placeholder",
    name: "Model Placeholder",
    object: "model",
    preview: false,
    vendor,
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: vendor === "anthropic" ? "claude" : "placeholder",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function googleRouteMatrix(): Record<string, string> {
  const cases = [
    {
      surface: "Ordinary text with Chat advertised",
      endpoints: ["/chat/completions", "/v1/messages", "/responses"],
      vendor: "openai",
    },
    {
      surface:
        "Non-Anthropic, Chat unavailable; Responses and Messages advertised",
      endpoints: ["/v1/messages", "/responses"],
      vendor: "openai",
    },
    {
      surface: "Anthropic, Chat unavailable; Responses and Messages advertised",
      endpoints: ["/v1/messages", "/responses"],
      vendor: "anthropic",
    },
    {
      surface: "Messages-only and lossless",
      endpoints: ["/v1/messages"],
      vendor: "anthropic",
    },
    {
      surface: "Chat-only",
      endpoints: ["/chat/completions"],
      vendor: "openai",
    },
    {
      surface: "Legacy omitted endpoint metadata",
      endpoints: undefined,
      vendor: "openai",
    },
    {
      surface: "No compatible advertised endpoint",
      endpoints: [],
      vendor: "openai",
    },
  ] as const

  return Object.fromEntries(
    cases.map(({ endpoints, surface, vendor }) => {
      const decision = selectGoogleUpstreamEndpoint({
        payload: {
          model: "model-placeholder",
          messages: [{ role: "user", content: "hello" }],
        },
        selectedModel: modelWithEndpoints(
          endpoints === undefined ? undefined : [...endpoints],
          vendor,
        ),
      })
      return [surface, "code" in decision ? decision.code : decision.target]
    }),
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
    || /^(?:grok|deepseek|llama|mistral|codestral|phi)-(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(
      normalized,
    )
    || /^qwen(?:-|(?=\d))(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(normalized)
    || /^(?:meta-llama\/llama|qwen\/qwen|microsoft\/phi)(?:-|(?=\d))(?=[\w.:[\]-]*\d)[\w.:[\]-]+$/i.test(
      normalized,
    )
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

function proseClauses(value: string): Array<string> {
  return normalizeWhitespace(
    value
      .replaceAll(/```[\s\S]*?```/g, " ")
      .replaceAll(/`([^`]+)`/g, "$1")
      .replaceAll(/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/gm, " ")
      .replaceAll("|", " "),
  )
    .split(/(?<=[.!?;])\s+|\s+[—–]\s+|\s*\n\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function semanticWindows(value: string): Array<string> {
  const clauses = proseClauses(value)
  return clauses.flatMap((clause, index) =>
    index + 1 < clauses.length ?
      [clause, `${clause} ${clauses[index + 1]}`]
    : [clause],
  )
}

function blanketStreamClaims(value: string): Array<string> {
  return semanticWindows(value).filter((clause) => {
    const lower = clause.toLowerCase()
    const committed =
      /after (?:http )?headers|headers (?:are|have been) (?:committed|sent)|headers (?:are )?already (?:committed|sent)|post[- ]headers?|post-commit|committed[- ]stream|late stream|late failures?|later (?:faults?|errors?|exceptions?|failures?)|once (?:the )?(?:response|stream|streaming) (?:starts|begins)|(?:response|stream|streaming) has started|once committed|following commitment|after commit(?:ment)?|after (?:response )?bytes? (?:are |have been )?written|after (?:the )?first byte/.test(
        lower,
      )
    const failure = /failures?|faults?|errors?|exceptions?|disconnects?/.test(
      lower,
    )
    const universal =
      /\b(?:all|always|any|each|every|invariably|necessarily|universally|the source protocol)\b|without exception|in every case|\b(?:failures?|faults?|errors?|exceptions?|disconnects?) (?:are|become)\b|\b(?:failures?|faults?|errors?|exceptions?|disconnects?) are reported\b/.test(
        lower,
      )
    const inBand =
      /in-band|returned in-band|carried by (?:the )?event stream|arrive as (?:an? )?(?:protocol )?events?|error event|event stream|sse event|stream event|stream frame|protocol-native frame|sent (?:to|on) the (?:client|stream)|protocol event|delivered as (?:an? )?event|emitted to the client|surfaced as (?:an? )?(?:protocol )?event|framed as (?:an? )?(?:sse )?event|encoded in (?:the )?sse|encoded in-band|reported through (?:an? )?(?:stream )?event|represented (?:within|in) the protocol/.test(
        lower,
      )
    const negated =
      /\b(?:not|never) (?:all|any|each|every)|\b(?:do|does) not always|\bmay not always/.test(
        lower,
      )
    return committed && failure && universal && inBand && !negated
  })
}

function blanketTokenPrivacyClaims(value: string): Array<string> {
  return semanticWindows(value).filter((clause) => {
    const lower = clause.toLowerCase()
    const token =
      /session[- ](?:credentials?|tokens?)|copilot-session-token/.test(lower)
    const blanket =
      /never (?:logged|captured|recorded|exposed|stored)|never (?:appears?|reaches?|enters?) (?:in )?(?:any |all )?(?:logs?|traces?|diagnostics?)|cannot appear|guaranteed absent|redacted everywhere|no .*diagnostic.*(?:captures?|contains?|records?)|diagnostics? contain no credentials|no (?:log|trace).*(?:capture|contain|record)|(?:absent|excluded|omitted) from (?:all|every) diagnostic|universally absent from diagnostic(?: output)?|diagnostics? (?:are|remain) universally free|(?:all|every) (?:logging|logs?|tracing|traces?|diagnostics?) (?:and (?:logging|logs?|tracing|traces?|diagnostics?) )?(?:omit|exclude|redact)|always redacted in every diagnostic|(?:do|does|will) not (?:appear|occur|exist|show up|be present) in (?:any|all|every) (?:log|trace|diagnostic)/.test(
        lower,
      )
    const scoped =
      /\bordinary\b|outside (?:administrator-only )?llm debug|except (?:for )?(?:administrator-only )?llm debug|unless (?:it is )?captured by (?:administrator-only )?llm debug|(?:administrator-only )?llm debug (?:may|might|can|does|is allowed to) (?:capture|contain|include|record|retain|expose)/.test(
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

// The behavior matrix intentionally probes every public diagnostic boundary.
// eslint-disable-next-line max-lines-per-function
async function deriveCompatibilityMatrix(): Promise<{
  errors: Record<string, string>
  privacy: Record<string, string>
  streams: Record<string, string>
}> {
  const privateMarker = "compatibility-private-marker"
  const anthropicErrorTypes = [400, 401, 403, 404, 413, 429, 500].map(
    (status) =>
      createAnthropicStreamError(
        new HTTPError(privateMarker, Response.json({}, { status })),
      ).error.type,
  )
  expect(anthropicErrorTypes).toEqual([
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "request_too_large",
    "rate_limit_error",
    "api_error",
  ])

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
  const syntheticEventNames = syntheticEvents.map((event) => event.event)
  const syntheticEventTypes = syntheticEvents.map((event) => {
    const parsed = JSON.parse(event.data) as { type?: unknown }
    return typeof parsed.type === "string" ? parsed.type : "unknown"
  })
  expect(syntheticEventNames).toEqual(["error", "response.failed"])
  expect(syntheticEventTypes).toEqual(["error", "response.failed"])

  const terminalTypes = [
    {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 3,
        response: {
          id: "response-placeholder",
          object: "response",
          status: "completed",
          output: [],
          output_text: "",
          usage: null,
          error: null,
          incomplete_details: null,
        },
      }),
    },
    { event: "response.incomplete", data: undefined },
    { event: "response.failed", data: undefined },
    { event: "error", data: undefined },
  ].map((event) => {
    const terminal = sanitizeResponsesStreamEvent(event)
    return (JSON.parse(terminal.data ?? "null") as { type?: unknown }).type
  })
  expect(terminalTypes).toEqual([
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
  ])

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

  const messagePaths = messageRoutes.routes
    .filter((route) => route.method === "POST")
    .map((route) =>
      route.path === "/" ? "/v1/messages" : `/v1/messages${route.path}`,
    )
    .sort()
  expect(messagePaths).toEqual(["/v1/messages", "/v1/messages/count_tokens"])

  return {
    errors: {
      "Chat and Responses HTTP":
        "OpenAI/Copilot envelope with fixed safe message",
      [messagePaths.join(" and ")]:
        "Anthropic envelope with fixed safe message",
    },
    privacy: {
      "Administrator-only LLM Debug": "exact forwarded token may be captured",
      "Ordinary handler logs": "session token value is redacted",
      "Configuration export": "token-keyed values are redacted",
      "Inference forwarding": "only a matching unredirected model receives it",
    },
    streams: {
      "Messages handled HTTP failure": `error event with ${[...new Set(anthropicErrorTypes)].join(", ")}`,
      "Synthetic Responses-from-Messages failure":
        syntheticEventNames.join(" then "),
      "Native Responses terminal families": `sanitized ${terminalTypes.join(", ")}`,
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

test("rejects adversarial blanket stream and session-token claims", async () => {
  const document = await readFile(documentPath, "utf8")

  expect(blanketStreamClaims(document)).toEqual([])
  expect(blanketTokenPrivacyClaims(document)).toEqual([])

  for (const claim of blanketStreamExamples) {
    expect(blanketStreamClaims(claim).length).toBeGreaterThan(0)
  }
  for (const claim of blanketTokenExamples) {
    expect(blanketTokenPrivacyClaims(claim).length).toBeGreaterThan(0)
  }
  expect(
    blanketTokenPrivacyClaims(
      "Ordinary logs never expose the session token; administrator-only LLM Debug may capture it.",
    ),
  ).toEqual([])
  expect(
    blanketTokenPrivacyClaims(
      "All diagnostics except administrator-only LLM Debug redact Copilot-Session-Token.",
    ),
  ).toEqual([])
  expect(
    blanketStreamClaims(
      "Not every post-commit failure is emitted through a protocol event.",
    ),
  ).toEqual([])
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
