import type { Context } from "hono"

import {
  getAllModelSettings,
  isReasoningEffort,
  MAX_FORCED_SYSTEM_PROMPT_LENGTH,
  type ModelRequestParameter,
  removeModelSettings,
  setModelSettings,
} from "~/lib/model-settings"

type ModelSettingsEffort = "low" | "medium" | "high" | "xhigh" | "max"

interface ModelSettingsRequestBody {
  model?: string
  sentryModelName?: string | null
  supportedReasoningEfforts?: Array<ModelSettingsEffort> | null
  defaultReasoningEffort?: ModelSettingsEffort | null
  omitReasoningEffort?: boolean | null
  implicitReasoningDefault?: boolean | null
  exposeVirtualReasoningModels?: boolean | null
  supportsAssistantPrefill?: boolean | null
  unsupportedRequestParameters?: Array<ModelRequestParameter> | null
  forcedSystemPrompt?: string | null
  clearOtherSystemPrompts?: boolean | null
}

export async function handleListModelSettings(c: Context) {
  return c.json(await getAllModelSettings())
}

export async function handleSetModelSettings(c: Context) {
  const body = await c.req.json<ModelSettingsRequestBody>()

  if (!body.model || typeof body.model !== "string") {
    return c.json({ error: "model is required" }, 400)
  }

  const validationError = validateModelSettingsBody(body)
  if (validationError) return c.json({ error: validationError }, 400)

  const settings = await setModelSettings(body.model, modelSettingsUpdate(body))
  return c.json(settings)
}

function validateModelSettingsBody(
  body: ModelSettingsRequestBody,
): string | undefined {
  if (!isValidOptionalString(body.sentryModelName)) {
    return "sentryModelName is invalid"
  }

  if (!isValidSupportedReasoningEfforts(body.supportedReasoningEfforts)) {
    return "supportedReasoningEfforts is invalid"
  }

  if (!isValidModelSettingsEffort(body.defaultReasoningEffort)) {
    return "defaultReasoningEffort is invalid"
  }

  const omitError = validateOmitReasoningEffortBody(body)
  if (omitError) return omitError

  if (!isValidUnsupportedRequestParameters(body.unsupportedRequestParameters)) {
    return "unsupportedRequestParameters is invalid"
  }

  if (!isValidOptionalBoolean(body.supportsAssistantPrefill)) {
    return "supportsAssistantPrefill is invalid"
  }

  return validateForcedSystemPromptBody(body)
}

function validateOmitReasoningEffortBody(
  body: ModelSettingsRequestBody,
): string | undefined {
  if (!isValidOptionalBoolean(body.omitReasoningEffort)) {
    return "omitReasoningEffort is invalid"
  }
  const hasEfforts =
    (body.supportedReasoningEfforts?.length ?? 0) > 0
    || (body.defaultReasoningEffort !== undefined
      && body.defaultReasoningEffort !== null)
  if (body.omitReasoningEffort === true && hasEfforts) {
    return "omitReasoningEffort cannot be combined with supportedReasoningEfforts or defaultReasoningEffort"
  }
  return undefined
}

function validateForcedSystemPromptBody(
  body: ModelSettingsRequestBody,
): string | undefined {
  const prompt = body.forcedSystemPrompt
  if (!isValidOptionalString(prompt)) return "forcedSystemPrompt is invalid"
  if (
    typeof prompt === "string"
    && prompt.length > MAX_FORCED_SYSTEM_PROMPT_LENGTH
  )
    return `forcedSystemPrompt must be at most ${MAX_FORCED_SYSTEM_PROMPT_LENGTH.toLocaleString("en-US")} characters`
  if (!isValidOptionalBoolean(body.clearOtherSystemPrompts)) {
    return "clearOtherSystemPrompts is invalid"
  }
  return undefined
}

function isValidOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function isValidSupportedReasoningEfforts(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (Array.isArray(value)
      && value.every((effort) => isValidModelSettingsEffort(effort)))
  )
}

function isValidModelSettingsEffort(
  effort: unknown,
): effort is ModelSettingsEffort | null | undefined {
  return (
    effort === undefined
    || effort === null
    || effort === "max"
    || isReasoningEffort(effort)
  )
}

function isValidUnsupportedRequestParameters(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (Array.isArray(value)
      && value.every(
        (parameter) => parameter === "temperature" || parameter === "top_p",
      ))
  )
}

function isValidOptionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean"
}

function modelSettingsUpdate(body: ModelSettingsRequestBody) {
  return {
    ...(body.sentryModelName !== undefined ?
      { sentryModelName: body.sentryModelName }
    : {}),
    ...(body.supportedReasoningEfforts !== undefined ?
      { supportedReasoningEfforts: body.supportedReasoningEfforts }
    : {}),
    ...(body.defaultReasoningEffort !== undefined ?
      { defaultReasoningEffort: body.defaultReasoningEffort }
    : {}),
    ...(body.omitReasoningEffort !== undefined ?
      { omitReasoningEffort: body.omitReasoningEffort }
    : {}),
    ...(body.implicitReasoningDefault !== undefined ?
      { implicitReasoningDefault: body.implicitReasoningDefault }
    : {}),
    ...(body.exposeVirtualReasoningModels !== undefined ?
      { exposeVirtualReasoningModels: body.exposeVirtualReasoningModels }
    : {}),
    ...(body.supportsAssistantPrefill !== undefined ?
      { supportsAssistantPrefill: body.supportsAssistantPrefill }
    : {}),
    ...(body.unsupportedRequestParameters !== undefined ?
      { unsupportedRequestParameters: body.unsupportedRequestParameters }
    : {}),
    ...(body.forcedSystemPrompt !== undefined ?
      { forcedSystemPrompt: body.forcedSystemPrompt }
    : {}),
    ...(body.clearOtherSystemPrompts !== undefined ?
      { clearOtherSystemPrompts: body.clearOtherSystemPrompts }
    : {}),
  }
}

export async function handleDeleteModelSettings(c: Context) {
  const model = c.req.param("model") ?? ""
  const removed = await removeModelSettings(model)
  if (!removed) return c.json({ error: "Model settings not found" }, 404)
  return c.json({ success: true })
}
