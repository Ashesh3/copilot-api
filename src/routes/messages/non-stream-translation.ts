import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"
import {
  createWebSearchFunctionTool,
  isWebSearchToolType,
} from "~/services/copilot/mcp-web-search"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolReferenceBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const tools = translateAnthropicToolsToOpenAI(payload.tools)
  return {
    model: translateModelName(payload.model),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    response_format: translateOutputFormatToOpenAI(payload.output_config),
    tools,
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    parallel_tool_calls:
      tools?.some((tool) => tool.function.name === "web_search") ? false : true,
    snippy: { enabled: false },
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
  }
}

function translateOutputFormatToOpenAI(
  outputConfig: AnthropicMessagesPayload["output_config"],
): ChatCompletionsPayload["response_format"] | undefined {
  const format = outputConfig?.format
  if (!format) {
    return undefined
  }

  if (format.type === "json_schema") {
    const { type, ...jsonSchema } = format
    return {
      type,
      json_schema: jsonSchema,
    }
  }

  return format
}

function translateModelName(model: string): string {
  // Subagent requests use a specific dated model which Copilot doesn't support
  // e.g., claude-sonnet-4-20250514 -> claude-sonnet-4
  // But preserve version numbers like claude-opus-4-5 (normalized to claude-opus-4.5 later)
  if (/^claude-sonnet-4-\d{8}/.test(model)) {
    return "claude-sonnet-4"
  } else if (/^claude-opus-4-\d{8}/.test(model)) {
    return "claude-opus-4"
  }
  return model
}

const HARNESS_USER_PREFIXES = [
  "<available-deferred-tools>",
  "<system-reminder>\nSessionStart hook additional context:",
  "<system-reminder>\n# MCP Server Instructions",
  "<system-reminder>\nThe following skills are available for use with the Skill tool:",
  "<system-reminder>\nThe task tools haven't been used recently.",
]

const HARNESS_TOOL_RESULT_MARKERS = [
  "IMPORTANT: This message and these instructions are NOT part of the actual user conversation.",
  String.raw`\session-memory\summary.md`,
  "The task tools haven't been used recently.",
]

const HARNESS_TOOL_USE_NAMES = new Set([
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "LSP",
  "ListMcpResourcesTool",
  "NotebookEdit",
  "ReadMcpResourceTool",
  "SendMessage",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "WebFetch",
  "WebSearch",
])

function isClaudeCodeHarnessUserMessage(
  message: AnthropicUserMessage,
): boolean {
  if (typeof message.content !== "string") {
    return false
  }

  const content = message.content.trimStart()
  return HARNESS_USER_PREFIXES.some((prefix) => content.startsWith(prefix))
}

function getToolResultText(
  content: AnthropicToolResultBlock["content"],
): string | null {
  if (typeof content === "string") {
    return content
  }

  const textBlocks = content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )
  if (textBlocks.length !== content.length) {
    return null
  }

  return textBlocks.map((block) => block.text).join("\n\n")
}

function isClaudeCodeHarnessToolResult(
  block: AnthropicToolResultBlock,
): boolean {
  const text = getToolResultText(block.content)?.trim()
  if (!text) {
    return false
  }

  if (text === "Tool loaded.") {
    return true
  }

  if (
    text.startsWith("only Edit on ")
    && text.includes(String.raw`\session-memory\summary.md is allowed`)
  ) {
    return true
  }

  return HARNESS_TOOL_RESULT_MARKERS.some((marker) => text.includes(marker))
}

function isHarnessOnlyToolResultMessage(
  message: AnthropicMessage | undefined,
): message is AnthropicUserMessage {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) {
    return false
  }

  return (
    message.content.length > 0
    && message.content.every(
      (block) =>
        block.type === "tool_result" && isClaudeCodeHarnessToolResult(block),
    )
  )
}

function isHarnessOnlyAssistantToolUseMessage(
  message: AnthropicMessage,
): message is AnthropicAssistantMessage {
  return (
    message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every(
      (block) =>
        block.type === "tool_use" && HARNESS_TOOL_USE_NAMES.has(block.name),
    )
  )
}

export function sanitizeAnthropicMessages(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  const sanitized: Array<AnthropicMessage> = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]

    if (message.role === "user" && isClaudeCodeHarnessUserMessage(message)) {
      continue
    }

    if (
      isHarnessOnlyAssistantToolUseMessage(message)
      && isHarnessOnlyToolResultMessage(messages[index + 1])
    ) {
      index++
      continue
    }
    sanitized.push(message)
  }

  return sanitized
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)
  const sanitizedMessages = sanitizeAnthropicMessages(anthropicMessages)

  const otherMessages = sanitizedMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  const textContent = textBlocks.map((block) => block.text).join("\n\n")
  const reasoningText = thinkingBlocks
    .map((block) => block.thinking)
    .filter(
      (thinking) => thinking.trim().length > 0 && thinking !== "Thinking...",
    )
    .join("\n\n")
  const reasoningOpaque = thinkingBlocks
    .map((block) => block.signature)
    .find((signature) => isValidReasoningSignature(signature))

  return [
    {
      role: "assistant",
      content: textContent || null,
      ...(reasoningText ? { reasoning_text: reasoningText } : {}),
      ...(reasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
      ...(toolUseBlocks.length > 0 ?
        {
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        }
      : {}),
    },
  ]
}

function isValidReasoningSignature(
  signature: string | undefined,
): signature is string {
  return Boolean(signature && signature.length > 0 && !signature.includes("@"))
}

function mapContent(
  content:
    | string
    | Array<
        | AnthropicUserContentBlock
        | AnthropicAssistantContentBlock
        | AnthropicToolReferenceBlock
      >,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasAttachment = content.some(
    (block) => block.type === "image" || block.type === "document",
  )
  if (!hasAttachment) {
    return content
      .filter(
        (
          block,
        ): block is
          | AnthropicTextBlock
          | AnthropicThinkingBlock
          | AnthropicToolReferenceBlock =>
          block.type === "text"
          || block.type === "thinking"
          || block.type === "tool_reference",
      )
      .map((block) => {
        if (block.type === "text") return block.text
        if (block.type === "thinking") return block.thinking
        return JSON.stringify(block)
      })
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

        break
      }
      case "image": {
        // url sources are inlined to base64 by normalizeAnthropicAttachments
        if (block.source.type === "base64") {
          contentParts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
        }

        break
      }
      case "document": {
        // Base64 PDFs become OpenAI `file` parts: custom providers accept
        // them natively; the Copilot /chat/completions path downgrades them
        // to a text note in normalizeChatAttachments. PDF-capable Copilot
        // models are routed to /v1/messages or /responses before this
        // translation runs.
        if (block.source.type === "base64") {
          contentParts.push({
            type: "file",
            file: {
              filename: block.title ?? "document.pdf",
              file_data: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
        }

        break
      }
      case "tool_reference": {
        contentParts.push({ type: "text", text: JSON.stringify(block) })
        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }

  const result: Array<Tool> = []

  for (const tool of anthropicTools) {
    // Convert web_search server-side tool to a function tool
    if (isWebSearchToolType(tool)) {
      result.push(createWebSearchFunctionTool(tool))
      continue
    }

    // Filter out other server-side tools without input_schema
    if (tool.input_schema === undefined) {
      continue
    }

    result.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })
  }

  return result.length > 0 ? result : undefined
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
  originalModel?: string,
): AnthropicResponse {
  const { contentBlocks, stopReason } = extractContentFromChoices(response)
  return buildAnthropicResponse(response, {
    contentBlocks,
    stopReason,
    originalModel,
  })
}

function extractContentFromChoices(response: ChatCompletionResponse): {
  contentBlocks: Array<
    AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock
  >
  stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null
} {
  const allThinkingBlocks: Array<AnthropicThinkingBlock> = []
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    response.choices[0]?.finish_reason ?? null

  for (const choice of response.choices) {
    // Extract reasoning/thinking blocks from CAPI response
    if (choice.message.reasoning_text) {
      allThinkingBlocks.push({
        type: "thinking",
        thinking: choice.message.reasoning_text,
        signature: choice.message.reasoning_opaque ?? "",
      })
    }

    allTextBlocks.push(...getAnthropicTextBlocks(choice.message.content))
    allToolUseBlocks.push(
      ...getAnthropicToolUseBlocks(choice.message.tool_calls),
    )

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    contentBlocks: [
      ...allThinkingBlocks,
      ...allTextBlocks,
      ...allToolUseBlocks,
    ],
    stopReason,
  }
}

function buildAnthropicResponse(
  response: ChatCompletionResponse,
  options: {
    contentBlocks: Array<
      AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock
    >
    stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null
    originalModel?: string
  },
): AnthropicResponse {
  const { contentBlocks, stopReason, originalModel } = options
  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: originalModel ?? response.model,
    content: contentBlocks,
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: (response.usage?.prompt_tokens ?? 0) - cachedTokens,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cachedTokens,
      cache_creation_input_tokens: 0,
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: safeParseFunctionArgs(toolCall.function.arguments),
  }))
}

const safeParseFunctionArgs = (
  rawArguments: string,
): Record<string, unknown> => {
  try {
    return JSON.parse(rawArguments) as Record<string, unknown>
  } catch {
    return { raw_arguments: rawArguments }
  }
}
