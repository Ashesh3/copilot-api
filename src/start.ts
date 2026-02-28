#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import packageJson from "../package.json" with { type: "json" }
import { mergeConfigWithDefaults } from "./lib/config"
import { generateVirtualModels } from "./lib/model-suffix"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { initSentry, setupSentryShutdown } from "./lib/sentry"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels } from "./lib/utils"
import { server } from "./server"

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
  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  const allModelIds = getAllModelIds()

  consola.info(
    `Available models: \n${allModelIds.map((id) => `- ${id}`).join("\n")}`,
  )

  const serverUrl = `http://${options.host ?? "localhost"}:${options.port}`

  if (options.claudeCode) {
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
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    hostname: options.host,
    // Increase idle timeout for long-running requests (e.g. Claude Code compact)
    // Bun default is 10s which is too short
    bun: {
      idleTimeout: 255, // max value in seconds (4m 15s)
    },
  })

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
