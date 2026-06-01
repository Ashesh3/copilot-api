import { Hono } from "hono"

import { getRemoteControlPage } from "./page"

export const remoteRoutes = new Hono()

// Serve the remote control page (no auth on HTML; the page uses dashboard
// APIs which are themselves API-key + IP-ban protected).
remoteRoutes.get("/", (c) => {
  return c.html(getRemoteControlPage())
})
