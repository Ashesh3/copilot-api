import { afterEach, expect, mock, test } from "bun:test"

import { GITHUB_CLIENT_ID } from "../src/lib/api-config"
import { getDeviceCode } from "../src/services/github/get-device-code"
import {
  pollAccessToken,
  setPollAccessTokenRuntimeForTest,
} from "../src/services/github/poll-access-token"

const originalFetch = globalThis.fetch

interface CapturedRequest {
  body: string
  headers: Headers
  method: string
  url: string
}

function captureRequest(
  captured: Array<CapturedRequest>,
  input: string | URL | Request,
  init?: RequestInit,
): void {
  const request = input instanceof Request ? input : undefined
  const body = init?.body
  let url: string
  if (input instanceof Request) url = input.url
  else if (input instanceof URL) url = input.href
  else url = input
  captured.push({
    body:
      typeof body === "string" || body instanceof URLSearchParams ?
        body.toString()
      : "",
    headers: new Headers(init?.headers ?? request?.headers),
    method: init?.method ?? request?.method ?? "GET",
    url,
  })
}

function deviceCode(
  overrides?: Partial<Awaited<ReturnType<typeof getDeviceCode>>>,
) {
  return {
    device_code: "device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://msft.ghe.com/login/device",
    expires_in: 900,
    interval: 5,
    ...overrides,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setPollAccessTokenRuntimeForTest()
})

test("requests a GHE device code with the Copilot client and form body", async () => {
  const captured: Array<CapturedRequest> = []
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      captureRequest(captured, input, init)
      return Promise.resolve(Response.json(deviceCode()))
    },
  ) as unknown as typeof fetch

  const result = await getDeviceCode("msft.ghe.com")

  expect(result.user_code).toBe("ABCD-EFGH")
  expect(captured).toHaveLength(1)
  expect(captured[0]?.url).toBe("https://msft.ghe.com/login/device/code")
  expect(captured[0]?.method).toBe("POST")
  expect(captured[0]?.headers.get("content-type")).toBe(
    "application/x-www-form-urlencoded",
  )
  expect(captured[0]?.headers.get("accept")).toBe("application/json")

  const form = new URLSearchParams(captured[0]?.body)
  expect(form.get("client_id")).toBe(GITHUB_CLIENT_ID)
  expect(form.get("scope")).toBe("read:user,read:org,repo,gist,codespace")
})

test("polls through pending, cumulative slow-down, transport and HTTP failures", async () => {
  const captured: Array<CapturedRequest> = []
  const sleeps: Array<number> = []
  let currentTime = 1_000
  const responses: Array<Response | Error> = [
    Response.json({ error: "authorization_pending" }),
    Response.json({ error: "slow_down" }),
    Response.json({ error: "slow_down" }),
    new TypeError("temporary network failure"),
    new Response("unavailable", { status: 503 }),
    Response.json({ access_token: "gho_enterprise_token" }),
  ]
  setPollAccessTokenRuntimeForTest({
    now: () => currentTime,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds)
      currentTime += milliseconds
      return Promise.resolve()
    },
  })
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      captureRequest(captured, input, init)
      const response = responses.shift()
      if (response instanceof Error) return Promise.reject(response)
      if (!response) throw new Error("Unexpected extra poll")
      return Promise.resolve(response)
    },
  ) as unknown as typeof fetch

  const token = await pollAccessToken(
    deviceCode({ expires_in: 300 }),
    "msft.ghe.com",
  )

  expect(token).toBe("gho_enterprise_token")
  expect(captured).toHaveLength(6)
  expect(
    captured.every(
      ({ url }) => url === "https://msft.ghe.com/login/oauth/access_token",
    ),
  ).toBe(true)
  expect(sleeps).toEqual([6000, 10_000, 15_000, 15_000, 15_000])

  for (const request of captured) {
    const form = new URLSearchParams(request.body)
    expect(request.method).toBe("POST")
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    )
    expect(form.get("client_id")).toBe(GITHUB_CLIENT_ID)
    expect(form.get("device_code")).toBe("device-code")
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    )
  }
})

test("fails immediately for a terminal OAuth error", () => {
  const sleeps: Array<number> = []
  setPollAccessTokenRuntimeForTest({
    now: () => 1_000,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds)
      return Promise.resolve()
    },
  })
  globalThis.fetch = mock(() =>
    Promise.resolve(
      Response.json({
        error: "access_denied",
        error_description: "The user denied authorization",
      }),
    ),
  ) as unknown as typeof fetch

  expect(pollAccessToken(deviceCode(), "github.ghe.com")).rejects.toThrow(
    "The user denied authorization",
  )
  expect(sleeps).toEqual([])
})

test("stops polling when the device code expires", () => {
  const sleeps: Array<number> = []
  let currentTime = 50_000
  setPollAccessTokenRuntimeForTest({
    now: () => currentTime,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds)
      currentTime += milliseconds
      return Promise.resolve()
    },
  })
  globalThis.fetch = mock(() =>
    Promise.resolve(Response.json({ error: "authorization_pending" })),
  ) as unknown as typeof fetch

  expect(
    pollAccessToken(
      deviceCode({ expires_in: 10, interval: 5 }),
      "msft.ghe.com",
    ),
  ).rejects.toThrow("GitHub device code expired")
  expect(sleeps).toEqual([6000, 6000])
})
