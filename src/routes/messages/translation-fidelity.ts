import type { TranslationCheck } from "~/lib/endpoint-routing"

import { isHttpUrl } from "~/lib/attachments"

import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicThinkingBlock,
  AnthropicTool,
} from "./anthropic-types"

type TranslationTarget = "chat" | "responses"

const ROOT_FIELDS = new Set([
  "cache_control",
  "context_management",
  "fallback_credit_token",
  "max_tokens",
  "messages",
  "metadata",
  "model",
  "output_config",
  "service_tier",
  "speed",
  "stop_details",
  "stop_sequences",
  "stream",
  "system",
  "temperature",
  "thinking",
  "tool_choice",
  "tools",
  "top_k",
  "top_p",
])
const MESSAGE_FIELDS = new Set(["content", "role"])
const CACHE_CONTROL_FIELDS = new Set(["ttl", "type"])
const CONTENT_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  document: new Set([
    "cache_control",
    "citations",
    "context",
    "source",
    "title",
    "type",
  ]),
  image: new Set(["cache_control", "source", "type"]),
  text: new Set(["cache_control", "text", "type"]),
  thinking: new Set(["cache_control", "signature", "thinking", "type"]),
  tool_reference: new Set(["cache_control", "tool_name", "type"]),
  tool_result: new Set([
    "cache_control",
    "content",
    "is_error",
    "tool_use_id",
    "type",
  ]),
  tool_use: new Set(["cache_control", "id", "input", "name", "type"]),
}
const FUNCTION_TOOL_FIELDS = new Set([
  "description",
  "input_schema",
  "name",
  "type",
])
const WEB_SEARCH_TOOL_FIELDS = new Set([
  "allowed_domains",
  "blocked_domains",
  "description",
  "input_schema",
  "name",
  "type",
])
const TOOL_CHOICE_FIELDS = new Set([
  "disable_parallel_tool_use",
  "name",
  "type",
])
const THINKING_FIELDS = new Set(["budget_tokens", "type"])
const OUTPUT_CONFIG_FIELDS = new Set(["effort", "format", "task_budget"])
const METADATA_FIELDS = new Set(["user_id"])

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

function scanUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  options: { blockers: Array<string>; prefix: string },
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addBlocker(options.blockers, `${options.prefix}${key}`)
    }
  }
}

function scanRoot(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  scanUnknownKeys(payload, ROOT_FIELDS, {
    blockers,
    prefix: "request_extension:",
  })
  addPresentBlocker(payload, blockers, "fallback_credit_token")
  addPresentBlocker(payload, blockers, "stop_details")
  addPresentBlocker(payload, blockers, "context_management")
  addPresentBlocker(payload, blockers, "cache_control")
  if (payload.top_k !== undefined) {
    addBlocker(blockers, "top_k")
  }
  if (payload.service_tier !== undefined) {
    addBlocker(blockers, "service_tier")
  }
  if (target === "responses") {
    if (payload.stop_sequences !== undefined) {
      addBlocker(blockers, "stop_sequences")
    }
    if (payload.temperature !== undefined) {
      addBlocker(blockers, "temperature")
    }
  }
}

function scanTypedObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  options: { blockers: Array<string>; prefix: string },
): void {
  if (!isRecord(value)) return
  scanUnknownKeys(value, allowed, options)
}

function scanStructuredControls(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  scanTypedObject(payload.metadata, METADATA_FIELDS, {
    blockers,
    prefix: "metadata.",
  })
  scanTypedObject(payload.thinking, THINKING_FIELDS, {
    blockers,
    prefix: "thinking.",
  })
  scanTypedObject(payload.tool_choice, TOOL_CHOICE_FIELDS, {
    blockers,
    prefix: "tool_choice.",
  })
  if (payload.tool_choice?.disable_parallel_tool_use !== undefined) {
    addBlocker(blockers, "tool_choice.disable_parallel_tool_use")
  }
  scanTypedObject(payload.output_config, OUTPUT_CONFIG_FIELDS, {
    blockers,
    prefix: "output_config.",
  })
  if (target === "chat" && payload.output_config?.task_budget !== undefined) {
    addBlocker(blockers, "output_config.task_budget")
  }
}

function scanCacheControl(value: unknown, blockers: Array<string>): void {
  if (!isRecord(value)) return
  addBlocker(blockers, "content_cache_control")
  scanUnknownKeys(value, CACHE_CONTROL_FIELDS, {
    blockers,
    prefix: "cache_control_extension:",
  })
}

function scanMessagesContent(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      scanContentBlock(block, blockers, target)
    }
  }
  for (const message of payload.messages) {
    scanUnknownKeys(message, MESSAGE_FIELDS, {
      blockers,
      prefix: "message_extension:",
    })
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      scanContentBlock(block, blockers, target)
      if (block.type !== "tool_result" || !Array.isArray(block.content)) {
        continue
      }
      for (const nested of block.content) {
        scanContentBlock(nested, blockers, target)
      }
    }
  }
}

function scanContentBlock(
  block: Record<string, unknown>,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  const type = typeof block.type === "string" ? block.type : "unknown"
  const allowed = CONTENT_FIELDS[type]
  if (allowed === undefined) {
    addBlocker(blockers, `content_type:${type}`)
    return
  }
  scanUnknownKeys(block, allowed, {
    blockers,
    prefix: "content_extension:",
  })
  scanCacheControl(block.cache_control, blockers)
  if (type === "document") {
    scanDocument(block, blockers, target)
  }
  if (
    type === "tool_result"
    && target === "chat"
    && block.is_error !== undefined
  ) {
    addBlocker(blockers, "tool_result.is_error")
  }
  if (type === "tool_reference") addBlocker(blockers, "tool_reference")
  if (type !== "thinking") return
  scanThinkingBlock(
    block as unknown as AnthropicThinkingBlock,
    blockers,
    target,
  )
}

function scanDocument(
  block: Record<string, unknown>,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  if (target === "chat") {
    addBlocker(blockers, "document")
    return
  }
  if (!isResponsesDocumentSource(block)) {
    addBlocker(blockers, "document.source")
  }
  if (block.context !== undefined && block.context !== null) {
    addBlocker(blockers, "document.context")
  }
  if (block.citations !== undefined && block.citations !== null) {
    addBlocker(blockers, "document.citations")
  }
}

function isResponsesDocumentSource(block: Record<string, unknown>): boolean {
  const source = (block as unknown as AnthropicDocumentBlock).source
  if (!isRecord(source)) return false
  if (source.type === "url") {
    return (
      hasExactlyKeys(source, ["type", "url"])
      && typeof source.url === "string"
      && isAbsoluteHttpUrl(source.url)
    )
  }
  return (
    source.type === "base64"
    && hasExactlyKeys(source, ["data", "media_type", "type"])
    && typeof source.media_type === "string"
    && source.media_type.toLowerCase().split(";")[0].trim()
      === "application/pdf"
    && typeof source.data === "string"
  )
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  )
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (!isHttpUrl(value)) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
    )
  } catch {
    return false
  }
}

function scanThinkingBlock(
  block: AnthropicThinkingBlock,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  const signature = block.signature
  if (!signature) {
    if (target === "responses") addBlocker(blockers, "thinking_signature")
    return
  }
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
  if (type?.startsWith("web_search")) {
    scanUnknownKeys(tool, WEB_SEARCH_TOOL_FIELDS, {
      blockers,
      prefix: "tool_extension:",
    })
    return
  }
  if (type?.startsWith("web_fetch")) {
    addBlocker(blockers, "native_tool:web_fetch")
    return
  }
  if (tool.input_schema === undefined && type !== undefined) {
    addBlocker(blockers, `native_tool:${type}`)
    return
  }
  scanUnknownKeys(tool, FUNCTION_TOOL_FIELDS, {
    blockers,
    prefix: "tool_extension:",
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkMessagesTranslation(
  payload: AnthropicMessagesPayload,
  target: TranslationTarget,
): TranslationCheck {
  const blockers: Array<string> = []
  scanRoot(payload, blockers, target)
  scanStructuredControls(payload, blockers, target)
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
