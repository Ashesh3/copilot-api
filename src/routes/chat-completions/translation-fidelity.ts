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
const MAPPED_RESPONSES_FORMATS = new Set(["json_object", "json_schema"])
const MAPPED_RESPONSES_TOOL_CHOICES = new Set(["auto", "none", "required"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function createCheck(blockers: Array<string>): TranslationCheck {
  return { supported: blockers.length === 0, blockers }
}

function addBlocker(blockers: Array<string>, blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker)
}

function addPresentBlocker(
  blockers: Array<string>,
  blocker: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null) addBlocker(blockers, blocker)
}

function getType(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  return value.type
}

function hasAnthropicReasoningSignature(message: Message): boolean {
  return (
    typeof message.reasoning_text === "string"
    && message.reasoning_text.trim().length > 0
    && typeof message.reasoning_opaque === "string"
    && message.reasoning_opaque.trim().length > 0
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

function scanMessageNames(
  messages: ChatCompletionsPayload["messages"],
  blockers: Array<string>,
): void {
  if (messages.some((message) => message.name !== undefined)) {
    addBlocker(blockers, "message_name")
  }
}

function scanChatToResponsesReasoning(
  messages: ChatCompletionsPayload["messages"],
  blockers: Array<string>,
): void {
  if (
    messages.some(
      (message) =>
        message.role === "assistant"
        && (message.reasoning_text || message.reasoning_opaque)
        && !message.encrypted_content,
    )
  ) {
    addBlocker(blockers, "reasoning_state")
  }
}

function scanChatToMessagesContent(
  messages: ChatCompletionsPayload["messages"],
  blockers: Array<string>,
): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    if (
      (message.role === "assistant"
        || message.role === "system"
        || message.role === "developer")
      && message.content.some((part) => part.type !== "text")
    ) {
      addBlocker(blockers, "message_content_part")
    }
  }
}

function scanCommonUnmappedControls(
  payload: ChatCompletionsPayload,
  blockers: Array<string>,
): void {
  if (payload.n !== undefined && payload.n !== null && payload.n !== 1) {
    addBlocker(blockers, "n")
  }
  if (payload.stream_options?.include_usage === false) {
    addBlocker(blockers, "stream_options")
  }
  addPresentBlocker(blockers, "frequency_penalty", payload.frequency_penalty)
  addPresentBlocker(blockers, "presence_penalty", payload.presence_penalty)
  addPresentBlocker(blockers, "logit_bias", payload.logit_bias)
  addPresentBlocker(blockers, "logprobs", payload.logprobs)
  addPresentBlocker(blockers, "top_logprobs", payload.top_logprobs)
  addPresentBlocker(blockers, "prediction", payload.prediction)
  addPresentBlocker(blockers, "seed", payload.seed)
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
    if (
      type
      && (HOSTED_RESPONSES_TOOLS.has(type) || type.startsWith("web_search_"))
    ) {
      addBlocker(
        blockers,
        `hosted_tool:${type.startsWith("web_search") ? "web_search" : type}`,
      )
    }
  }
}

export function checkNormalizedChatToResponsesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck {
  const blockers: Array<string> = []
  scanChatMessageContent(payload.messages, blockers)
  scanMessageNames(payload.messages, blockers)
  scanChatToResponsesReasoning(payload.messages, blockers)
  addPresentBlocker(blockers, "stop", payload.stop)
  scanCommonUnmappedControls(payload, blockers)
  addPresentBlocker(blockers, "thinking_budget", payload.thinking_budget)
  if (
    payload.response_format
    && !MAPPED_RESPONSES_FORMATS.has(payload.response_format.type)
  ) {
    addBlocker(blockers, "response_format")
  }
  if (
    payload.tool_choice
    && typeof payload.tool_choice === "object"
    && !("function" in payload.tool_choice)
    && !MAPPED_RESPONSES_TOOL_CHOICES.has(payload.tool_choice.type)
    && !payload.tool_choice.type.startsWith("web_search")
  ) {
    addBlocker(blockers, "tool_choice")
  }
  return createCheck(blockers)
}

export function checkChatToResponsesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck {
  const normalized = normalizeChatCompletionsRequest(payload)
  return checkNormalizedChatToResponsesTranslation(normalized)
}

export function checkNormalizedChatToMessagesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck {
  const blockers: Array<string> = []
  scanMessageNames(payload.messages, blockers)
  scanChatToMessagesContent(payload.messages, blockers)
  for (const message of payload.messages) {
    if (message.role !== "assistant") continue
    const hasReasoning =
      (message.reasoning_text !== undefined && message.reasoning_text !== null)
      || (message.reasoning_opaque !== undefined
        && message.reasoning_opaque !== null)
      || (message.encrypted_content !== undefined
        && message.encrypted_content !== null)
    if (hasReasoning && !hasAnthropicReasoningSignature(message)) {
      addBlocker(blockers, "unsigned_reasoning")
    }
  }
  scanChatToolsForMessages(payload.tools, blockers)
  scanCommonUnmappedControls(payload, blockers)
  if (payload.snippy?.enabled === true) addBlocker(blockers, "snippy")
  return createCheck(blockers)
}

export function checkChatToMessagesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck {
  const normalized = normalizeChatCompletionsRequest(payload)
  return checkNormalizedChatToMessagesTranslation(normalized)
}
