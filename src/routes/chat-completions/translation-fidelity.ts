import type { TranslationCheck } from "~/lib/endpoint-routing"
import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

import { normalizeChatCompletionsRequest } from "./chat-contract"

const RESPONSES_CONTENT_PARTS = new Set(["file", "image_url", "text"])
const HOSTED_RESPONSES_TOOLS = new Set([
  "code_interpreter",
  "computer",
  "computer_use",
  "computer_use_preview",
  "file_search",
  "image_generation",
  "local_shell",
  "mcp",
  "mcp_list_tools",
  "web_search",
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function createCheck(blockers: Array<string>): TranslationCheck {
  return { supported: blockers.length === 0, blockers }
}

function addBlocker(blockers: Array<string>, blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker)
}

function getType(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  return value.type
}

function hasAnthropicReasoningSignature(message: Message): boolean {
  return (
    typeof message.reasoning_text === "string"
    && typeof message.reasoning_opaque === "string"
    && message.reasoning_opaque.length > 0
    && !message.reasoning_opaque.includes("@")
    && !message.encrypted_content
  )
}

function scanChatMessageContent(
  messages: ChatCompletionsPayload["messages"],
  blockers: Array<string>,
): void {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const part of message.content as Array<unknown>) {
        const type = getType(part)
        if (
          !type
          || !RESPONSES_CONTENT_PARTS.has(type)
          || (type !== "text"
            && message.role !== "user"
            && message.role !== "tool")
        ) {
          addBlocker(blockers, "message_content_part")
        }
      }
    }
    if (message.role !== "tool") continue
    if (
      typeof message.tool_call_id !== "string"
      || message.tool_call_id.length === 0
    ) {
      addBlocker(blockers, "tool_result_pairing")
    }
  }
}

function hasCustomGrammar(tool: unknown): boolean {
  return isRecord(tool) && tool.type === "custom"
}

function scanChatToolsForMessages(
  tools: ChatCompletionsPayload["tools"],
  blockers: Array<string>,
): void {
  if (!Array.isArray(tools)) return
  for (const tool of tools as Array<unknown>) {
    if (hasCustomGrammar(tool)) {
      addBlocker(blockers, "custom_tool_grammar")
      continue
    }
    const type = getType(tool)
    if (type && HOSTED_RESPONSES_TOOLS.has(type)) {
      addBlocker(blockers, `hosted_tool:${type}`)
    }
  }
}

export function checkChatToResponsesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck {
  const normalized = normalizeChatCompletionsRequest(payload)
  const blockers: Array<string> = []
  scanChatMessageContent(normalized.messages, blockers)
  return createCheck(blockers)
}

export function checkChatToMessagesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck {
  const normalized = normalizeChatCompletionsRequest(payload)
  const blockers: Array<string> = []
  for (const message of normalized.messages) {
    if (
      message.role === "assistant"
      && (message.encrypted_content || message.reasoning_opaque)
      && !hasAnthropicReasoningSignature(message)
    ) {
      addBlocker(blockers, "opaque_reasoning")
    }
  }
  scanChatToolsForMessages(normalized.tools, blockers)
  if (normalized.prediction !== undefined && normalized.prediction !== null) {
    addBlocker(blockers, "prediction")
  }
  return createCheck(blockers)
}
