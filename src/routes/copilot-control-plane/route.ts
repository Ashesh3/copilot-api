import type { Context } from "hono"

import { Hono } from "hono"

import { getLastUsedAccountId } from "~/lib/account-router"
import {
  createInvalidJsonBodyError,
  createInvalidRequestError,
  forwardError,
} from "~/lib/error"
import { setRequestContext } from "~/lib/request-logger"
import {
  createCopilotAutoSession,
  createCopilotModelSession,
  predictCopilotIntent,
} from "~/services/copilot/control-plane"
import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"

export const copilotControlPlaneRoutes = new Hono()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isNonEmptyStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((entry) => isNonEmptyString(entry))
  )
}

function isStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  )
}

async function readJsonRecord(c: Context): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await c.req.json()
  } catch {
    throw createInvalidJsonBodyError()
  }
  if (!isRecord(value)) {
    throw createInvalidRequestError(
      "The request body must be a JSON object.",
      "body",
    )
  }
  return value
}

function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean {
  const value = body[field]
  if (value === undefined) return false
  if (typeof value !== "boolean") {
    throw createInvalidRequestError(`${field} must be a boolean.`, field)
  }
  return value
}

function optionalPreviousUserMessages(
  body: Record<string, unknown>,
): Array<string> | undefined {
  const value = body.previous_user_messages
  if (value === undefined) return undefined
  if (!isStringArray(value)) {
    throw createInvalidRequestError(
      "previous_user_messages must be an array of strings.",
      "previous_user_messages",
    )
  }
  return value
}

function optionalTier(body: Record<string, unknown>): string | undefined {
  const value = body.tier
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw createInvalidRequestError("tier must be a string.", "tier")
  }
  return value
}

function optionalMultiTurn(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = body.multi_turn
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw createInvalidRequestError(
      "multi_turn must be a JSON object.",
      "multi_turn",
    )
  }
  return value
}

function optionalRoutingIntent(
  body: Record<string, unknown>,
): string | undefined {
  const value = body.routing_intent
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw createInvalidRequestError(
      "routing_intent must be a string.",
      "routing_intent",
    )
  }
  return value
}

function sessionToken(c: Context): string | undefined {
  return sanitizeCopilotHeaderValue(c.req.header("Copilot-Session-Token"))
}

function recordControlPlaneContext(
  c: Context,
  model: string,
  inputLength: number,
): void {
  setRequestContext(c, {
    accountId: getLastUsedAccountId(),
    inputLength,
    model,
    provider: "GitHub Copilot",
    requestedModel: model,
  })
}

async function handleModelSession(c: Context): Promise<Response> {
  try {
    const result = await createCopilotModelSession({
      existingToken: sessionToken(c),
      signal: c.req.raw.signal,
    })
    recordControlPlaneContext(c, "model-session", 0)
    return c.json(result)
  } catch (error) {
    return await forwardError(c, error)
  }
}

async function handleAuto(c: Context): Promise<Response> {
  try {
    const body = await readJsonRecord(c)
    if (!isNonEmptyString(body.prompt)) {
      throw createInvalidRequestError(
        "prompt must be a non-empty string.",
        "prompt",
      )
    }
    const result = await createCopilotAutoSession({
      hasImage: optionalBoolean(body, "has_image"),
      multiTurn: optionalMultiTurn(body),
      previousUserMessages: optionalPreviousUserMessages(body),
      prompt: body.prompt,
      signal: c.req.raw.signal,
      tier: optionalTier(body),
    })
    recordControlPlaneContext(c, "auto", body.prompt.length)
    return c.json(result)
  } catch (error) {
    return await forwardError(c, error)
  }
}

async function handleIntent(c: Context): Promise<Response> {
  try {
    const token = sessionToken(c)
    if (!token) {
      throw createInvalidRequestError(
        "Copilot-Session-Token is required for intent prediction.",
        "Copilot-Session-Token",
      )
    }
    const body = await readJsonRecord(c)
    if (!isNonEmptyString(body.prompt)) {
      throw createInvalidRequestError(
        "prompt must be a non-empty string.",
        "prompt",
      )
    }
    if (!isNonEmptyStringArray(body.available_models)) {
      throw createInvalidRequestError(
        "available_models must contain at least one non-empty model ID.",
        "available_models",
      )
    }
    const previousUserMessages = optionalPreviousUserMessages(body)
    const routingIntent = optionalRoutingIntent(body)
    const result = await predictCopilotIntent({
      availableModels: body.available_models,
      hasImage: optionalBoolean(body, "has_image"),
      payload: {
        prompt: body.prompt,
        ...(previousUserMessages === undefined ?
          {}
        : { previous_user_messages: previousUserMessages }),
        ...(routingIntent === undefined ?
          {}
        : { routing_intent: routingIntent }),
      },
      sessionToken: token,
      signal: c.req.raw.signal,
    })
    recordControlPlaneContext(c, "model-session-intent", body.prompt.length)
    return c.json(result)
  } catch (error) {
    return await forwardError(c, error)
  }
}

copilotControlPlaneRoutes.post("/models/session", handleModelSession)
copilotControlPlaneRoutes.post("/models/session/intent", handleIntent)
copilotControlPlaneRoutes.post("/auto", handleAuto)
