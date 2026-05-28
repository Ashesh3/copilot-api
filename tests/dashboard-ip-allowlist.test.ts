import { afterAll, beforeEach, expect, test } from "bun:test"

import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { state } from "../src/lib/state"
import { getDashboardPage } from "../src/routes/dashboard/page"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth

beforeEach(() => {
  state.apiKeyAuth = "dashboard-secret"
  setIpAllowlistForTest([])
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
})

test("dashboard auth auto-adds the observed client IP", async () => {
  const overviewResponse = await server.request("/dashboard/api/overview", {
    headers: {
      "x-api-key": "dashboard-secret",
      "x-forwarded-for": "198.51.100.20",
    },
  })
  expect(overviewResponse.status).toBe(200)

  const response = await server.request("/dashboard/api/ip-allowlist", {
    headers: { "x-api-key": "dashboard-secret" },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as Array<{
    ip: string
    enabled: boolean
  }>
  const entry = body.find((item) => item.ip === "198.51.100.20")
  expect(entry?.enabled).toBe(true)
})

test("dashboard can add, disable, enable, and remove IPv6 allowlist entries", async () => {
  const ipv6 = "2406:7400:63:c69b:78ad:65b1:41f5:ccce"

  const addResponse = await server.request("/dashboard/api/ip-allowlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "dashboard-secret",
    },
    body: JSON.stringify({ ip: ipv6 }),
  })
  expect(addResponse.status).toBe(200)

  const disableResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-api-key": "dashboard-secret",
      },
      body: JSON.stringify({ enabled: false }),
    },
  )
  expect(disableResponse.status).toBe(200)
  expect((await disableResponse.json()) as { enabled: boolean }).toMatchObject({
    enabled: false,
  })

  const enableResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-api-key": "dashboard-secret",
      },
      body: JSON.stringify({ enabled: true }),
    },
  )
  expect(enableResponse.status).toBe(200)
  expect((await enableResponse.json()) as { enabled: boolean }).toMatchObject({
    enabled: true,
  })

  const deleteResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "DELETE",
      headers: { "x-api-key": "dashboard-secret" },
    },
  )
  expect(deleteResponse.status).toBe(200)
})

test("dashboard renders IP allowlist controls and public IP detection", () => {
  const page = getDashboardPage()

  expect(page).toContain("IP Allowlist")
  expect(page).toContain("api4.ipify.org")
  expect(page).toContain("api6.ipify.org")
  expect(page).toContain("setIpAllowlistEnabled")
})
