import type { Context } from "hono"

import { Hono } from "hono"

import { authenticateCodexAccountRequest } from "~/lib/codex-account-identity"
import {
  codexReasoningOverridesSchema,
  createCodexReasoningPreferencesRepository,
} from "~/lib/storage/codex-reasoning-preferences-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

const FEATURE = "model_picker_reasoning_effort_visibility"

async function readSettings(c: Context): Promise<Response> {
  const claims = await authenticateCodexAccountRequest(c)
  if (claims instanceof Response) return claims
  const repository = createCodexReasoningPreferencesRepository(
    getStorageRuntime().storage,
  )
  return c.json({
    settings: { [FEATURE]: await repository.read(claims) },
  })
}

function invalidPreference(c: Context): Response {
  return c.json(
    {
      error: {
        message: "Invalid reasoning effort preference",
        type: "invalid_request_error",
      },
    },
    400,
  )
}

async function updateSettings(c: Context): Promise<Response> {
  const claims = await authenticateCodexAccountRequest(c, "PATCH")
  if (claims instanceof Response) return claims
  const features = c.req.queries("feature")
  const values = c.req.queries("value")
  const precondition = c.req.header("if-none-match")
  if (
    features?.length !== 1
    || features[0] !== FEATURE
    || values?.length !== 1
    || values[0].length > 4096
    || (precondition !== undefined && precondition !== "*")
  ) {
    return invalidPreference(c)
  }
  let value: unknown
  try {
    value = JSON.parse(values[0])
  } catch {
    return invalidPreference(c)
  }
  const parsed = codexReasoningOverridesSchema.safeParse(value)
  if (!parsed.success) return invalidPreference(c)
  const repository = createCodexReasoningPreferencesRepository(
    getStorageRuntime().storage,
  )
  const preference = await repository.update(
    claims,
    parsed.data,
    precondition === "*",
  )
  if (preference === null) {
    return c.json(
      {
        error: {
          message: "Reasoning preference already exists",
          type: "precondition_failed",
        },
      },
      412,
    )
  }
  return c.json({ [FEATURE]: preference })
}

export const codexSettingsRoutes = new Hono()
for (const prefix of ["", "/backend-api"]) {
  codexSettingsRoutes.all(`${prefix}/settings/user`, readSettings)
  codexSettingsRoutes.all(
    `${prefix}/settings/account_user_setting`,
    updateSettings,
  )
}
