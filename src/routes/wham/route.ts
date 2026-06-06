import { Hono } from "hono"

export const whamRoutes = new Hono()

whamRoutes.all("*", (c) =>
  c.json(
    {
      error: {
        message: "Unsupported Codex cloud endpoint",
        type: "not_found",
      },
    },
    404,
  ),
)
