import type { TranslationCheck } from "~/lib/endpoint-routing"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

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

function scanInput(
  input: ResponsesPayload["input"],
  onItem: (item: Record<string, unknown>, type: string | undefined) => void,
): void {
  if (!Array.isArray(input)) return
  for (const item of input) {
    if (!isRecord(item)) continue
    onItem(item, getType(item))
  }
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

function scanInputContentBlockers(
  payload: ResponsesPayload,
  blockers: Array<string>,
): void {
  scanInput(payload.input, (item, type) => {
    if (type !== undefined && type !== "message") return
    if (!Array.isArray(item.content)) return
    for (const content of item.content) {
      if (!isRecord(content)) continue
      if (content.prompt_cache_breakpoint !== undefined) {
        addBlocker(blockers, "prompt_cache_breakpoint")
      }
      if (
        content.type === "input_image"
        && content.detail !== undefined
        && content.detail !== "auto"
      ) {
        addBlocker(blockers, "image_detail")
      }
      if (content.type === "input_file" && content.file_url !== undefined) {
        addBlocker(blockers, "file_url")
      }
    }
  })
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
  scanInput(payload.input, (item, type) => {
    if (type === "reasoning") addBlocker(blockers, "opaque_reasoning")
    if (type === "item_reference") addBlocker(blockers, "item_reference")
    if (type && CHAT_UNSUPPORTED_TOOL_SEMANTICS.has(type)) {
      addBlocker(blockers, `tool_semantics:${type}`)
    }
    if (
      (type === undefined || type === "message")
      && item.phase !== undefined
      && item.phase !== null
    ) {
      addBlocker(blockers, "content_phase")
    }
  })
  scanTools(payload.tools, (_tool, type) => {
    if (type && CHAT_UNSUPPORTED_TOOL_SEMANTICS.has(type)) {
      addBlocker(blockers, `tool_semantics:${type}`)
    }
  })
  scanInputContentBlockers(payload, blockers)
  if (hasStrictFunctionTool(payload)) {
    addBlocker(blockers, "strict_function_tool")
  }
  scanSharedTopLevelBlockers(payload, blockers, { allowTaskBudget: false })
  if (hasUnmappedReasoningSummary(payload)) {
    addBlocker(blockers, "reasoning_summary")
  }
  if (payload.include !== undefined) addBlocker(blockers, "include")
  return createCheck(blockers)
}

export function checkResponsesToMessagesTranslation(
  payload: ResponsesPayload,
): TranslationCheck {
  const blockers: Array<string> = []
  scanInput(payload.input, (_item, type) => {
    if (type === "reasoning") addBlocker(blockers, "opaque_reasoning")
    if (type === "item_reference") addBlocker(blockers, "item_reference")
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
    }
  })
  scanInputContentBlockers(payload, blockers)
  if (hasStrictFunctionTool(payload)) {
    addBlocker(blockers, "strict_function_tool")
  }
  scanSharedTopLevelBlockers(payload, blockers, { allowTaskBudget: true })
  if (!hasOnlyMessagesReasoningInclude(payload)) {
    addBlocker(blockers, "include")
  }
  if (payload.tool_choice === "validated") {
    addBlocker(blockers, "tool_choice")
  }
  return createCheck(blockers)
}
