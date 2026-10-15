import { expect, test } from "bun:test"
import { Hono } from "hono"

import {
  resolveRoutingAffinityFromHeaders,
  runWithRoutingAffinity,
} from "~/lib/routing-affinity"
import { webToolsMiddleware } from "~/services/web/middleware"
import { webToolsContext } from "~/services/web/tool-context"

test.each([
  [
    "/v1/messages",
    (id: string) => ({
      metadata: { user_id: JSON.stringify({ session_id: id }) },
    }),
  ],
  [
    "/v1/responses",
    (id: string) => ({
      client_metadata: { session_id: "parent", thread_id: id },
    }),
  ],
] as const)(
  "page references isolate metadata-only conversations on %s",
  async (path, payload) => {
    const app = new Hono()
    app.use("*", (c, next) =>
      runWithRoutingAffinity(
        resolveRoutingAffinityFromHeaders(c.req.raw.headers),
        next,
      ),
    )
    app.use("*", webToolsMiddleware)
    app.post("*", (c) => c.json({ scope: webToolsContext()?.scope }))
    const request = async (id: string) => {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          authorization: "Bearer key",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload(id)),
      })
      return (await response.json()) as { scope: string }
    }
    expect((await request("child-a")).scope).not.toBe(
      (await request("child-b")).scope,
    )
    expect((await request("child-a")).scope).toBe(
      (await request("child-a")).scope,
    )
  },
)
