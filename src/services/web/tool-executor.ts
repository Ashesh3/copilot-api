import {
  buildWebSearchQuery,
  executeWebSearch,
} from "~/services/copilot/mcp-web-search"

import type { ManagedWebTool, WebToolsContext } from "./tool-context"
import type { WebFetchInput, WebFetchResult } from "./types"

import { webDocuments } from "./document-store"
import { executeWebFetch, readFetchedDocument } from "./fetch-page"
import { isRecord } from "./tool-context"

export interface ManagedToolResult {
  text: string
  isError: boolean
}
export interface WebToolCall {
  id: string
  name: string
  input: unknown
  clientOwned?: boolean
}
export async function executeManagedWebCall(
  call: WebToolCall,
  tool: ManagedWebTool,
  options: { context: WebToolsContext; signal?: AbortSignal },
): Promise<ManagedToolResult> {
  const { context, signal } = options
  signal?.throwIfAborted()
  const used = context.uses.get(tool.kind) ?? 0
  if (used >= tool.maxUses)
    return {
      text: JSON.stringify({ error: "max_uses_exceeded", tool: tool.kind }),
      isError: true,
    }
  context.uses.set(tool.kind, used + 1)
  let input = call.input
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown
    } catch {
      /* report invalid input */
    }
  }
  if (!isRecord(input))
    return {
      text: JSON.stringify({ error: "invalid_tool_input" }),
      isError: true,
    }
  if (tool.kind === "search") {
    if (typeof input.query !== "string" || !input.query.trim())
      return {
        text: JSON.stringify({ error: "invalid_tool_input" }),
        isError: true,
      }
    const query = buildWebSearchQuery(
      JSON.stringify({
        ...input,
        ...tool.source,
        query: input.query,
      }),
    )
    const text = await executeWebSearch(query, signal)
    return { text, isError: /^Web search (?:failed|error):/.test(text) }
  }
  if (typeof input.url !== "string")
    return {
      text: JSON.stringify({ error: "invalid_tool_input" }),
      isError: true,
    }
  const fetchInput = input as unknown as WebFetchInput
  const existing = webDocuments.get(context.scope, input.url)
  if (input.url.startsWith("capi_fetch_") && !existing)
    return {
      text: JSON.stringify({ error: "reference_not_found" }),
      isError: true,
    }
  const result =
    existing ?
      await readFetchedDocument(existing, fetchInput, { limits: tool.limits })
    : await executeWebFetch(fetchInput, { signal, limits: tool.limits })
  return formatManagedFetch(
    result,
    context.scope,
    existing ? input.url : undefined,
  )
}
function formatManagedFetch(
  result: WebFetchResult,
  scope: string,
  existingReference?: string,
): ManagedToolResult {
  if (!result.ok) return { text: JSON.stringify(result), isError: true }
  const reference =
    existingReference ?? webDocuments.put(scope, result.document)
  return {
    isError: false,
    text: JSON.stringify({
      url: result.document.url,
      title: result.document.title,
      status: result.document.status,
      retrieved_at: result.document.retrievedAt,
      content_type: result.document.mediaType,
      content: result.content,
      full_length: result.full_length,
      next_start_index: result.next_start_index,
      reference,
      warnings: result.warnings,
    }),
  }
}
