import type { TranslationCheck } from "~/lib/endpoint-routing"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { isPdfMediaType, parseDataUri } from "~/lib/attachments"

const CHAT_UNSUPPORTED_TOOL_SEMANTICS = new Set([
  "custom",
  "custom_tool_call",
  "custom_tool_call_output",
  "computer_call_output",
  "namespace",
  "programmatic_tool_calling",
  "programmatic_tool_call",
  "programmatic_tool_call_output",
])
const MESSAGES_HOSTED_TOOL_TYPES = new Set([
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
const CHAT_INPUT_TOOL_BLOCKERS: Record<string, string> = {
  computer_call_output: "tool_semantics:computer_call_output",
  custom_tool_call: "tool_semantics:custom_tool_call",
  custom_tool_call_output: "tool_semantics:custom_tool_call_output",
  programmatic_tool_call: "tool_semantics:programmatic_tool_call",
  programmatic_tool_call_output: "tool_semantics:programmatic_tool_call_output",
}
const MESSAGES_INPUT_TOOL_BLOCKERS = { ...CHAT_INPUT_TOOL_BLOCKERS }

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

function scanTools(
  tools: ResponsesPayload["tools"],
  onTool: (tool: Record<string, unknown>, type: string | undefined) => void,
): void {
  if (!Array.isArray(tools)) return
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    onTool(tool, getType(tool))
  }
}

function isCustomGrammar(tool: Record<string, unknown>): boolean {
  if (tool.type !== "custom") return false
  if (!isRecord(tool.format)) return true
  return tool.format.type === "grammar"
}

function scanSharedTopLevelBlockers(
  payload: ResponsesPayload,
  blockers: Array<string>,
  options: { allowTaskBudget: boolean },
): void {
  addPresentBlocker(blockers, "prompt", payload.prompt)
  addPresentBlocker(blockers, "conversation_id", payload.conversation_id)
  addPresentBlocker(blockers, "metadata", payload.metadata)
  addPresentBlocker(blockers, "safety_identifier", payload.safety_identifier)
  addPresentBlocker(blockers, "prompt_cache_key", payload.prompt_cache_key)
  addPresentBlocker(
    blockers,
    "prompt_cache_options",
    payload.prompt_cache_options,
  )
  addPresentBlocker(
    blockers,
    "prompt_cache_retention",
    payload.prompt_cache_retention,
  )
  addPresentBlocker(blockers, "context_management", payload.context_management)
  addPresentBlocker(blockers, "truncation", payload.truncation)
  addPresentBlocker(blockers, "multi_agent", payload.multi_agent)
  addPresentBlocker(blockers, "snippy", payload.snippy)
  addPresentBlocker(blockers, "generate", payload.generate)
  if (!options.allowTaskBudget) {
    addPresentBlocker(blockers, "task_budget", payload.task_budget)
  }
  addPresentBlocker(
    blockers,
    "copilot_cache_control",
    payload.copilot_cache_control,
  )
  addPresentBlocker(blockers, "client_metadata", payload.client_metadata)
}

function hasUnmappedReasoningSummary(payload: ResponsesPayload): boolean {
  return (
    payload.reasoning?.summary !== undefined
    && payload.reasoning.summary !== null
    && payload.reasoning.summary !== "auto"
  )
}

function hasOnlyMessagesReasoningInclude(payload: ResponsesPayload): boolean {
  return (
    payload.include === undefined
    || payload.include.length === 0
    || (payload.include.length === 1
      && payload.include[0] === "reasoning.encrypted_content")
  )
}

function scanInputContent(content: unknown, blockers: Array<string>): void {
  if (!isRecord(content)) {
    addBlocker(blockers, "content_type")
    return
  }
  const contentType = getType(content)
  if (!contentType) {
    addBlocker(blockers, "content_type")
    return
  }
  if (content.prompt_cache_breakpoint !== undefined) {
    addBlocker(blockers, "prompt_cache_breakpoint")
  }
  switch (contentType) {
    case "input_image": {
      scanInputImage(content, blockers)
      return
    }
    case "input_file": {
      scanInputFile(content, blockers)
      return
    }
    case "input_text":
    case "output_text": {
      return
    }
    default: {
      addBlocker(blockers, "content_type")
    }
  }
}

function scanInputImage(
  content: Record<string, unknown>,
  blockers: Array<string>,
): void {
  const hasImageUrl =
    typeof content.image_url === "string" && content.image_url.length > 0
  if (!hasImageUrl) {
    const hasFileId =
      typeof content.file_id === "string" && content.file_id.length > 0
    addBlocker(blockers, hasFileId ? "input_image:file_id" : "input_image")
  }
  if (content.detail !== undefined && content.detail !== "auto") {
    addBlocker(blockers, "image_detail")
  }
}

function scanInputFile(
  content: Record<string, unknown>,
  blockers: Array<string>,
): void {
  const hasFileData =
    typeof content.file_data === "string" && content.file_data.length > 0
  const hasFileId =
    typeof content.file_id === "string" && content.file_id.length > 0
  if (hasFileId) addBlocker(blockers, "input_file:file_id")
  if (!hasFileData && !hasFileId && content.file_url === undefined) {
    addBlocker(blockers, "input_file")
  }
  if (hasFileData) {
    const parsed = parseDataUri(content.file_data as string)
    if (!parsed || !isPdfMediaType(parsed.mediaType)) {
      addBlocker(blockers, "input_file")
    }
  }
  if (content.file_url !== undefined) addBlocker(blockers, "file_url")
}

const SUPPORTED_INPUT_ITEMS = new Set([
  "computer_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "item_reference",
  "message",
  "programmatic_tool_call",
  "programmatic_tool_call_output",
  "reasoning",
])
const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"])

function scanResponsesInput(
  input: ResponsesPayload["input"],
  blockers: Array<string>,
  options: { toolBlockers: Record<string, string> },
): void {
  if (!Array.isArray(input)) return
  for (const item of input) {
    if (!isRecord(item)) {
      addBlocker(blockers, "input_item")
      continue
    }
    const type = getType(item)
    addInputItemBlockers({ item, type, blockers, ...options })
    scanItemContent(item, type, blockers)
  }
}

function addInputItemBlockers(options: {
  blockers: Array<string>
  item: Record<string, unknown>
  type: string | undefined
  toolBlockers: Record<string, string>
}): void {
  const { blockers, item, toolBlockers, type } = options
  if (type === "reasoning") addBlocker(blockers, "opaque_reasoning")
  if (type === "item_reference") addBlocker(blockers, "item_reference")
  if (type === "function_call" && !isLosslessFunctionCall(item)) {
    addBlocker(blockers, "function_call")
  }
  if (
    type === "function_call_output"
    && (typeof item.call_id !== "string" || item.call_id.length === 0)
  ) {
    addBlocker(blockers, "tool_result_pairing")
  }
  if (!isSupportedItemStatus(item.status)) addBlocker(blockers, "item_status")
  addKnownInputToolBlocker(blockers, type, toolBlockers)

  if (
    (type === undefined || type === "message")
    && item.phase !== undefined
    && item.phase !== null
  ) {
    addBlocker(blockers, "content_phase")
  }

  if (!isKnownInputItem(item, type)) addBlocker(blockers, "input_item")
}

function isSupportedItemStatus(status: unknown): boolean {
  return (
    status === undefined
    || status === "in_progress"
    || status === "completed"
    || status === "incomplete"
  )
}

function isLosslessFunctionCall(item: Record<string, unknown>): boolean {
  return (
    typeof item.call_id === "string"
    && item.call_id.length > 0
    && typeof item.name === "string"
    && item.name.length > 0
    && typeof item.arguments === "string"
  )
}

function isKnownInputItem(
  item: Record<string, unknown>,
  type: string | undefined,
): boolean {
  const isImplicitMessage =
    type === undefined
    && typeof item.role === "string"
    && MESSAGE_ROLES.has(item.role)
  return isImplicitMessage || Boolean(type && SUPPORTED_INPUT_ITEMS.has(type))
}

function scanItemContent(
  item: Record<string, unknown>,
  type: string | undefined,
  blockers: Array<string>,
): void {
  let field: "content" | "output" | undefined
  if (type === undefined || type === "message") field = "content"
  else if (type === "function_call_output") field = "output"
  if (!field) return
  if (!Object.hasOwn(item, field)) {
    if (field === "output") addBlocker(blockers, "content_type")
    return
  }

  const content = item[field]
  if (typeof content === "string") return
  if (!Array.isArray(content)) {
    addBlocker(blockers, "content_type")
    return
  }
  for (const part of content) {
    if (
      field === "content"
      && isRecord(part)
      && (part.type === "input_image" || part.type === "input_file")
      && item.role !== "user"
    ) {
      addBlocker(blockers, "message_content_role")
    }
    scanInputContent(part, blockers)
  }
}

function addKnownInputToolBlocker(
  blockers: Array<string>,
  type: string | undefined,
  mapping: Record<string, string>,
): void {
  if (!type) return
  const blocker = mapping[type]
  if (blocker) addBlocker(blockers, blocker)
}

function isSupportedToolChoice(
  value: ResponsesPayload["tool_choice"],
): boolean {
  if (
    value === undefined
    || value === "auto"
    || value === "none"
    || value === "required"
  ) {
    return true
  }
  return (
    isRecord(value)
    && value.type === "function"
    && typeof value.name === "string"
    && value.name.length > 0
  )
}

function isSupportedTextFormat(payload: ResponsesPayload): boolean {
  const format = payload.text?.format
  if (format === undefined || format === null) return true
  if (format.type === "json_object") return true
  return format.type === "json_schema" && format.schema !== undefined
}

function hasStrictFunctionTool(payload: ResponsesPayload): boolean {
  return Boolean(
    payload.tools?.some(
      (tool) =>
        isRecord(tool) && tool.type === "function" && tool.strict === true,
    ),
  )
}

export function checkResponsesToChatTranslation(
  payload: ResponsesPayload,
): TranslationCheck {
  const blockers: Array<string> = []
  scanResponsesInput(payload.input, blockers, {
    toolBlockers: CHAT_INPUT_TOOL_BLOCKERS,
  })
  scanTools(payload.tools, (_tool, type) => {
    if (type && CHAT_UNSUPPORTED_TOOL_SEMANTICS.has(type)) {
      addBlocker(blockers, `tool_semantics:${type}`)
      return
    }
    if (type !== "function") {
      addBlocker(blockers, "tool_semantics")
      return
    }
    if (!isLosslessFunctionTool(_tool)) {
      addBlocker(blockers, "function_tool")
    }
  })
  if (hasStrictFunctionTool(payload)) {
    addBlocker(blockers, "strict_function_tool")
  }
  scanSharedTopLevelBlockers(payload, blockers, { allowTaskBudget: false })
  if (hasUnmappedReasoningSummary(payload)) {
    addBlocker(blockers, "reasoning_summary")
  }
  if (typeof payload.reasoning?.effort === "number") {
    addBlocker(blockers, "numeric_reasoning_effort")
  }
  if (payload.include !== undefined) addBlocker(blockers, "include")
  if (!isSupportedToolChoice(payload.tool_choice)) {
    addBlocker(blockers, "tool_choice")
  }
  if (!isSupportedTextFormat(payload)) addBlocker(blockers, "text_format")
  return createCheck(blockers)
}

export function checkResponsesToMessagesTranslation(
  payload: ResponsesPayload,
): TranslationCheck {
  const blockers: Array<string> = []
  scanResponsesInput(payload.input, blockers, {
    toolBlockers: MESSAGES_INPUT_TOOL_BLOCKERS,
  })
  scanTools(payload.tools, (tool, type) => {
    if (isCustomGrammar(tool)) {
      addBlocker(blockers, "custom_tool_grammar")
      return
    }
    if (
      type
      && (MESSAGES_HOSTED_TOOL_TYPES.has(type)
        || type.startsWith("web_search_"))
    ) {
      addBlocker(
        blockers,
        `hosted_tool:${type.startsWith("web_search") ? "web_search" : type}`,
      )
      return
    }
    if (type !== "function") {
      addBlocker(blockers, "tool_semantics")
      return
    }
    if (!isLosslessFunctionTool(tool)) {
      addBlocker(blockers, "function_tool")
    }
  })
  if (hasStrictFunctionTool(payload)) {
    addBlocker(blockers, "strict_function_tool")
  }
  scanSharedTopLevelBlockers(payload, blockers, { allowTaskBudget: true })
  if (!hasOnlyMessagesReasoningInclude(payload)) {
    addBlocker(blockers, "include")
  }
  if (!isSupportedToolChoice(payload.tool_choice)) {
    addBlocker(blockers, "tool_choice")
  }
  if (!isSupportedTextFormat(payload)) addBlocker(blockers, "text_format")
  return createCheck(blockers)
}

function isLosslessFunctionTool(tool: Record<string, unknown>): boolean {
  return (
    typeof tool.name === "string"
    && tool.name.length > 0
    && (tool.description === undefined
      || tool.description === null
      || typeof tool.description === "string")
    && isRecord(tool.parameters)
  )
}
