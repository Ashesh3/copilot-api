import { routedControlPlaneFetch } from "~/lib/account-router"
import { HTTPError, LocalHTTPError } from "~/lib/error"
import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"

export interface EnableModelPolicyResult {
  can_be_enabled?: boolean
  error?: string
  success: boolean
}

export interface CreateCopilotAutoSessionOptions {
  hasImage: boolean
  multiTurn?: Record<string, unknown>
  previousUserMessages?: Array<string>
  prompt: string
  signal?: AbortSignal
  tier?: string
}

export interface PredictCopilotIntentOptions {
  availableModels: Array<string>
  hasImage: boolean
  payload: Record<string, unknown>
  sessionToken: string
  signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidControlPlaneResponse(): HTTPError {
  return new HTTPError(
    "Invalid Copilot control-plane response",
    new Response(null, { status: 502 }),
  )
}

function missingSessionTokenError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "missing_copilot_session_token",
      message: "Copilot-Session-Token is required for intent prediction.",
      param: "Copilot-Session-Token",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

async function routedControlPlaneJson(options: {
  body?: Record<string, unknown>
  copilotSessionToken?: string
  modelId?: string
  path: string
  signal?: AbortSignal
}): Promise<Record<string, unknown>> {
  const { localError, response } = await routedControlPlaneFetch(options)
  if (localError) throw localError
  if (!response.ok) {
    throw new HTTPError("Copilot control-plane request failed", response)
  }

  let result: unknown
  try {
    result = await response.json()
  } catch {
    throw invalidControlPlaneResponse()
  }
  if (!isRecord(result)) throw invalidControlPlaneResponse()
  return result
}

export async function enableCopilotModelPolicy(
  modelId: string,
  signal?: AbortSignal,
): Promise<EnableModelPolicyResult> {
  const path = `/models/${encodeURIComponent(modelId)}/policy`
  const { localError, response } = await routedControlPlaneFetch({
    modelId,
    path,
    signal,
  })
  if (localError) throw localError
  if (response.ok) return { success: true }
  if (response.status === 403) {
    return {
      success: false,
      can_be_enabled: false,
      error:
        "This model cannot be enabled. Your organization or subscription may not permit self-service model enablement.",
    }
  }
  throw new HTTPError("Copilot model policy request failed", response)
}

export async function createCopilotModelSession(options: {
  existingToken?: string
  signal?: AbortSignal
}): Promise<Record<string, unknown>> {
  const existingToken = sanitizeCopilotHeaderValue(options.existingToken)
  return await routedControlPlaneJson({
    ...(existingToken ?
      { copilotSessionToken: existingToken }
    : { body: { auto_mode: { model_hints: ["auto"] } } }),
    path: "/models/session",
    signal: options.signal,
  })
}

export async function createCopilotAutoSession(
  options: CreateCopilotAutoSessionOptions,
): Promise<Record<string, unknown>> {
  return await routedControlPlaneJson({
    body: {
      prompt: options.prompt,
      has_image: options.hasImage,
      ...(options.tier === undefined ? {} : { tier: options.tier }),
      ...(options.multiTurn === undefined ?
        {}
      : { multi_turn: options.multiTurn }),
      ...(options.previousUserMessages === undefined ?
        {}
      : { previous_user_messages: options.previousUserMessages }),
    },
    path: "/auto",
    signal: options.signal,
  })
}

export async function predictCopilotIntent(
  options: PredictCopilotIntentOptions,
): Promise<Record<string, unknown>> {
  const sessionToken = sanitizeCopilotHeaderValue(options.sessionToken)
  if (!sessionToken) throw missingSessionTokenError()
  const {
    available_models: _ignoredAvailableModels,
    has_image: _ignoredHasImage,
    ...payload
  } = options.payload
  return await routedControlPlaneJson({
    body: {
      ...payload,
      available_models: options.availableModels,
      has_image: options.hasImage,
    },
    copilotSessionToken: sessionToken,
    path: "/models/session/intent",
    signal: options.signal,
  })
}
