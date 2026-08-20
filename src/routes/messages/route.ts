import { Hono } from "hono"

import { handleCountTokens } from "./count-tokens-handler"
import { forwardMessagesError } from "./error"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    return await forwardMessagesError(c, error)
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return await forwardMessagesError(c, error)
  }
})
