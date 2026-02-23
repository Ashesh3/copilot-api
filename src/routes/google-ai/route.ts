import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleGoogleAI } from "./handler"

export const googleAIRoutes = new Hono()

// Match: POST /models/{model}:{action}
// e.g. /models/gemini-3-flash-preview:streamGenerateContent
// e.g. /models/gemini-3-flash-preview:generateContent
googleAIRoutes.post("/:modelAction", async (c) => {
  try {
    return await handleGoogleAI(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
