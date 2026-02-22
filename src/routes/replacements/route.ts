import { Hono } from "hono"

import {
  addReplacement,
  clearUserReplacements,
  getAllReplacements,
  getUserReplacements,
  removeReplacement,
  toggleReplacement,
  updateReplacement,
} from "~/lib/auto-replace"

export const replacementsRoute = new Hono()

// Get all replacement rules
replacementsRoute.get("/", async (c) => {
  return c.json({
    all: await getAllReplacements(),
    user: await getUserReplacements(),
  })
})

// Add a new replacement rule
replacementsRoute.post("/", async (c) => {
  const body = await c.req.json<{
    pattern: string
    replacement?: string
    isRegex?: boolean
    name?: string
  }>()

  if (!body.pattern) {
    return c.json({ error: "Pattern is required" }, 400)
  }

  const rule = await addReplacement(body.pattern, body.replacement ?? "", {
    isRegex: body.isRegex ?? false,
    name: body.name,
  })

  return c.json(rule, 201)
})

// Delete a replacement rule
replacementsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const success = await removeReplacement(id)

  if (!success) {
    return c.json({ error: "Replacement not found or is a system rule" }, 404)
  }

  return c.json({ success: true })
})

// Update a replacement rule
replacementsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{
    name?: string
    pattern?: string
    replacement?: string
    isRegex?: boolean
    enabled?: boolean
  }>()

  const rule = await updateReplacement(id, body)

  if (!rule) {
    return c.json({ error: "Replacement not found or is a system rule" }, 404)
  }

  return c.json(rule)
})

// Toggle a replacement rule
replacementsRoute.patch("/:id/toggle", async (c) => {
  const id = c.req.param("id")
  const rule = await toggleReplacement(id)

  if (!rule) {
    return c.json({ error: "Replacement not found or is a system rule" }, 404)
  }

  return c.json(rule)
})

// Clear all user replacements
replacementsRoute.delete("/", async (c) => {
  await clearUserReplacements()
  return c.json({ success: true })
})
