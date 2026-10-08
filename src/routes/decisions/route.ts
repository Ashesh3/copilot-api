import { Hono } from "hono"

import {
  createInvalidJsonBodyError,
  createInvalidRequestError,
  forwardError,
} from "~/lib/error"
import {
  dispatchNativeCopilotRequest,
  isNonBlankString,
  isRecord,
  readJsonRequestModel,
} from "~/lib/native-passthrough"
import { readRequestJson } from "~/lib/request-json"

export const decisionRoutes = new Hono()

/**
 * Mirrors openaidecisionsapi.Request.Validate in github/copilot-api at
 * 0748fca992 (2026-10-08). Copilot rejects these with a bare "Bad Request";
 * checking them locally names the field. Everything else stays upstream's call.
 */
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

decisionRoutes.post("/", async (c) => {
  try {
    const parsed = await readRequestJson(() => c.req.json<unknown>())
    if (!parsed.ok) throw createInvalidJsonBodyError()
    const model = readJsonRequestModel(parsed.value)
    validateQuestions((parsed.value as Record<string, unknown>).questions)
    return await dispatchNativeCopilotRequest(c, {
      body: JSON.stringify(parsed.value),
      contentType: "application/json",
      endpoint: "/v1/decisions",
      model,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
