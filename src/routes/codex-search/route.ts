import type { Context } from "hono"

import { Hono } from "hono"

import { getLastUsedAccountId } from "~/lib/account-router"
import { setRequestContext } from "~/lib/request-logger"
import { executeWebSearch } from "~/services/copilot/mcp-web-search"

export const codexSearchRoutes = new Hono()

export interface CodexSearchRequest {
  id?: unknown
  model?: unknown
  input?: unknown
  commands?: unknown
  settings?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

function invalidRequest(c: Context, message: string): Response {
  return c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

function collectInputText(value: unknown, output: Array<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInputText(item, output)
    return
  }
  if (!isRecord(value)) return

  if (
    typeof value.text === "string"
    && ["input_text", "output_text"].includes(String(value.type))
  ) {
    output.push(value.text)
  }
  if ("content" in value) collectInputText(value.content, output)
}

function describeSearchSettings(settings: unknown): Array<string> {
  if (!isRecord(settings)) return []

  const details: Array<string> = []
  if (isRecord(settings.filters)) {
    const allowed = settings.filters.allowed_domains
    const blocked = settings.filters.blocked_domains
    if (Array.isArray(allowed) && allowed.length > 0) {
      details.push(`Only use these domains: ${allowed.join(", ")}.`)
    }
    if (Array.isArray(blocked) && blocked.length > 0) {
      details.push(`Do not use these domains: ${blocked.join(", ")}.`)
    }
  }
  if (isRecord(settings.user_location)) {
    details.push(
      `Use this approximate user location when relevant: ${JSON.stringify(settings.user_location)}.`,
    )
  }
  if (typeof settings.search_context_size === "string") {
    details.push(
      `Requested search context size: ${settings.search_context_size}.`,
    )
  }
  return details
}

/** Translate Codex's standalone `web.run` command envelope to an MCP query. */
export function buildCodexSearchQuery(body: CodexSearchRequest): string {
  const commands = isRecord(body.commands) ? body.commands : {}
  const inputText: Array<string> = []
  collectInputText(body.input, inputText)

  const parts = [
    "Fulfill this Codex web.run request using current web sources.",
    `Commands: ${JSON.stringify(commands)}`,
    ...describeSearchSettings(body.settings),
  ]
  if (inputText.length > 0) {
    parts.push(`Recent conversation context: ${inputText.join("\n")}`)
  }
  return parts.join("\n\n")
}

codexSearchRoutes.post("/", async (c) => {
  let body: CodexSearchRequest
  try {
    body = await c.req.json<CodexSearchRequest>()
  } catch {
    return invalidRequest(c, "Invalid JSON body")
  }

  if (!isRecord(body))
    return invalidRequest(c, "Request body must be an object")
  if (typeof body.id !== "string" || body.id.length === 0) {
    return invalidRequest(c, "id is required")
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return invalidRequest(c, "model is required")
  }
  if (!isRecord(body.commands)) {
    return invalidRequest(c, "commands is required")
  }

  const query = buildCodexSearchQuery(body)
  setRequestContext(c, {
    inputLength: query.length,
    model: body.model,
    provider: "Copilot MCP Web Search",
    requestedModel: body.model,
  })

  const output = await executeWebSearch(query, c.req.raw.signal, {
    modelId: body.model,
    sessionId: body.id,
  })
  setRequestContext(c, { accountId: getLastUsedAccountId() })
  return c.json({ encrypted_output: null, output })
})
