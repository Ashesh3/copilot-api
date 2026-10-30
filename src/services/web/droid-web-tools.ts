import { pageUrl } from "~/services/copilot/hosted-web-search"
import { executeWebSearch } from "~/services/copilot/mcp-web-search"

import type { DroidWebToolKind } from "./droid-web-protocol"
import type { ManagedWebTool, WebToolsContext } from "./tool-context"
import type { ManagedToolResult, WebToolCall } from "./tool-executor"

/** One result must fit the model's context next to the rest of the turn. */
const MAX_RESULT_CHARACTERS = 100_000
const PAGE_REQUEST =
  "Return the page's main content as Markdown, as completely as you can: keep headings, lists, tables, code blocks and links; leave out navigation, ads and other page chrome."

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function callInput(input: unknown): JsonRecord {
  if (typeof input !== "string") return isRecord(input) ? input : {}
  try {
    const parsed = JSON.parse(input) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Droid's WebSearch takes a query, or an objective with search queries. */
function searchQuery(input: JsonRecord): string {
  const query = text(input.query)
  if (query) return query
  const objective = text(input.objective)
  const queries =
    Array.isArray(input.searchQueries) ?
      input.searchQueries.map((item) => text(item)).filter(Boolean)
    : []
  if (!objective || queries.length === 0) return objective
  return `${objective}\nSearch queries: ${queries.join("; ")}`
}

function isPrivateIpv4(host: string): boolean {
  const octets = /^(\d+)\.(\d+)\.\d+\.\d+$/u.exec(host)
  if (!octets) return false
  const [first, second] = [Number(octets[1]), Number(octets[2])]
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
  )
}

/** GitHub's hosted browser cannot reach these, so fail fast and clearly. */
function isPrivateHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase().replaceAll(/^\[|\]$/gu, "")
  return (
    host === "localhost"
    || /\.(?:localhost|local|internal)$/u.test(host)
    || ["::", "::1"].includes(host)
    || /^f[cd][\da-f]{2}:/u.test(host)
    || /^fe[89ab][\da-f]:/u.test(host)
    || isPrivateIpv4(host)
  )
}

function bounded(value: string): string {
  if (value.length <= MAX_RESULT_CHARACTERS) return value
  return `${value.slice(0, MAX_RESULT_CHARACTERS)}\n\n[Truncated by copilot-api after ${MAX_RESULT_CHARACTERS} characters.]`
}

const FAILURE = /^Web search (?:failed|error):\s*/u

function failed(text: string, reason: string): ManagedToolResult {
  return { text, isError: true, narration: `failed: ${shown(reason)}` }
}

async function searchWeb(
  input: JsonRecord,
  signal: AbortSignal | undefined,
): Promise<ManagedToolResult> {
  const query = searchQuery(input)
  if (!query) {
    const reason = "the query is empty."
    return failed(`Error performing web search: ${reason}`, reason)
  }
  // An empty URL list keeps a URL in the query a search term, as in Droid.
  const result = await executeWebSearch(query, signal, { pageUrls: [] })
  if (FAILURE.test(result)) {
    const reason = result.replace(FAILURE, "")
    return failed(`Error performing web search: ${reason}`, reason)
  }
  return {
    text: `Web Search Results for: "${query}"\n\n${bounded(result)}`,
    isError: false,
    narration: sourcesNarration(result),
  }
}

async function readPage(
  input: JsonRecord,
  signal: AbortSignal | undefined,
): Promise<ManagedToolResult> {
  const url = pageUrl(text(input.url))
  if (!url) {
    const reason =
      "the url must be an absolute HTTP(S) URL without credentials."
    return failed(`Failed to fetch URL content: ${reason}`, reason)
  }
  if (isPrivateHost(url)) {
    const reason =
      "copilot-api reads pages through GitHub's hosted browser, which cannot reach local or private addresses."
    return failed(
      `Failed to fetch URL content from "${url}": ${reason}`,
      reason,
    )
  }
  const result = await executeWebSearch(PAGE_REQUEST, signal, {
    pageUrls: [url],
  })
  if (FAILURE.test(result)) {
    const reason = result.replace(FAILURE, "")
    return failed(
      `Failed to fetch URL content from "${url}": ${reason}`,
      reason,
    )
  }
  const content = bounded(result)
  return {
    text: `URL Content from: "${url}"\n\n${content}`,
    isError: false,
    narration: `read ${content.length.toLocaleString("en-US")} characters`,
  }
}

/**
 * Run Droid's WebSearch or FetchUrl with GitHub-hosted search and page
 * reading. Results use Droid's own result headings.
 */
export async function executeDroidWebCall(
  call: WebToolCall,
  tool: ManagedWebTool & { droid: DroidWebToolKind },
  options: { context: WebToolsContext; signal?: AbortSignal },
): Promise<ManagedToolResult> {
  const { context, signal } = options
  signal?.throwIfAborted()
  const key = `droid:${tool.droid}`
  const used = context.uses.get(key) ?? 0
  if (used >= tool.maxUses) {
    const name = tool.droid === "fetch" ? "FetchUrl" : "WebSearch"
    return failed(
      `${name} limit reached: this response already used it ${tool.maxUses} times. Continue with the results you have.`,
      `${name} limit of ${tool.maxUses} reached`,
    )
  }
  context.uses.set(key, used + 1)
  const input = callInput(call.input)
  return tool.droid === "fetch" ?
      await readPage(input, signal)
    : await searchWeb(input, signal)
}

function shown(value: string, limit = 160): string {
  const line = value.replaceAll(/\s+/gu, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** What the user sees while a gateway-run Droid web call is in progress. */
export function droidCallNarration(
  call: WebToolCall,
  kind: DroidWebToolKind,
): string {
  const input = callInput(call.input)
  if (kind === "fetch")
    return `Reading ${shown(text(input.url) || "a page")} (copilot-api)`
  return `Searching the web (copilot-api): "${shown(searchQuery(input))}"`
}

function sourcesNarration(value: string): string {
  const hosts = new Set<string>()
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`)\]]+/giu)) {
    try {
      hosts.add(new URL(match[0]).hostname.replace(/^www\./u, ""))
    } catch {
      /* not a URL */
    }
  }
  if (hosts.size === 0) return "done"
  const listed = [...hosts].slice(0, 4).join(", ")
  return `sources: ${listed}${hosts.size > 4 ? ", …" : ""}`
}

/** How a gateway-run Droid web call ended, shown after its narration. */
export function droidResultNarration(
  kind: DroidWebToolKind,
  result: ManagedToolResult,
): string {
  if (result.narration) return ` → ${result.narration}`
  if (result.isError) return ` → failed: ${shown(result.text)}`
  if (kind === "fetch")
    return ` → read ${result.text.length.toLocaleString("en-US")} characters`
  return ` → ${sourcesNarration(result.text)}`
}
