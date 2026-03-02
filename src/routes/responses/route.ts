import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCompact } from "./compact-handler"
import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/compact", async (c) => {
  try {
    return await handleCompact(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
