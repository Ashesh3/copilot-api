import { afterEach, beforeEach, expect, test } from "bun:test"

import { setAdminAuthTestMode } from "../src/lib/admin-auth"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const GATEWAY_KEY = "test-gateway-key-that-is-long-and-random"
const GATEWAY_DIGEST =
  "df2e72644a61cfed6c45f096088b19630fe03aac69c6f2e3757f0ea81107901c"
const ADMIN_PASSWORD = "correct horse battery staple"
const ORIGIN = "https://ai.ashesh.dev"

const originalAdminOrigin = process.env.COPILOT_ADMIN_ORIGIN
const originalAdminPasswordHash = process.env.COPILOT_ADMIN_PASSWORD_HASH
const originalInferenceCredentialDigests =
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
const originalGatewayKey = state.apiKeyAuth

function setInferenceCredentialDigests(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  } else {
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = value
  }
}

async function adminRequest(
  path: string,
  gatewayKey = GATEWAY_KEY,
): Promise<Response> {
  return await server.request(`/dashboard/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      gatewayKey,
      password: ADMIN_PASSWORD,
    }),
  })
}

beforeEach(() => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  setAdminAuthTestMode(true)
  delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  process.env.COPILOT_ADMIN_ORIGIN = ORIGIN
  state.apiKeyAuth = GATEWAY_KEY
  setInferenceCredentialDigests(undefined)
})

afterEach(() => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  setAdminAuthTestMode(false)
  state.apiKeyAuth = originalGatewayKey
  if (originalAdminOrigin === undefined) {
    delete process.env.COPILOT_ADMIN_ORIGIN
  } else {
    process.env.COPILOT_ADMIN_ORIGIN = originalAdminOrigin
  }
  if (originalAdminPasswordHash === undefined) {
    delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  } else {
    process.env.COPILOT_ADMIN_PASSWORD_HASH = originalAdminPasswordHash
  }
  setInferenceCredentialDigests(originalInferenceCredentialDigests)
})

test("digest-listed gateway credentials cannot set up or log in as administrator", async () => {
  setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("setup")).status).toBe(401)

  setInferenceCredentialDigests(undefined)
  expect((await adminRequest("setup")).status).toBe(201)

  setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("login")).status).toBe(401)

  setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("login", ` ${GATEWAY_KEY} `)).status).toBe(401)

  setAdminAuthTestMode(true)
  state.apiKeyAuth = ` ${GATEWAY_KEY} `
  expect((await adminRequest("setup")).status).toBe(401)

  setAdminAuthTestMode(true)
  state.apiKeyAuth = GATEWAY_DIGEST
  setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("setup", GATEWAY_DIGEST)).status).toBe(401)
})
