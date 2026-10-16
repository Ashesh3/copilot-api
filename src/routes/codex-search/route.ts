import type { Context } from "hono"

import { Hono } from "hono"

import { getLastUsedAccountId } from "~/lib/account-router"
import { setRequestContext } from "~/lib/request-logger"
import { pageUrl } from "~/services/copilot/hosted-web-search"
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

function pageTargets(
  commands: Record<string, unknown>,
): Array<string> | undefined {
  const urls = new Set<string>()
  for (const kind of ["open", "find", "click"]) {
    const values = commands[kind]
    if (!Array.isArray(values)) continue
    for (const command of values) {
      if (!isRecord(command) || typeof command.ref_id !== "string")
        return undefined
      const url = pageUrl(command.ref_id)
      if (!url) return undefined
      if (kind === "click") return undefined // Link IDs belong to the upstream browser session, not this gateway.
      urls.add(url)
    }
  }
  return [...urls]
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

/** Forward Codex web.run through GitHub search or hosted exact-URL browsing. */
export function buildCodexSearchQuery(body: CodexSearchRequest): string {
  const commands = isRecord(body.commands) ? body.commands : {}
  const inputText: Array<string> = []
  collectInputText(body.input, inputText)

  const parts = [
    "Fulfill this Codex web.run request using current web sources.",
    "For open/find/click, use the supplied exact URL and conversation context to read the page on GitHub. Do not substitute search snippets for a failed page open.",
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
    provider: "GitHub Web Search / Browsing",
    requestedModel: body.model,
  })

  const pageUrls = pageTargets(body.commands)
  if (!pageUrls)
    return c.json({
      encrypted_output: null,
      output:
        "Web search error: Page references and link IDs from another browser session are unavailable. Supply an exact HTTP(S) URL to open or find text in.",
    })
  const output = await executeWebSearch(query, c.req.raw.signal, {
    modelId: body.model,
    sessionId: body.id,
    pageUrls,
  })
  setRequestContext(c, { accountId: getLastUsedAccountId() })
  return c.json({ encrypted_output: null, output })
})
