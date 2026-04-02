import { Hono } from "hono"

import { getRemoteControlPage } from "./page"

export const remoteRoutes = new Hono()

// Serve the remote control page (no auth needed — the page handles auth via API calls)
remoteRoutes.get("/", (c) => {
  return c.html(getRemoteControlPage())
})
