import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import { normalizeIpAddress, setIpAllowlistForTest } from "~/lib/ip-allowlist"
import {
  extractClientIp,
  isIpAllowedForWhitelistedRoute,
  leaseIp,
  resetIpSecurityForTest,
} from "~/lib/ip-blocker"

const originalTrustedProxies = process.env.COPILOT_TRUSTED_PROXY_CIDRS

function createIpApp(): Hono {
  const app = new Hono()
  app.get("/", (c) => c.json({ ip: extractClientIp(c) }))
  return app
}

afterEach(() => {
  if (originalTrustedProxies === undefined) {
    delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
  } else {
    process.env.COPILOT_TRUSTED_PROXY_CIDRS = originalTrustedProxies
  }
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
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
  expect(leaseIp("198.51.100.40", 1)).toBe(true)
  expect(await isIpAllowedForWhitelistedRoute("198.51.100.40")).toBe(true)
  await Bun.sleep(5)
  expect(await isIpAllowedForWhitelistedRoute("198.51.100.40")).toBe(false)
})
