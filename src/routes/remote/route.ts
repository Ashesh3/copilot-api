import { Hono } from "hono"

import {
  extractClientIp,
  isIpAllowedForWhitelistedRoute,
} from "~/lib/ip-blocker"

import { getRemoteControlPage } from "./page"

export const remoteRoutes = new Hono()

// Serve the remote control page (IP-allowlist gated — the page handles
// further auth via dashboard API calls)
remoteRoutes.get("/", async (c) => {
  const clientIp = extractClientIp(c)
  if (clientIp === null || !(await isIpAllowedForWhitelistedRoute(clientIp))) {
    return c.notFound()
  }
  return c.html(getRemoteControlPage())
})
