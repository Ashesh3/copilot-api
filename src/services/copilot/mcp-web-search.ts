import consola from "consola"
import { randomUUID } from "node:crypto"

import { state } from "~/lib/state"
import { copilotBaseUrl } from "~/services/copilot/copilot-client"

// --- MCP Session State ---

let mcpSessionId: string | null = null
let mcpSessionPromise: Promise<string> | null = null

// --- JSON-RPC Helpers ---

interface JsonRpcRequest {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
  id: string | number
}

interface McpTextContent {
  type: "text"
  text: string
}

interface McpToolResult {
  content: Array<McpTextContent | Record<string, unknown>>
  isError?: boolean
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  result?: McpToolResult
  error?: { code: number; message: string; data?: unknown }
  id: string | number
}

const MCP_PATH = "/mcp/readonly"

const mcpHeaders = (sessionId?: string | null): Record<string, string> => {
  if (!state.githubToken) {
    throw new Error("GitHub token is not set. Cannot call MCP endpoint.")
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    Authorization: `Bearer ${state.githubToken}`,
    "X-MCP-Toolsets": "web_search",
    "X-MCP-Host": "github-coding-agent",
    "Copilot-Integration-Id": "vscode-chat",
  }

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId
  }

  return headers
}

const mcpFetch = async (
  body: JsonRpcRequest,
  sessionId: string | null,
): Promise<Response> => {
  const url = `${copilotBaseUrl()}${MCP_PATH}`
  return fetch(url, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: JSON.stringify(body),
  })
}

// --- MCP Session Initialization ---

const initializeSession = async (): Promise<string> => {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "copilot-api",
        version: "1.0.0",
      },
    },
    id: randomUUID(),
  }

  const response = await mcpFetch(request, null)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `MCP initialize failed: ${response.status} ${errorText.slice(0, 200)}`,
    )
  }

  // Extract session ID from response header
  const sessionId = response.headers.get("Mcp-Session-Id")
  if (!sessionId) {
    throw new Error("MCP initialize response missing Mcp-Session-Id header")
  }

  consola.debug("MCP session initialized:", sessionId)
  return sessionId
}

/**
 * Ensure an MCP session exists. Serializes concurrent callers so only one
 * initialization request is made, and all callers receive the same session ID.
 */
const ensureSession = async (): Promise<string> => {
  if (mcpSessionId) {
    return mcpSessionId
  }

  if (mcpSessionPromise) {
    return mcpSessionPromise
  }

  mcpSessionPromise = initializeSession()
    .then((id) => {
      mcpSessionId = id
      mcpSessionPromise = null
      return id
    })
    .catch((error) => {
      mcpSessionPromise = null
      throw error
    })

  return mcpSessionPromise
}

/**
 * Invalidate the current MCP session, but only if the caller's session matches
 * the current global one. This prevents a stale caller from resetting a
 * freshly-initialized session obtained by another concurrent call.
 */
const invalidateSession = (callerSessionId: string): void => {
  if (mcpSessionId === callerSessionId) {
    mcpSessionId = null
  }
}

// --- Web Search Execution ---

export const executeWebSearch = async (query: string): Promise<string> => {
  try {
    // Capture session ID locally so concurrent calls don't interfere
    const sessionId = await ensureSession()

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { query },
      },
      id: randomUUID(),
    }

    const response = await mcpFetch(request, sessionId)

    if (!response.ok) {
      // Session may have expired — invalidate and retry once
      if (response.status === 401 || response.status === 403) {
        consola.warn("MCP session expired, re-initializing")
        invalidateSession(sessionId)
        const newSessionId = await ensureSession()

        const retryResponse = await mcpFetch(request, newSessionId)
        if (!retryResponse.ok) {
          const errorText = await retryResponse.text()
          consola.error("MCP web_search retry failed:", errorText.slice(0, 200))
          return `Web search failed: ${retryResponse.status}`
        }
        return parseSearchResponse(await retryResponse.json())
      }

      const errorText = await response.text()
      consola.error("MCP web_search failed:", errorText.slice(0, 200))
      return `Web search failed: ${response.status}`
    }

    return parseSearchResponse(await response.json())
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown MCP error"
    consola.error("MCP web search error:", message)
    // Reset session on error so next attempt re-initializes
    // Use a sentinel to invalidate — safe since we don't have the caller's ID here
    mcpSessionId = null
    mcpSessionPromise = null
    return `Web search failed: ${message}`
  }
}

const parseSearchResponse = (json: unknown): string => {
  const rpcResponse = json as JsonRpcResponse

  if (rpcResponse.error) {
    consola.warn("MCP web_search returned error:", rpcResponse.error)
    return `Web search error: ${rpcResponse.error.message}`
  }

  if (!rpcResponse.result?.content) {
    return "No search results found."
  }

  const textParts = rpcResponse.result.content
    .filter((c): c is McpTextContent => c.type === "text" && "text" in c)
    .map((c) => c.text)

  if (textParts.length === 0) {
    return "No search results found."
  }

  return textParts.join("\n\n")
}

// --- Web Search Tool Definition ---

/** OpenAI function tool definition for web_search (ChatCompletions format) */
export const WEB_SEARCH_FUNCTION_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web for current information",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
}

/** Responses API function tool definition for web_search */
export const WEB_SEARCH_RESPONSES_TOOL = {
  type: "function" as const,
  name: "web_search",
  description: "Search the web for current information",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
    },
    required: ["query"],
  },
  strict: false,
}

// --- Helpers for detecting web_search tool calls ---

export const isWebSearchToolType = (tool: { type?: string }): boolean => {
  return typeof tool.type === "string" && tool.type.startsWith("web_search")
}
