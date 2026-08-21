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
      payload: structuredClone(body),
      signal: c.req.raw.signal,
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
    const result = await predictCopilotIntent({
      payload: structuredClone(body),
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
