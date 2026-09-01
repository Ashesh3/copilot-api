import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

import {
  GITHUB_APP_SCOPES,
  GITHUB_CLIENT_ID,
  GITHUB_WEB_CLIENT_SECRET,
  standardHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { githubBaseUrl } from "~/lib/github-instance"

interface OAuthAccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

const WEB_FLOW_TIMEOUT_MS = 5 * 60 * 1000

export interface WebFlowDependencies {
  fetch: (request: Request) => Promise<Response>
  openBrowser: (url: string) => Promise<void>
  randomBytes: (size: number) => Uint8Array
  authorizationDeadlineMs: number
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function createWebFlowOAuthParameters(
  stateBytes: Uint8Array,
  verifierBytes: Uint8Array,
): {
  codeChallenge: string
  codeVerifier: string
  oauthState: string
} {
  const oauthState = base64Url(stateBytes)
  const codeVerifier = base64Url(verifierBytes)
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url")
  return { codeChallenge, codeVerifier, oauthState }
}

function appendValidatedRedirectUri(
  authorizeUrl: URL,
  redirectUri: string,
): void {
  const redirect = new URL(redirectUri)
  if (
    redirect.protocol !== "http:"
    || redirect.hostname !== "127.0.0.1"
    || redirect.pathname !== "/callback"
    || redirect.username
    || redirect.password
  ) {
    throw new TypeError("OAuth redirect URI must use the loopback callback")
  }
  authorizeUrl.searchParams.set("redirect_uri", redirectUri)
}

export function buildWebFlowAuthorizeUrl(options: {
  codeChallenge: string
  instanceDomain: string
  oauthState: string
  redirectUri: string
}): string {
  const authorizeUrl = new URL(
    "/login/oauth/authorize",
    githubBaseUrl(options.instanceDomain),
  )
  authorizeUrl.searchParams.set("client_id", GITHUB_CLIENT_ID)
  appendValidatedRedirectUri(authorizeUrl, options.redirectUri)
  authorizeUrl.searchParams.set("scope", GITHUB_APP_SCOPES)
  authorizeUrl.searchParams.set("state", options.oauthState)
  authorizeUrl.searchParams.set("code_challenge", options.codeChallenge)
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  return authorizeUrl.toString()
}

export function buildWebFlowAccessTokenRequest(options: {
  code: string
  codeVerifier: string
  instanceDomain: string
  redirectUri: string
}): Request {
  return new Request(
    `${githubBaseUrl(options.instanceDomain)}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        ...standardHeaders(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_WEB_CLIENT_SECRET,
        code: options.code,
        redirect_uri: options.redirectUri,
        code_verifier: options.codeVerifier,
      }),
    },
  )
}

async function openBrowser(url: string): Promise<void> {
  let command: { args: Array<string>; file: string }
  if (process.platform === "win32") {
    command = {
      args: ["url.dll,FileProtocolHandler", url],
      file: "rundll32.exe",
    }
  } else if (process.platform === "darwin") {
    command = { args: [url], file: "open" }
  } else {
    command = { args: [url], file: "xdg-open" }
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

async function exchangeAuthorizationCode(options: {
  code: string
  codeVerifier: string
  fetch: (request: Request) => Promise<Response>
  instanceDomain: string
  redirectUri: string
}): Promise<string> {
  const response = await options.fetch(buildWebFlowAccessTokenRequest(options))

  if (!response.ok) {
    throw new HTTPError("Failed to exchange authorization code", response)
  }

  const result = (await response.json()) as OAuthAccessTokenResponse
  if (result.access_token) return result.access_token
  throw new Error(
    result.error_description
      || (result.error ? `GitHub OAuth failed: ${result.error}` : undefined)
      || "GitHub OAuth response did not include an access token",
  )
}

// eslint-disable-next-line max-lines-per-function -- listener, PKCE state, timeout, and exchange share one cancellation boundary
export async function loginViaWebFlow(
  instanceDomain: string,
  onAuthorizeUrl: (url: string) => void,
  dependencyOverrides: Partial<WebFlowDependencies> = {},
): Promise<string> {
  const dependencies: WebFlowDependencies = {
    fetch: async (request) => await fetch(request),
    openBrowser,
    randomBytes: (size) => randomBytes(size),
    authorizationDeadlineMs: WEB_FLOW_TIMEOUT_MS,
    ...dependencyOverrides,
  }
  const { codeChallenge, codeVerifier, oauthState } =
    createWebFlowOAuthParameters(
      dependencies.randomBytes(16),
      dependencies.randomBytes(32),
    )

  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = (code) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    rejectCode = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })

  const server = createServer((request, response) => {
    const rejectCallback = (status: number, message: string, error: Error) => {
      response.writeHead(status).end(message)
      rejectCode(error)
      server.close()
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
    if (requestUrl.pathname !== "/callback") {
      response.writeHead(404).end("Not found")
      return
    }
    if (requestUrl.searchParams.get("state") !== oauthState) {
      response.writeHead(400).end("Invalid OAuth state")
      return
    }

    const oauthError = requestUrl.searchParams.get("error")
    if (oauthError) {
      const description =
        requestUrl.searchParams.get("error_description") ?? oauthError
      rejectCallback(400, "GitHub authorization failed", new Error(description))
      return
    }

    const code = requestUrl.searchParams.get("code")
    if (!code) {
      rejectCallback(
        400,
        "Authorization code is missing",
        new Error("GitHub OAuth callback did not include a code"),
      )
      return
    }

    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>GitHub authorization complete</title><h1>Authorization complete</h1><p>Return to the copilot-api terminal. You can close this tab.</p>",
      )
    resolveCode(code)
    server.close()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  try {
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine the OAuth callback port")
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const authorizeUrl = buildWebFlowAuthorizeUrl({
      codeChallenge,
      instanceDomain,
      oauthState,
      redirectUri,
    })

    onAuthorizeUrl(authorizeUrl)
    void dependencies.openBrowser(authorizeUrl).catch(() => {})

    timeout = setTimeout(
      () =>
        rejectCode(new Error("Timed out waiting for browser authorization")),
      dependencies.authorizationDeadlineMs,
    )
    const code = await codePromise
    return await exchangeAuthorizationCode({
      code,
      codeVerifier,
      fetch: dependencies.fetch,
      instanceDomain,
      redirectUri,
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    server.close()
  }
}
