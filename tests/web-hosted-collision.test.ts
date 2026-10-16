import { afterEach, beforeEach, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import { runWithWebTools } from "~/services/web/tool-context"

import { isGithubOrigin } from "./helpers/github-origin"
import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
const originalFetch = globalThis.fetch
const originalState = {
  models: state.models,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
}
beforeEach(async () => {
  state.models = undefined
  state.copilotToken = "fixture-token"
  state.githubToken = "fixture-github"
  state.isMultiToken = false
  await seedProtocolDatabase()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

for (const stream of [false, true])
  test.each(["web_search", "web_search_preview"])(
    `Responses ${stream ? "stream" : "buffered"} sends hosted %s and colliding caller function unchanged`,
    async (type) => {
      const tools = [
        {
          type: "function",
          name: "web_search",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
        { type, external_web_access: true },
      ]
      const payload = {
        model: "fixture",
        input: "search",
        stream,
        tools,
        tool_choice: { type },
      }
      const snapshot = structuredClone(payload)
      const bodies: Array<Record<string, unknown>> = []
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const target = new URL(url instanceof Request ? url.url : String(url))
        expect(isGithubOrigin(target)).toBe(true)
        expect(target.pathname).toBe("/responses")
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON transport body")
        const body = JSON.parse(init.body) as Record<string, unknown>
        bodies.push(body)
        const response = {
          id: "result",
          object: "response",
          status: "completed",
          model: "fixture",
          output: [
            {
              id: "hosted",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "search" },
            },
          ],
        }
        return Promise.resolve(
          stream ?
            new Response(
              `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json(response),
        )
      }) as typeof fetch
      const response = await runWithWebTools(payload, () =>
        createResponses(payload, { initiator: "user", vision: false }),
      )
      if (Symbol.asyncIterator in response)
        for await (const _event of response) {
          /* drain */
        }
      expect(bodies).toHaveLength(1)
      expect(bodies[0].tools).toEqual(tools)
      expect(bodies[0].tool_choice).toEqual({ type })
      expect(payload).toEqual(snapshot)
    },
  )
