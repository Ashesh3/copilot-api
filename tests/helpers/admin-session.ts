import { expect } from "bun:test"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  setAdminAuthTestMode,
} from "../../src/lib/admin-auth"
import { state } from "../../src/lib/state"
import { server } from "../../src/server"

export const TEST_ADMIN_ORIGIN = "https://ai.ashesh.dev"
export const TEST_GATEWAY_KEY = "test-dashboard-gateway-key-with-enough-entropy"
export const TEST_ADMIN_PASSWORD = "test dashboard administrator password"

export interface TestAdminSession {
  cookie: string
  csrf: string
}

function setCookies(response: Response): Array<string> {
  const cookies = response.headers.getSetCookie()
  return cookies.length > 0 ?
      cookies
    : [response.headers.get("set-cookie") ?? ""]
}

export async function createTestAdminSession(
  reauthenticate = false,
): Promise<TestAdminSession> {
  setAdminAuthTestMode(true)
  state.apiKeyAuth = TEST_GATEWAY_KEY
  process.env.COPILOT_ADMIN_ORIGIN = TEST_ADMIN_ORIGIN
  const setup = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_ADMIN_ORIGIN,
    },
    body: JSON.stringify({
      gatewayKey: TEST_GATEWAY_KEY,
      password: TEST_ADMIN_PASSWORD,
    }),
  })
  expect(setup.status).toBe(201)
  const cookies = setCookies(setup)
  const session = cookies
    .find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    ?.split(";", 1)[0]
  const csrfCookie = cookies
    .find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE}=`))
    ?.split(";", 1)[0]
  expect(session).toBeTruthy()
  expect(csrfCookie).toBeTruthy()
  const csrf = csrfCookie?.slice(`${ADMIN_CSRF_COOKIE}=`.length) ?? ""
  const result = { cookie: `${session}; ${csrfCookie}`, csrf }
  if (reauthenticate) {
    const response = await server.request("/dashboard/auth/reauth", {
      method: "POST",
      headers: adminHeaders(result),
      body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    })
    expect(response.status).toBe(200)
  }
  return result
}

export function adminHeaders(
  session: TestAdminSession,
  mutating = true,
): Record<string, string> {
  return {
    cookie: session.cookie,
    ...(mutating ?
      {
        origin: TEST_ADMIN_ORIGIN,
        "x-copilot-csrf": session.csrf,
        "content-type": "application/json",
      }
    : {}),
  }
}

export function resetTestAdminSession(): void {
  setAdminAuthTestMode(false)
  state.apiKeyAuth = undefined
  delete process.env.COPILOT_ADMIN_ORIGIN
}
