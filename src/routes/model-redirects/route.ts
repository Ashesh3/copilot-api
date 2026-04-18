import { Hono } from "hono"

import {
  addModelRedirect,
  clearModelRedirects,
  getAllModelRedirects,
  removeModelRedirect,
  toggleModelRedirect,
  updateModelRedirect,
} from "~/lib/model-redirect"

export const modelRedirectsRoute = new Hono()

modelRedirectsRoute.get("/", async (c) => {
  return c.json(await getAllModelRedirects())
})

modelRedirectsRoute.post("/", async (c) => {
  const body = await c.req.json<{
    sourceModel: string
    targetModel: string
    name?: string
  }>()

  if (!body.sourceModel || !body.targetModel) {
    return c.json({ error: "sourceModel and targetModel are required" }, 400)
  }

  const rule = await addModelRedirect(body.sourceModel, body.targetModel, {
    name: body.name,
  })
  return c.json(rule, 201)
})

modelRedirectsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const success = await removeModelRedirect(id)
  if (!success) return c.json({ error: "Redirect not found" }, 404)
  return c.json({ success: true })
})

modelRedirectsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{
    name?: string
    sourceModel?: string
    targetModel?: string
    enabled?: boolean
  }>()
  const rule = await updateModelRedirect(id, body)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
})

modelRedirectsRoute.patch("/:id/toggle", async (c) => {
  const id = c.req.param("id")
  const rule = await toggleModelRedirect(id)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
})

modelRedirectsRoute.delete("/", async (c) => {
  await clearModelRedirects()
  return c.json({ success: true })
})
