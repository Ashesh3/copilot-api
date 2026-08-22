import { afterEach, beforeEach, expect, test } from "bun:test"

import { resetIpSecurityForTest } from "~/lib/ip-blocker"
import { resolvePublicOrigin, toWebSocketUrl } from "~/lib/public-origin"

const originalPublicBase = process.env.COPILOT_PUBLIC_BASE_URL
const originalTrustedCidrs = process.env.COPILOT_TRUSTED_PROXY_CIDRS

beforeEach(() => {
  delete process.env.COPILOT_PUBLIC_BASE_URL
  delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
  resetIpSecurityForTest()
})

afterEach(() => {
  if (originalPublicBase === undefined)
    delete process.env.COPILOT_PUBLIC_BASE_URL
  else process.env.COPILOT_PUBLIC_BASE_URL = originalPublicBase
  if (originalTrustedCidrs === undefined)
    delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
  else process.env.COPILOT_TRUSTED_PROXY_CIDRS = originalTrustedCidrs
  resetIpSecurityForTest()
})

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    "http://internal.example.test:8443/private/path?ignored=1",
    {
      headers,
    },
  )
}

test("configured public base wins and preserves a normalized prefix", () => {
  process.env.COPILOT_PUBLIC_BASE_URL =
    "https://public.example.test:9443/gateway///"
  const resolved = resolvePublicOrigin(
    request({
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-host": "forged.example.test",
      "x-forwarded-proto": "http",
    }),
  )
  expect(resolved.toString()).toBe("https://public.example.test:9443/gateway")
  resolved.pathname = "/changed"
  expect(resolvePublicOrigin(request()).toString()).toBe(
    "https://public.example.test:9443/gateway",
  )
})

test("invalid configured values fall back without promoting untrusted forwarding", () => {
  const invalidValues = [
    "/relative",
    "//public.example.test/base",
    "ftp://public.example.test/base",
    "https://user:pass@public.example.test/base",
    "https://public.example.test/base?query=1",
    "https://public.example.test/base#fragment",
    String.raw`https://public.example.test/a\b`,
    "https://public.example.test/a/../b",
    "https://public.example.test/a/%2e%2e/b",
    "https://public.example.test/a/%2E%2Fsecret",
    " \t ",
  ]
  for (const value of invalidValues) {
    process.env.COPILOT_PUBLIC_BASE_URL = value
    resetIpSecurityForTest()
    expect(
      resolvePublicOrigin(
        request({
          "x-copilot-peer-ip": "198.51.100.2",
          "x-forwarded-host": "forged.example.test",
          "x-forwarded-proto": "https",
        }),
      ).toString(),
    ).toBe("http://internal.example.test:8443/")
  }
})

test("trusted peers may supply only a complete valid forwarded pair", () => {
  process.env.COPILOT_TRUSTED_PROXY_CIDRS = "10.10.0.0/16,2001:db8::/32"
  resetIpSecurityForTest()

  expect(
    resolvePublicOrigin(
      request({
        "x-copilot-peer-ip": "10.10.2.3",
        "x-forwarded-host": "public.example.test:9443, ignored.example.test",
        "x-forwarded-proto": "HTTPS, http",
      }),
    ).toString(),
  ).toBe("https://public.example.test:9443/")

  for (const headers of [
    {
      "x-copilot-peer-ip": "10.10.2.3",
      "x-forwarded-proto": "https",
    },
    {
      "x-copilot-peer-ip": "10.10.2.3",
      "x-forwarded-host": "public.example.test",
    },
    {
      "x-copilot-peer-ip": "10.10.2.3",
      "x-forwarded-host": "public.example.test/path",
      "x-forwarded-proto": "https",
    },
    {
      "x-forwarded-for": "10.10.2.3",
      "x-forwarded-host": "public.example.test",
      "x-forwarded-proto": "https",
    },
  ] as Array<Record<string, string>>) {
    expect(resolvePublicOrigin(request(headers)).toString()).toBe(
      "http://internal.example.test:8443/",
    )
  }
})

test("websocket URLs preserve the public prefix and encode relative segments", () => {
  const origin = new URL("https://public.example.test:9443/gateway/%E2%9C%93")
  const websocket = toWebSocketUrl(origin, ["ws", "direct", "dc id/with?#%"])
  expect(websocket.toString()).toBe(
    "wss://public.example.test:9443/gateway/%E2%9C%93/ws/direct/dc%20id%2Fwith%3F%23%25",
  )
  expect(origin.toString()).toBe(
    "https://public.example.test:9443/gateway/%E2%9C%93",
  )
})

test("websocket URL segments cannot reset or traverse the public prefix", () => {
  const origin = new URL("http://public.example.test/prefix")
  for (const segment of ["", ".", "..", String.raw`a\b`, "\u0000"])
    expect(() => toWebSocketUrl(origin, [segment])).toThrow()
  for (const segment of ["/reset", "a/b", "a?b", "a#b"]) {
    const joined = toWebSocketUrl(origin, [segment])
    expect(joined.host).toBe(origin.host)
    expect(joined.pathname.startsWith("/prefix/")).toBe(true)
  }
})
