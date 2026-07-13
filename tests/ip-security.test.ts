import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import { apiKeyGuard } from "~/lib/api-key-guard"
import { normalizeIpAddress, setIpAllowlistForTest } from "~/lib/ip-allowlist"
import {
  extractClientIp,
  isIpBlocked,
  isIpAllowedForWhitelistedRoute,
  leaseIp,
  recordFailedAttempt,
  resetIpSecurityForTest,
  unwhitelistIp,
} from "~/lib/ip-blocker"
import { createAuthMiddleware } from "~/lib/request-auth"
import { state } from "~/lib/state"

const originalTrustedProxies = process.env.COPILOT_TRUSTED_PROXY_CIDRS
const originalDateNow = Date.now
const originalApiKeyAuth = state.apiKeyAuth
const DAY_MS = 24 * 60 * 60 * 1000
let currentTime = 0

function setCurrentTime(timestamp: number): void {
  currentTime = timestamp
  Date.now = () => currentTime
}

function createIpApp(): Hono {
  const app = new Hono()
  app.get("/", (c) => c.json({ ip: extractClientIp(c) }))
  return app
}

afterEach(() => {
  Date.now = originalDateNow
  if (originalTrustedProxies === undefined) {
    delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
  } else {
    process.env.COPILOT_TRUSTED_PROXY_CIDRS = originalTrustedProxies
  }
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  state.apiKeyAuth = originalApiKeyAuth
})

test("fails closed without Bun socket-peer metadata", async () => {
  const response = await createIpApp().request("http://localhost/", {
    headers: {
      "x-real-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11",
    },
  })
  expect(await response.json()).toEqual({ ip: null })
})

test("ignores spoofed forwarding headers from an untrusted socket peer", async () => {
  process.env.COPILOT_TRUSTED_PROXY_CIDRS = "127.0.0.1/32"
  const response = await createIpApp().request("http://localhost/", {
    headers: {
      "x-copilot-peer-ip": "203.0.113.9",
      "x-real-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11",
    },
  })
  expect(await response.json()).toEqual({ ip: "203.0.113.9" })
})

test("accepts forwarding metadata only from exact configured proxy CIDRs", async () => {
  process.env.COPILOT_TRUSTED_PROXY_CIDRS = "10.10.0.0/16,2001:db8::/32"
  const app = createIpApp()
  const ipv4 = await app.request("http://localhost/", {
    headers: {
      "x-copilot-peer-ip": "10.10.4.5",
      "x-real-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11, 10.10.4.5",
    },
  })
  expect(await ipv4.json()).toEqual({ ip: "198.51.100.10" })

  const ipv6 = await app.request("http://localhost/", {
    headers: {
      "x-copilot-peer-ip": "2001:db8::5",
      "x-forwarded-for": "2001:db9::42",
    },
  })
  expect(await ipv6.json()).toEqual({ ip: "2001:db9::42" })
})

test("normalizes addresses and gives disabled managed entries precedence", async () => {
  expect(normalizeIpAddress("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1")
  expect(normalizeIpAddress("::ffff:192.0.2.1")).toBe("192.0.2.1")
  expect(normalizeIpAddress("not-an-ip")).toBeNull()

  setIpAllowlistForTest([{ ip: "2001:db8::1", enabled: false }])
  expect(leaseIp("2001:0db8::1", 60_000)).toBe(true)
  expect(await isIpAllowedForWhitelistedRoute("2001:db8::1")).toBe(false)
})

test("temporary leases expire and do not create persistent allowlist entries", async () => {
  setIpAllowlistForTest([])
  expect(leaseIp("198.51.100.40", 50)).toBe(true)
  expect(await isIpAllowedForWhitelistedRoute("198.51.100.40")).toBe(true)
  await Bun.sleep(75)
  expect(await isIpAllowedForWhitelistedRoute("198.51.100.40")).toBe(false)
})

test("bans an IP after its third failure inside a rolling 24-hour window", () => {
  const ip = "198.51.100.50"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  expect(recordFailedAttempt(ip)).toBe(1)
  currentTime += 12 * 60 * 60 * 1000
  expect(recordFailedAttempt(ip)).toBe(2)
  currentTime += 11 * 60 * 60 * 1000
  expect(recordFailedAttempt(ip)).toBe(3)

  expect(isIpBlocked(ip)).toBe(true)
})

test("keeps a ban active until exactly 24 hours after the third failure", () => {
  const ip = "198.51.100.51"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)

  currentTime += DAY_MS - 1
  expect(isIpBlocked(ip)).toBe(true)
  currentTime += 1
  expect(isIpBlocked(ip)).toBe(false)
})

test("prunes failures that are at least 24 hours old", () => {
  const ip = "198.51.100.52"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  expect(recordFailedAttempt(ip)).toBe(1)
  expect(recordFailedAttempt(ip)).toBe(2)
  currentTime += DAY_MS

  expect(recordFailedAttempt(ip)).toBe(1)
  expect(isIpBlocked(ip)).toBe(false)
})

test("leases bypass a ban without clearing its failure history", () => {
  const ip = "198.51.100.53"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)

  expect(leaseIp(ip, 60_000)).toBe(true)
  expect(isIpBlocked(ip)).toBe(false)

  expect(unwhitelistIp(ip)).toBe(true)
  expect(isIpBlocked(ip)).toBe(true)
})

test("does not extend an active ban after a fourth failure", () => {
  const ip = "198.51.100.54"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)

  currentTime += 12 * 60 * 60 * 1000
  recordFailedAttempt(ip)

  currentTime += 12 * 60 * 60 * 1000 - 1
  expect(isIpBlocked(ip)).toBe(true)
  currentTime += 1
  expect(isIpBlocked(ip)).toBe(false)
})

test("route-permitted allowlist bypass does not record a failure", async () => {
  const ip = "198.51.100.55"
  state.apiKeyAuth = "gateway-secret"
  setIpAllowlistForTest([{ ip, enabled: true }])
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.all("*", (c) => c.json({ ok: true }))

  const response = await app.request(
    "https://api.anthropic.com/upstream/path",
    {
      headers: {
        host: "api.anthropic.com",
        "x-copilot-peer-ip": ip,
      },
    },
  )
  expect(response.status).toBe(200)

  setIpAllowlistForTest([])
  expect(isIpBlocked(ip)).toBe(false)
})

test("config-based global auth records failed credentials", async () => {
  const ip = "198.51.100.56"
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => ["config-secret"],
      allowUnauthenticatedPaths: [],
    }),
  )
  app.get("/protected", (c) => c.json({ ok: true }))

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (
        await app.request("http://localhost/protected", {
          headers: {
            "x-api-key": "wrong-key",
            "x-copilot-peer-ip": ip,
          },
        })
      ).status,
    ).toBe(401)
  }
  expect(isIpBlocked(ip)).toBe(true)
  expect(
    (
      await app.request("http://localhost/protected", {
        headers: {
          "x-api-key": "config-secret",
          "x-copilot-peer-ip": ip,
        },
      })
    ).status,
  ).toBe(401)
})
