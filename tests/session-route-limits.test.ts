import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import {
  SESSION_COMPAT_MAX_BODY_BYTES,
  SESSION_COMPAT_MAX_EVENTS_PER_REQUEST,
} from "../src/routes/sessions/route"
import { server } from "../src/server"

const VERIFIER = "v".repeat(64)
let oauthStore: OAuthStore
let accessToken: string

beforeEach(async () => {
  state.apiKeyAuth = "session-limit-gateway"
  oauthStore = new OAuthStore()
  setOAuthStoreForTest(oauthStore)
  const code = await oauthStore.issueAuthorizationCode({
    clientId: "session-limit-client",
    redirectUri: "http://localhost:8765/callback",
    scopes: ["user:sessions:claude_code"],
    state: "session-limit-state",
    codeChallenge: createPkceChallenge(VERIFIER),
  })
  const result = await oauthStore.exchangeAuthorizationCode({
    code,
    clientId: "session-limit-client",
    redirectUri: "http://localhost:8765/callback",
    state: "session-limit-state",
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
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  }
}

async function createSession(): Promise<string> {
  const response = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "Bounded compat session" }),
  })
  return ((await response.json()) as { session: { id: string } }).session.id
}

test("session compatibility event batches have count and body limits", async () => {
  const sessionId = await createSession()
  const tooManyEvents = await server.request(
    `/v1/sessions/${sessionId}/events`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        events: Array.from(
          { length: SESSION_COMPAT_MAX_EVENTS_PER_REQUEST + 1 },
          () => ({}),
        ),
      }),
    },
  )
  expect(tooManyEvents.status).toBe(400)

  const oversized = await server.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      events: [{ content: "x".repeat(SESSION_COMPAT_MAX_BODY_BYTES) }],
    }),
  })
  expect(oversized.status).toBe(413)
})
