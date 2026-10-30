import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicNamedTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "~/routes/messages/anthropic-types"
import type { ResponseOutputWebSearchCall } from "~/services/copilot/create-responses"
import type { ManagedWebRound } from "~/services/web/tool-loop"

import { createWebSearchAnthropicTool } from "~/services/copilot/mcp-web-search"
import { adoptManagedWebSearchTool } from "~/services/web/tool-context"

import { isAnthropicAssistantMessage } from "../messages/anthropic-types"

/**
 * Opaque state of a bridged `web_search_call`: the exact Messages tool_use
 * and tool_result of one gateway-managed search, and the call's position in
 * its round. Claude's later output in the turn followed that history, so a
 * replay restores it as the loop sent it. The tag names the encoding; the
 * content is not authenticated.
 */
const MANAGED_WEB_SEARCH_ENVELOPE_PREFIX = "capi_anthropic_web_search_v1:"
const MAX_ENVELOPE_LENGTH = 4 * 1024 * 1024

export interface ManagedWebSearchReplay {
  readonly toolUse: AnthropicToolUseBlock
  readonly toolResult: AnthropicToolResultBlock
  /** The call's position among the managed calls of its round. */
  readonly index: number
  readonly count: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isToolUse(value: unknown): value is AnthropicToolUseBlock {
  return (
    isRecord(value)
    && value.type === "tool_use"
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && value.name.length > 0
    && isRecord(value.input)
  )
}

function isToolResult(
  value: unknown,
  toolUseId: string,
): value is AnthropicToolResultBlock {
  return (
    isRecord(value)
    && value.type === "tool_result"
    && value.tool_use_id === toolUseId
    && typeof value.content === "string"
    && (value.is_error === undefined || value.is_error === true)
  )
}

function isPosition(index: unknown, count: unknown): boolean {
  return (
    typeof index === "number"
    && typeof count === "number"
    && Number.isSafeInteger(index)
    && Number.isSafeInteger(count)
    && index >= 0
    && index < count
  )
}

function encodeReplay(replay: ManagedWebSearchReplay): string {
  const envelope = {
    tool_use: replay.toolUse,
    tool_result: replay.toolResult,
    index: replay.index,
    count: replay.count,
  }
  return (
    MANAGED_WEB_SEARCH_ENVELOPE_PREFIX
    + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")
  )
}

export function readManagedWebSearchReplay(
  value: unknown,
): ManagedWebSearchReplay | undefined {
  if (
    typeof value !== "string"
    || value.length > MAX_ENVELOPE_LENGTH
    || !value.startsWith(MANAGED_WEB_SEARCH_ENVELOPE_PREFIX)
  ) {
    return undefined
  }
  const encoded = value.slice(MANAGED_WEB_SEARCH_ENVELOPE_PREFIX.length)
  if (!/^[\w-]+$/.test(encoded)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed)
    || !isToolUse(parsed.tool_use)
    || !isToolResult(parsed.tool_result, parsed.tool_use.id)
    || !isPosition(parsed.index, parsed.count)
  ) {
    return undefined
  }
  return {
    toolUse: parsed.tool_use,
    toolResult: parsed.tool_result,
    index: parsed.index as number,
    count: parsed.count as number,
  }
}

/** What Codex shows for the search: the page it opened or the query. */
function webSearchAction(input: Record<string, unknown>) {
  if (typeof input.url === "string" && input.url) {
    return { type: "open_page", url: input.url }
  }
  return {
    type: "search",
    query:
      typeof input.query === "string" ? input.query : JSON.stringify(input),
  }
}

/**
 * A `web_search_call` for each managed call of a round, keyed by its
 * tool_use ID, carrying the call and the result the loop sent the model.
 */
export function managedWebSearchCalls(
  round: ManagedWebRound,
): Map<string, ResponseOutputWebSearchCall> {
  const content: Array<unknown> =
    Array.isArray(round.response.content) ? round.response.content : []
  const answered = content.flatMap((block) => {
    if (!isToolUse(block)) return []
    const done = round.completed.find((entry) => entry.call.id === block.id)
    return done ? [{ block, result: done.result }] : []
  })
  const calls = new Map<string, ResponseOutputWebSearchCall>()
  for (const [index, { block, result }] of answered.entries()) {
    calls.set(block.id, {
      id: `ws_${block.id}`,
      type: "web_search_call",
      status: "completed",
      action: webSearchAction(block.input),
      encrypted_content: encodeReplay({
        toolUse: structuredClone(block),
        toolResult: {
          type: "tool_result",
          tool_use_id: block.id,
          content: result.text,
          ...(result.isError ? { is_error: true } : {}),
        },
        index,
        count: answered.length,
      }),
    })
  }
  return calls
}

function appendAssistantBlock(
  messages: Array<AnthropicMessage>,
  block: AnthropicAssistantContentBlock,
): void {
  const previous = messages.at(-1)
  if (
    previous
    && isAnthropicAssistantMessage(previous)
    && Array.isArray(previous.content)
  ) {
    previous.content.push(block)
    return
  }
  messages.push({ role: "assistant", content: [block] })
}

/** Reasoning and assistant text can sit between the calls of one round. */
function continuesAssistantTurn(item: Record<string, unknown>): boolean {
  return (
    item.type === "reasoning"
    || ((item.type === undefined || item.type === "message")
      && item.role === "assistant")
  )
}

/**
 * Rebuilds replayed managed searches as the loop sent them: each call joins
 * the assistant turn that requested it, and the round's results form the
 * next user turn once its last call is replayed.
 */
export class ManagedWebSearchHistory {
  readonly toolNames = new Set<string>()
  private readonly messages: Array<AnthropicMessage>
  private readonly results: Array<AnthropicToolResultBlock> = []

  constructor(messages: Array<AnthropicMessage>) {
    this.messages = messages
  }

  /** Close an unfinished round before an item that cannot belong to it. */
  settleBefore(
    item: Record<string, unknown>,
    replay: ManagedWebSearchReplay | undefined,
  ): void {
    if (replay ? replay.index > 0 : continuesAssistantTurn(item)) return
    this.flush()
  }

  add(replay: ManagedWebSearchReplay): void {
    appendAssistantBlock(this.messages, structuredClone(replay.toolUse))
    this.results.push(structuredClone(replay.toolResult))
    this.toolNames.add(replay.toolUse.name)
    if (replay.index === replay.count - 1) this.flush()
  }

  flush(): void {
    if (this.results.length === 0) return
    this.messages.push({ role: "user", content: this.results.splice(0) })
  }
}

/**
 * The Anthropic Messages API rejects tool history in a request that declares
 * no tools. A request without tools of its own declares the replayed search
 * tools, owned by the gateway so the managed loop answers them if Claude
 * searches again.
 */
export function declareReplayedWebSearchTools(
  tools: Array<AnthropicNamedTool> | undefined,
  names: ReadonlySet<string>,
): Array<AnthropicNamedTool> | undefined {
  if ((tools && tools.length > 0) || names.size === 0) return tools
  return [...names].map((name) => {
    adoptManagedWebSearchTool(name)
    return { ...createWebSearchAnthropicTool(), name }
  })
}
