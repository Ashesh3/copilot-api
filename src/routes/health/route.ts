import { Hono, type Handler } from "hono"

export const healthRoutes = new Hono()

healthRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: "Not found" }, 404)
  }
  await next()
})

// Keep this response free of configuration, session, dependency, and version
// information while retaining the nested compatibility alias.
const healthHandler: Handler = (c) => c.json({ status: "ok" })

healthRoutes.get("/", healthHandler)
healthRoutes.get("/health", healthHandler)
healthRoutes.on("HEAD", ["/", "/health"], (c) => c.body(null, 200))
healthRoutes.all("*", (c) => c.json({ error: "Not found" }, 404))
