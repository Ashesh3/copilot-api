import type { Context } from "hono"

import {
  authenticateAdminRequest,
  validateAdminPasswordHash,
} from "~/lib/admin-auth"
import { exportDatabaseResponse } from "~/lib/database-export"
import { createAdminRepository } from "~/lib/storage/admin-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

export async function handleExportDatabase(
  context: Context,
): Promise<Response> {
  context.header("Cache-Control", "no-store")
  if (!(await authenticateAdminRequest(context.req.raw, { requireCsrf: true })))
    return context.json({ error: "Unauthorized" }, 401)

  let body: unknown
  try {
    body = await context.req.json()
  } catch {
    return context.json({ error: "Invalid database export request" }, 400)
  }
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || !("currentPassword" in body)
    || typeof body.currentPassword !== "string"
    || body.currentPassword.length === 0
  )
    return context.json(
      { error: "Current administrator password is required" },
      400,
    )

  const runtime = getStorageRuntime()
  const admin = await createAdminRepository(runtime.storage).get()
  if (
    !admin
    || !(await Bun.password.verify(
      body.currentPassword,
      validateAdminPasswordHash(admin.passwordHash),
    ))
  )
    return context.json({ error: "Authentication failed" }, 401)

  return await exportDatabaseResponse(
    runtime.config.path,
    context.req.raw.signal,
  )
}
