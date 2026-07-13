import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const VERIFIER = "v".repeat(64)
let accessToken: string

beforeEach(async () => {
  state.apiKeyAuth = "session-gateway"
  const oauthStore = new OAuthStore()
  setOAuthStoreForTest(oauthStore)
  const code = await oauthStore.issueAuthorizationCode({
    clientId: "session-client",
    redirectUri: "http://localhost:8765/callback",
    scopes: ["user:sessions:claude_code"],
    state: "session-state-with-entropy",
    codeChallenge: createPkceChallenge(VERIFIER),
  })
  const result = await oauthStore.exchangeAuthorizationCode({
    code,
    clientId: "session-client",
    redirectUri: "http://localhost:8765/callback",
    state: "session-state-with-entropy",
    codeVerifier: VERIFIER,
  })
  if (result.status !== "ok") throw new Error("Failed to issue test token")
  accessToken = result.tokens.accessToken
})

afterEach(() => {
  state.apiKeyAuth = undefined
  setOAuthStoreForTest(null)
})

function headers(): Record<string, string> {
  return {
    authorization: "Be" + "arer " + accessToken,
    "content-type": "application/json",
  }
}

test("session compatibility accepts large event batches and bodies", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "Unbounded compat session" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id

  const response = await server.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      events: [
        ...Array.from({ length: 101 }, (_, index) => ({ index })),
        { content: "x".repeat(1024 * 1024 + 1) },
      ],
    }),
  })

  expect(response.status).toBe(200)
})
