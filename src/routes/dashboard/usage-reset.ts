import type { Context } from "hono"

import { createHash, randomUUID } from "node:crypto"

import { getSettingsActorId } from "~/lib/storage/domain-settings"
import { getStoreRevision } from "~/lib/storage/operations"
import { getHistoryRuntime } from "~/lib/telemetry-writer"

/** Mounted after administrator session and CSRF validation. */
export async function handleResetUsage(context: Context): Promise<Response> {
  context.header("Cache-Control", "no-store")
  const actorId = getSettingsActorId()
  if (!actorId?.startsWith("admin:"))
    return context.json({ error: "Unauthorized" }, 401)

  const runtime = getHistoryRuntime()
  await runtime.writer.reset({
    actorId,
    operationId: context.req.header("Idempotency-Key") ?? randomUUID(),
    expectedRevision: await getStoreRevision(runtime.storage),
    kind: "history.reset",
    inputDigest: createHash("sha256").update("{}").digest("hex"),
  })
  return context.json({ success: true })
}
