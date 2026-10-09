import type { Context } from "hono"

import {
  getCodexCleanupModel,
  getSmallModel,
  setCodexCleanupModel,
} from "~/lib/config"
import { state } from "~/lib/state"

export async function handleSetCodexCleanupModel(c: Context) {
  const body = await c.req.json<{ model?: string | null }>().catch(() => null)
  if (body === null) {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const raw = body.model
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return c.json({ error: "model must be a string or null" }, 400)
  }

  const trimmed =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null

  if (trimmed !== null) {
    const allowed = new Set(state.models?.data.map((m) => m.id) ?? [])
    if (allowed.size > 0 && !allowed.has(trimmed)) {
      return c.json({ error: `Unknown model: ${trimmed}` }, 400)
    }
  }

  await setCodexCleanupModel(trimmed)
  return c.json({
    codexCleanupModel: getCodexCleanupModel(),
    codexCleanupModelDefault: getSmallModel(),
  })
}
