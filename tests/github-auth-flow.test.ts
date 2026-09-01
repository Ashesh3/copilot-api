import { expect, test } from "bun:test"
import { createHash } from "node:crypto"

import {
  buildWebFlowAccessTokenRequest,
  buildWebFlowAuthorizeUrl,
  createWebFlowOAuthParameters,
  loginViaWebFlow,
} from "../src/services/github/auth-flow"

const STATE_BYTES = Uint8Array.from({ length: 16 }, (_, index) => index)
const VERIFIER_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 16)

test("builds the GHE authorize URL with state and PKCE", () => {
  const parameters = createWebFlowOAuthParameters(STATE_BYTES, VERIFIER_BYTES)
  const url = new URL(
    buildWebFlowAuthorizeUrl({
      codeChallenge: parameters.codeChallenge,
      instanceDomain: "msft.ghe.com",
      oauthState: parameters.oauthState,
      redirectUri: "http://127.0.0.1:43123/callback",
    }),
  )

  expect(url.origin).toBe("https://msft.ghe.com")
  expect(url.pathname).toBe("/login/oauth/authorize")
  expect(url.searchParams.get("client_id")).toBe("Ov23ctDVkRmgkPke0Mmm")
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:43123/callback",
  )
  expect(url.searchParams.get("scope")).toBe(
    "read:user read:org repo gist codespace",
  )
  expect(url.searchParams.get("state")).toBe(parameters.oauthState)
  expect(url.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(parameters.codeVerifier).digest("base64url"),
  )
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
})

test("builds the GHE access-token exchange request", async () => {
  const request = buildWebFlowAccessTokenRequest({
    code: "authorization code",
    codeVerifier: "verifier value",
    instanceDomain: "github.ghe.com",
    redirectUri: "http://127.0.0.1:43124/callback",
  })
  const body = new URLSearchParams(await request.text())

  expect(request.url).toBe("https://github.ghe.com/login/oauth/access_token")
  expect(request.method).toBe("POST")
  expect(request.headers.get("accept")).toBe("application/json")
  expect(request.headers.get("content-type")).toBe(
    "application/x-www-form-urlencoded",
  )
  expect(Object.fromEntries(body)).toEqual({
    client_id: "Ov23ctDVkRmgkPke0Mmm",
    client_secret: "68bbd667b6f1e954c1ab457717c147f221147eba",
    code: "authorization code",
    redirect_uri: "http://127.0.0.1:43124/callback",
    code_verifier: "verifier value",
  })
})

test("ignores an invalid-state callback and accepts the later valid callback", async () => {
  let authorizeUrlResolve!: (url: string) => void
  const authorizeUrlPromise = new Promise<string>((resolve) => {
    authorizeUrlResolve = resolve
  })
  let exchangeRequest: Request | undefined
  let randomCall = 0
  const loginPromise = loginViaWebFlow("msft.ghe.com", authorizeUrlResolve, {
    fetch: (request) => {
      exchangeRequest = request
      return Promise.resolve(
        Response.json({ access_token: "gho_enterprise_token" }),
      )
    },
    openBrowser: async () => {},
    randomBytes: () => (randomCall++ === 0 ? STATE_BYTES : VERIFIER_BYTES),
    authorizationDeadlineMs: 5_000,
  })
  const authorizeUrl = new URL(await authorizeUrlPromise)
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri")
  const state = authorizeUrl.searchParams.get("state")
  if (!redirectUri || !state) throw new Error("Authorize URL is incomplete")

  const invalidResponse = await fetch(
    `${redirectUri}?code=stale-code&state=invalid-state`,
  )
  expect(invalidResponse.status).toBe(400)
  expect(await invalidResponse.text()).toBe("Invalid OAuth state")

  const validResponse = await fetch(
    `${redirectUri}?code=current-code&state=${encodeURIComponent(state)}`,
  )
  expect(validResponse.status).toBe(200)
  expect(await loginPromise).toBe("gho_enterprise_token")

  expect(exchangeRequest?.url).toBe(
    "https://msft.ghe.com/login/oauth/access_token",
  )
  const body = new URLSearchParams(await exchangeRequest?.text())
  expect(body.get("code")).toBe("current-code")
  expect(body.get("redirect_uri")).toBe(redirectUri)
  expect(body.get("code_verifier")).toBe(
    Buffer.from(VERIFIER_BYTES).toString("base64url"),
  )
})
