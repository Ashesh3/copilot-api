import { Hono } from "hono"

export const healthRoutes = new Hono()

healthRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return c.json({ error: "Not found" }, 404)
  await next()
})

// Intentionally expose only GET /health/health. Keep this response free of
// configuration, session, dependency, and version information.
healthRoutes.get("/health", (c) => c.json({ status: "ok" }))
