import type { TranslationCheck } from "~/lib/endpoint-routing"

import type {
  AnthropicMessagesPayload,
  AnthropicThinkingBlock,
  AnthropicTool,
} from "./anthropic-types"

type TranslationTarget = "chat" | "responses"
const MAPPED_TOOL_FIELDS = new Set([
  "description",
  "input_schema",
  "name",
  "type",
])

function createCheck(blockers: Array<string>): TranslationCheck {
  return { supported: blockers.length === 0, blockers }
}

function addBlocker(blockers: Array<string>, blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker)
}

function addPresentBlocker(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  field: string,
): void {
  const value = payload[field]
  if (value !== undefined && value !== null) addBlocker(blockers, field)
}

function scanNativeTopLevelControls(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
): void {
  addPresentBlocker(payload, blockers, "fallback_credit_token")
  addPresentBlocker(payload, blockers, "stop_details")
  addPresentBlocker(payload, blockers, "context_management")
  addPresentBlocker(payload, blockers, "compaction")
  addPresentBlocker(payload, blockers, "cache_control")
}

function scanMessagesContent(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (
        block.type === "tool_result"
        && Array.isArray(block.content)
        && block.content.some((item) => item.type === "tool_reference")
      ) {
        addBlocker(blockers, "tool_reference")
      }
      if (block.type !== "thinking") continue
      if (typeof block.signature !== "string" || block.signature.length === 0) {
        continue
      }
      scanThinkingBlock(block, blockers, target)
    }
  }
}

function scanThinkingBlock(
  block: AnthropicThinkingBlock,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  const signature = block.signature
  if (typeof signature !== "string" || signature.length === 0) return
  const hasResponsesItemId = isResponsesThinkingSignature(signature)
  if (
    (target === "responses" && !hasResponsesItemId)
    || (target === "chat" && hasResponsesItemId)
  ) {
    addBlocker(blockers, "thinking_signature")
  }
}

function isResponsesThinkingSignature(signature: string): boolean {
  const parts = signature.split("@")
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
}

function scanTools(
  tools: AnthropicMessagesPayload["tools"],
  blockers: Array<string>,
): void {
  if (!tools) return
  for (const tool of tools) scanTool(tool, blockers)
}

function scanTool(tool: AnthropicTool, blockers: Array<string>): void {
  const type = typeof tool.type === "string" ? tool.type : undefined
  if (type?.startsWith("web_search") || type?.startsWith("web_fetch")) {
    if (!isSupportedWebCompatibilityTool(tool)) {
      addBlocker(
        blockers,
        `native_tool:${type.startsWith("web_search") ? "web_search" : "web_fetch"}`,
      )
    }
    return
  }
  if (tool.input_schema === undefined && type !== undefined) {
    addBlocker(blockers, `native_tool:${type}`)
    return
  }
  if (hasAdvancedToolMetadata(tool)) {
    addBlocker(blockers, "advanced_tool_metadata")
  }
}

function hasAdvancedToolMetadata(tool: AnthropicTool): boolean {
  return Object.keys(tool).some((key) => !MAPPED_TOOL_FIELDS.has(key))
}

function isSupportedWebCompatibilityTool(tool: AnthropicTool): boolean {
  return (
    typeof tool.type === "string"
    && tool.type.startsWith("web_search")
    && !Object.keys(tool).some(
      (key) =>
        !MAPPED_TOOL_FIELDS.has(key)
        && key !== "allowed_domains"
        && key !== "blocked_domains",
    )
  )
}

function checkMessagesTranslation(
  payload: AnthropicMessagesPayload,
  target: TranslationTarget,
): TranslationCheck {
  const blockers: Array<string> = []
  scanNativeTopLevelControls(payload, blockers)
  scanMessagesContent(payload, blockers, target)
  scanTools(payload.tools, blockers)
  return createCheck(blockers)
}

export function checkMessagesToResponsesTranslation(
  payload: AnthropicMessagesPayload,
): TranslationCheck {
  return checkMessagesTranslation(payload, "responses")
}

export function checkMessagesToChatTranslation(
  payload: AnthropicMessagesPayload,
): TranslationCheck {
  return checkMessagesTranslation(payload, "chat")
}
