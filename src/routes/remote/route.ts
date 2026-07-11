import { Hono } from "hono"

import { authenticateAdminRequest } from "~/lib/admin-auth"
import { secureHtml } from "~/lib/secure-html"

import { getRemoteControlPage } from "./page"

export const remoteRoutes = new Hono()

remoteRoutes.get("/", async (c) => {
  const session = await authenticateAdminRequest(c.req.raw)
  if (!session) return c.redirect("/dashboard", 302)
  return secureHtml(c, getRemoteControlPage())
})
