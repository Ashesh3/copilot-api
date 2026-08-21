import { Hono, type Handler } from "hono"

export const healthRoutes = new Hono()

healthRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return c.json({ error: "Not found" }, 404)
  await next()
})

// Keep this response free of configuration, session, dependency, and version
// information while retaining the nested compatibility alias.
const healthHandler: Handler = (c) => c.json({ status: "ok" })

healthRoutes.get("/", healthHandler)
healthRoutes.get("/health", healthHandler)
healthRoutes.all("*", (c) => c.json({ error: "Not found" }, 404))
