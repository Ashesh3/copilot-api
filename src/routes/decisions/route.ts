import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import {
  getLastUsedAccountId,
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import {
  createInvalidJsonBodyError,
  createInvalidRequestError,
  forwardError,
  LocalHTTPError,
} from "~/lib/error"
import { readRequestJson } from "~/lib/request-json"
import { setRequestContext } from "~/lib/request-logger"
import {
  COPILOT_DECISIONS_ENDPOINT,
  createDecisions,
  type DecisionsRequest,
} from "~/services/copilot/create-decisions"

export const decisionRoutes = new Hono()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function validateQuestions(questions: unknown): void {
  if (!Array.isArray(questions) || questions.length === 0)
    throw createInvalidRequestError(
      "questions must be a nonempty array",
      "questions",
    )
  const names = new Set<string>()
  for (const [index, question] of questions.entries()) {
    const field = `questions[${index}]`
    if (!isRecord(question))
      throw createInvalidRequestError(`${field} must be an object`, field)
    if (!isNonBlankString(question.name))
      throw createInvalidRequestError(
        `${field}.name is required`,
        `${field}.name`,
      )
    if (!isNonBlankString(question.type))
      throw createInvalidRequestError(
        `${field}.type is required`,
        `${field}.type`,
      )
    if (names.has(question.name))
      throw createInvalidRequestError(
        `${field}.name is not unique`,
        `${field}.name`,
      )
    names.add(question.name)
  }
}

/**
 * Mirrors openaidecisionsapi.Request.Validate in github/copilot-api at
 * 0748fca992 (2026-10-08). Copilot rejects these with a bare "Bad Request";
 * checking them locally names the field. Everything else stays upstream's call.
 */
function parseDecisionsRequest(value: unknown): DecisionsRequest {
  if (!isRecord(value))
    throw createInvalidRequestError(
      "The request body must be a JSON object.",
      "body",
    )
  if (!isNonBlankString(value.model))
    throw createInvalidRequestError("model is required", "model")
  validateQuestions(value.questions)
  return value as DecisionsRequest
}

function advertisesDecisions(model: Model): boolean {
  return (
    model.supported_endpoints?.includes(COPILOT_DECISIONS_ENDPOINT) === true
  )
}

function createUnsupportedModelError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "model_not_supported",
      message: "The selected model does not support the Decisions API.",
      param: "model",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

decisionRoutes.post("/", async (c) => {
  try {
    const parsed = await readRequestJson(() => c.req.json<unknown>())
    if (!parsed.ok) throw createInvalidJsonBodyError()
    const payload = parseDecisionsRequest(parsed.value)
    setRequestContext(c, {
      requestedModel: payload.model,
      provider: "Decisions",
      model: payload.model,
    })

    // A model missing from every live catalog still reaches Copilot, which
    // remains authoritative; a cataloged model must advertise the endpoint.
    const routedModel = await selectRoutedModel(payload.model)
    if (routedModel.model && !advertisesDecisions(routedModel.model))
      throw createUnsupportedModelError()

    const result = await runWithRoutedModelSelection(
      routedModel,
      async () => await createDecisions(payload, { signal: c.req.raw.signal }),
    )
    setRequestContext(c, {
      accountId: getLastUsedAccountId(),
      ...(result.usage ?
        {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }
      : {}),
    })
    return c.body(result.body, 200, { "content-type": result.contentType })
  } catch (error) {
    return await forwardError(c, error)
  }
})
