import type { Context } from "hono"

import {
  isValidPermissionReviewModel,
  setPermissionReviewSettings,
} from "~/lib/config"

export async function handleSetPermissionReview(c: Context) {
  const body: unknown = await c.req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body))
    return c.json({ error: "Expected a JSON object" }, 400)
  if (
    !("model" in body)
    || (body.model !== null && !isValidPermissionReviewModel(body.model))
  )
    return c.json(
      {
        error:
          "model must be null or a string of at most 256 characters without control characters",
      },
      400,
    )
  if (!("allowAll" in body) || typeof body.allowAll !== "boolean")
    return c.json({ error: "allowAll must be a boolean" }, 400)

  const settings = await setPermissionReviewSettings({
    model: body.model,
    allowAll: body.allowAll,
  })
  return c.json({
    permissionReviewModel: settings.model,
    permissionReviewAllowAll: settings.allowAll,
  })
}
