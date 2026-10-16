import {
  buildWebSearchQuery,
  executeWebSearch,
} from "~/services/copilot/mcp-web-search"

import type { ManagedWebTool, WebToolsContext } from "./tool-context"

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
