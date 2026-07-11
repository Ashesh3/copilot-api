import { Hono } from "hono"

export const featureFlagsRoutes = new Hono()

featureFlagsRoutes.all("*", (c) => c.redirect("/dashboard#flags", 302))
