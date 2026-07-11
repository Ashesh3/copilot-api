import { afterEach, beforeEach, expect, test } from "bun:test"

import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

let admin: TestAdminSession

beforeEach(async () => {
  setIpAllowlistForTest([])
  admin = await createTestAdminSession(true)
})

afterEach(() => {
  resetTestAdminSession()
})

test("dashboard login does not automatically trust the observed IP", async () => {
  const overviewResponse = await server.request("/dashboard/api/overview", {
    headers: {
      cookie: admin.cookie,
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": "198.51.100.20",
    },
  })
  expect(overviewResponse.status).toBe(200)

  const response = await server.request("/dashboard/api/ip-allowlist", {
    headers: adminHeaders(admin, false),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([])
})

test("dashboard can add, disable, enable, and remove IPv6 allowlist entries", async () => {
  const ipv6 = "2406:7400:63:c69b:78ad:65b1:41f5:ccce"

  const addResponse = await server.request("/dashboard/api/ip-allowlist", {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({ ip: ipv6 }),
  })
  expect(addResponse.status).toBe(200)

  const disableResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: false }),
    },
  )
  expect(disableResponse.status).toBe(200)
  expect(await disableResponse.json()).toMatchObject({ enabled: false })

  const enableResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: true }),
    },
  )
  expect(enableResponse.status).toBe(200)
  expect(await enableResponse.json()).toMatchObject({ enabled: true })

  const deleteResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    { method: "DELETE", headers: adminHeaders(admin) },
  )
  expect(deleteResponse.status).toBe(200)
})

test("dashboard bundle ships manual IP allowlist controls only", () => {
  expect(DASHBOARD_HTML).toContain("IP Allowlist")
  expect(DASHBOARD_HTML).not.toContain("api4.ipify.org")
  expect(DASHBOARD_HTML).not.toContain("api6.ipify.org")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/ip-allowlist")
})
