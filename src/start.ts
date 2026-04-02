#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import invariant from "tiny-invariant"

import type { CallbackSubscriber } from "./routes/code-sessions/event-bus"

import packageJson from "../package.json" with { type: "json" }
import { getStoredTokens } from "./lib/accounts-store"
import { mergeConfigWithDefaults } from "./lib/config"
import { generateVirtualModels } from "./lib/model-suffix"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { initSentry, setupSentryShutdown } from "./lib/sentry"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { tokenPool } from "./lib/token-pool"
import { cacheModels } from "./lib/utils"
import {
  subscribeWithCallback,
  unsubscribeCallback,
  broadcastEvents,
} from "./routes/code-sessions/event-bus"
import {
  getSession,
  getClientEvents,
  addClientEvents,
} from "./routes/code-sessions/session-store"
import {
  DIRECT_CONNECT_WS_PATH,
  handleDirectConnectWebSocket,
} from "./routes/direct-connect/ws-handler"
import {
  tryUpgradeResponsesWebSocket,
  responsesWebSocket,
} from "./routes/responses/websocket"
import { tryUpgradeVoiceWebSocket, voiceWebSocket } from "./routes/voice/route"
import { server } from "./server"
import { getVSCodeVersion } from "./services/get-vscode-version"

async function cacheVSCodeVersion(): Promise<void> {
  state.vsCodeVersion = await getVSCodeVersion()
  consola.info(`Editor version: vscode/${state.vsCodeVersion}`)
}

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  insecure: boolean
  debug: boolean
  apiKeyAuth?: string
  host?: string
}

function getAllModelIds(): Array<string> {
  const baseModelIds = state.models?.data.map((model) => model.id) ?? []
  const virtualModelIds =
    state.models ?
      generateVirtualModels(state.models.data).map((model) => model.id)
    : []
  return [...baseModelIds, ...virtualModelIds]
}

async function promptClaudeCodeSetup(
  serverUrl: string,
  allModelIds: Array<string>,
): Promise<void> {
  invariant(state.models, "Models should be loaded by now")

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: allModelIds,
    },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: allModelIds,
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

/**
 * Set up multi-token mode from GITHUB_TOKENS env var or stored accounts file.
 * Priority: env var > github_tokens.json
 * Returns true if multi-token mode was activated (2+ tokens).
 */
async function initializeMultiToken(
  options: RunServerOptions,
): Promise<boolean> {
  // Collect tokens: env var takes priority, then stored file
  let tokens: Array<string> = []
  const githubTokensEnv = process.env.GITHUB_TOKENS
  if (githubTokensEnv) {
    tokens = githubTokensEnv
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }

  if (tokens.length === 0) {
    tokens = await getStoredTokens()
  }

  // Need at least 2 tokens for multi-token mode
  if (tokens.length < 2) return false

  state.isMultiToken = true
  consola.info(`Multi-token mode: ${tokens.length} GitHub tokens configured`)

  tokenPool.setSessionId(state.sessionId)

  // Add all accounts
  const accounts = tokens.map((token, i) =>
    tokenPool.addAccount(token, options.accountType, i),
  )

  // Initialize each account, log warnings on failure
  for (const account of accounts) {
    try {
      await tokenPool.initializeAccount(account, options.showToken)
    } catch (error) {
      consola.warn(
        `Failed to initialize account #${account.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      tokenPool.markUnhealthy(account)
    }
  }

  // Check that at least one account is healthy
  const healthyAccounts = accounts.filter((a) => a.healthy)
  if (healthyAccounts.length === 0) {
    consola.error(
      "No healthy accounts available. All GitHub tokens failed to initialize.",
    )
    process.exit(1)
  }

  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()

  // Backwards compatibility: set state tokens to first healthy account
  const firstHealthy = healthyAccounts[0]
  state.copilotToken = firstHealthy.copilotToken
  state.githubToken = firstHealthy.githubToken

  // Cache VS Code version and pass to token pool
  await cacheVSCodeVersion()
  if (state.vsCodeVersion) {
    tokenPool.setVSCodeVersion(state.vsCodeVersion)
  }

  return true
}

/**
 * Initialize tokens: try multi-token mode first, fall back to single-token.
 */
async function initializeTokens(options: RunServerOptions): Promise<void> {
  const multiTokenActive = await initializeMultiToken(options)
  if (multiTokenActive) return

  // Check if GITHUB_TOKENS has exactly 1 token — use it directly
  const envTokens = process.env.GITHUB_TOKENS?.split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (envTokens && envTokens.length === 1) {
    state.githubToken = envTokens[0]
    consola.info("Using GitHub token from GITHUB_TOKENS")
  } else if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheVSCodeVersion()
  await cacheModels()
}

// Combined WebSocket handler that dispatches to voice, responses, or direct-connect based on connection type
const combinedWebSocket = {
  open(ws: { data: { type: string } }) {
    switch (ws.data.type) {
      case "voice": {
        voiceWebSocket.open(
          ws as unknown as Parameters<typeof voiceWebSocket.open>[0],
        )

        break
      }
      case "responses": {
        responsesWebSocket.open(
          ws as unknown as Parameters<typeof responsesWebSocket.open>[0],
        )

        break
      }
      case "direct-connect": {
        const dcWs = ws as {
          data: {
            type: string
            sessionId: string
            dcHandlers?: {
              onMessage: (message: string | Buffer | Uint8Array) => void
              onClose: () => void
            }
          }
          send(data: string | ArrayBuffer | Uint8Array): void
          close(code?: number, reason?: string): void
        }
        const handlers = handleDirectConnectWebSocket(dcWs, dcWs.data.sessionId)
        dcWs.data.dcHandlers = handlers

        break
      }
      case "remote-control": {
        const rcWs = ws as {
          data: {
            type: string
            sessionId: string
            rcSubscriber?: CallbackSubscriber
          }
          send(data: string): void
          close(code?: number, reason?: string): void
        }
        const sid = rcWs.data.sessionId
        const session = getSession(sid)
        if (!session) {
          rcWs.close(4004, "Session not found")
          break
        }
        // Send catchup events
        const catchup = getClientEvents(sid, 0)
        for (const event of catchup) {
          rcWs.send(JSON.stringify(event))
        }
        // Subscribe for future events
        rcWs.data.rcSubscriber = subscribeWithCallback(sid, (event) => {
          try {
            rcWs.send(JSON.stringify(event))
          } catch {
            // WebSocket may have closed
          }
        })

        break
      }
      // No default
    }
  },
  message(
    ws: {
      data: { type: string }
      send: (data: string | ArrayBuffer | Uint8Array) => void
      close: (code?: number, reason?: string) => void
    },
    message: string | Buffer | Uint8Array,
  ) {
    switch (ws.data.type) {
      case "voice": {
        voiceWebSocket.message(
          ws as unknown as Parameters<typeof voiceWebSocket.message>[0],
          message,
        )

        break
      }
      case "responses": {
        void responsesWebSocket.message(
          ws as unknown as Parameters<typeof responsesWebSocket.message>[0],
          message,
        )

        break
      }
      case "direct-connect": {
        const dcWs = ws as {
          data: {
            type: string
            dcHandlers?: {
              onMessage: (message: string | Buffer | Uint8Array) => void
              onClose: () => void
            }
          }
        }
        dcWs.data.dcHandlers?.onMessage(message)

        break
      }
      case "remote-control": {
        const rcWs = ws as unknown as {
          data: { type: string; sessionId: string }
        }
        try {
          const parsed = JSON.parse(
            typeof message === "string" ? message : (
              new TextDecoder().decode(message as Uint8Array)
            ),
          ) as {
            type: string
            message: { role: string; content: string }
            session_id: string
          }
          const now = new Date().toISOString()
          const created = addClientEvents(rcWs.data.sessionId, [
            {
              event_type: "client_event",
              source: "client",
              payload: parsed as unknown as Record<string, unknown>,
              created_at: now,
            },
          ])
          broadcastEvents(rcWs.data.sessionId, created)
        } catch {
          // Ignore malformed messages
        }

        break
      }
      // No default
    }
  },
  close(ws: { data: { type: string } }) {
    switch (ws.data.type) {
      case "voice": {
        voiceWebSocket.close(
          ws as unknown as Parameters<typeof voiceWebSocket.close>[0],
        )

        break
      }
      case "responses": {
        responsesWebSocket.close(
          ws as unknown as Parameters<typeof responsesWebSocket.close>[0],
        )

        break
      }
      case "direct-connect": {
        const dcWs = ws as {
          data: {
            type: string
            dcHandlers?: {
              onMessage: (message: string | Buffer | Uint8Array) => void
              onClose: () => void
            }
          }
        }
        dcWs.data.dcHandlers?.onClose()

        break
      }
      case "remote-control": {
        const rcWs = ws as {
          data: {
            type: string
            sessionId: string
            rcSubscriber?: CallbackSubscriber
          }
        }
        if (rcWs.data.rcSubscriber) {
          unsubscribeCallback(rcWs.data.rcSubscriber)
        }

        break
      }
      // No default
    }
  },
}

export async function runServer(options: RunServerOptions): Promise<void> {
  initSentry()

  consola.info(`copilot-api v${packageJson.version}`)

  if (options.insecure) {
    // Disable SSL certificate verification globally
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    consola.warn("SSL certificate verification disabled (insecure mode)")
  }

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.debug = options.debug
  state.verbose = options.verbose
  state.apiKeyAuth = options.apiKeyAuth

  if (options.apiKeyAuth)
    consola.info(
      "API key authentication enabled - unauthorized requests will be silently dropped",
    )
  if (options.host) consola.info(`Binding to host: ${options.host}`)

  if (options.debug) {
    consola.info("Debug mode enabled - raw HTTP requests will be logged")
  }

  await ensurePaths()
  mergeConfigWithDefaults()

  await initializeTokens(options)

  const allModelIds = getAllModelIds()

  consola.info(
    `Available models: \n${allModelIds.map((id) => `- ${id}`).join("\n")}`,
  )

  const serverUrl = `http://${options.host ?? "localhost"}:${options.port}`

  if (options.claudeCode) {
    await promptClaudeCodeSetup(serverUrl, allModelIds)
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: 255,
    fetch(req, bunServer) {
      // WebSocket upgrade must happen before Hono routing
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (tryUpgradeVoiceWebSocket(req, bunServer)) {
          return undefined as unknown as Response
        }
        const wsResult = tryUpgradeResponsesWebSocket(req, bunServer)
        if (wsResult === "upgraded") {
          return undefined as unknown as Response
        }
        if (wsResult === "auth_failed") {
          return new Response("Unauthorized", { status: 401 })
        }
        // Direct Connect WebSocket upgrade
        const url = new URL(req.url)
        if (url.pathname.startsWith(DIRECT_CONNECT_WS_PATH + "/")) {
          const sessionId = url.pathname.slice(
            DIRECT_CONNECT_WS_PATH.length + 1,
          )
          if (sessionId) {
            bunServer.upgrade(req, {
              data: {
                type: "direct-connect" as const,
                sessionId,
              },
            })
            return undefined as unknown as Response
          }
        }
        // Remote Control WebSocket upgrade
        if (url.pathname.startsWith("/ws/remote/")) {
          const sessionId = url.pathname.slice("/ws/remote/".length)
          if (sessionId) {
            bunServer.upgrade(req, {
              data: { type: "remote-control" as const, sessionId },
            })
            return undefined as unknown as Response
          }
        }
      }
      return server.fetch(req)
    },
    websocket: combinedWebSocket,
  })

  const host = options.host ?? "localhost"
  consola.info(`Listening on: http://${host}:${options.port}/`)

  setupSentryShutdown()
}

/**
 * Resolve --api-key-auth value: use provided value, fall back to env, or error if flag used without value.
 */
function resolveApiKeyAuth(cliValue: string | undefined): string | undefined {
  if (cliValue === undefined) return undefined

  // If a non-empty value was provided via CLI, use it
  if (cliValue !== "" && cliValue !== "true") return cliValue

  // Flag was provided but no value — fall back to env
  const envValue = process.env.COPILOT_API_KEY_AUTH
  if (envValue) return envValue

  consola.error(
    "--api-key-auth requires a value or COPILOT_API_KEY_AUTH environment variable",
  )
  process.exit(1)
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    insecure: {
      type: "boolean",
      default: false,
      description:
        "Disable SSL certificate verification (for corporate proxies with self-signed certs)",
    },
    debug: {
      alias: "d",
      type: "boolean",
      default: false,
      description:
        "Log raw HTTP requests received by the server (headers, method, path)",
    },
    "api-key-auth": {
      type: "string",
      description:
        "API key for incoming request authentication. Requests with mismatched keys are silently dropped.",
    },
    host: {
      type: "string",
      description:
        "Hostname/IP to bind the server to (e.g., 0.0.0.0 for all interfaces)",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      insecure: args.insecure,
      debug: args.debug,
      apiKeyAuth: resolveApiKeyAuth(args["api-key-auth"]),
      host: args.host,
    })
  },
})
