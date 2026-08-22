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
  type AnthropicContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicCustomMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserMessage,
  isAnthropicAssistantMessage,
  isAnthropicDocumentBlock,
  isAnthropicImageBlock,
  isAnthropicNamedTool,
  isAnthropicTextBlock,
  isAnthropicThinkingBlock,
  isAnthropicToolReferenceBlock,
  isAnthropicToolResultBlock,
  isAnthropicToolUseBlock,
  isAnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

const MAX_UNKNOWN_ASSISTANT_BLOCK_TEXT_LENGTH = 16_384

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
    ...(tools?.some((tool) => tool.function.name === "web_search") ?
      { parallel_tool_calls: false }
    : {}),
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

export function sanitizeAnthropicMessages(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  return messages
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: AnthropicMessagesPayload["system"],
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)
  const sanitizedMessages = sanitizeAnthropicMessages(anthropicMessages)

  const otherMessages = sanitizedMessages.flatMap((message) => {
    if (isAnthropicAssistantMessage(message)) {
      return handleAssistantMessage(message)
    }
    if (isAnthropicUserMessage(message)) {
      return handleUserMessage(message)
    }
    return handleCustomRoleMessage(message)
  })

  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: AnthropicMessagesPayload["system"],
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system
      .map((block) =>
        isAnthropicTextBlock(block) ? block.text : JSON.stringify(block),
      )
      .join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleNonAssistantMessageContent(
  content: string | Array<AnthropicContentBlock>,
): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(content)) {
    const toolResultBlocks = content.filter(
      (block): block is AnthropicToolResultBlock =>
        isAnthropicToolResultBlock(block),
    )
    const otherBlocks = content.filter(
      (block) => !isAnthropicToolResultBlock(block),
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
      content: mapContent(content),
    })
  }

  return newMessages
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  return handleNonAssistantMessageContent(message.content)
}

function handleCustomRoleMessage(
  message: AnthropicCustomMessage,
): Array<Message> {
  return handleNonAssistantMessageContent(message.content)
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
    (block): block is AnthropicToolUseBlock => isAnthropicToolUseBlock(block),
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => isAnthropicThinkingBlock(block),
  )
  const signedThinkingBlocks = thinkingBlocks.filter(
    (block) => block.signature && isValidReasoningSignature(block.signature),
  )
  const preserveThinkingAsContext =
    hasMultipleThinkingWithSignature(thinkingBlocks)
  const representativeThinking =
    preserveThinkingAsContext ? signedThinkingBlocks[0] : undefined

  const textContent = message.content
    .filter(
      (block) =>
        isAnthropicTextBlock(block)
        || (!isAnthropicToolUseBlock(block)
          && (preserveThinkingAsContext || !isAnthropicThinkingBlock(block))),
    )
    .map((block) =>
      isAnthropicTextBlock(block) ?
        block.text
      : JSON.stringify(block).slice(0, MAX_UNKNOWN_ASSISTANT_BLOCK_TEXT_LENGTH),
    )
    .join("\n\n")
  const reasoningText =
    preserveThinkingAsContext ?
      (representativeThinking?.thinking ?? "")
    : thinkingBlocks
        .map((block) => block.thinking)
        .filter(
          (thinking) =>
            thinking.trim().length > 0 && thinking !== "Thinking...",
        )
        .join("\n\n")
  let reasoningOpaque: string | undefined
  if (preserveThinkingAsContext) {
    reasoningOpaque = representativeThinking?.signature
  } else if (signedThinkingBlocks.length === 1 && thinkingBlocks.length === 1) {
    reasoningOpaque = signedThinkingBlocks[0]?.signature
  }

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

function hasMultipleThinkingWithSignature(
  thinkingBlocks: ReadonlyArray<AnthropicThinkingBlock>,
): boolean {
  return (
    thinkingBlocks.length > 1
    && thinkingBlocks.some(
      (block) =>
        typeof block.signature === "string" && block.signature.length > 0,
    )
  )
}

export function hasUnrepresentableChatThinkingHistory(
  messages: ReadonlyArray<AnthropicMessage>,
): boolean {
  return messages.some(
    (message) =>
      isAnthropicAssistantMessage(message)
      && Array.isArray(message.content)
      && hasMultipleThinkingWithSignature(
        message.content.filter((block): block is AnthropicThinkingBlock =>
          isAnthropicThinkingBlock(block),
        ),
      ),
  )
}

function isValidReasoningSignature(
  signature: string | undefined,
): signature is string {
  return Boolean(signature && signature.length > 0 && !signature.includes("@"))
}

function mapContent(
  content: string | Array<AnthropicContentBlock>,
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
      .map((block) => {
        if (isAnthropicTextBlock(block)) return block.text
        if (isAnthropicThinkingBlock(block)) return block.thinking
        return JSON.stringify(block)
      })
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    if (isAnthropicTextBlock(block)) {
      contentParts.push({ type: "text", text: block.text })
      continue
    }
    if (isAnthropicThinkingBlock(block)) {
      contentParts.push({ type: "text", text: block.thinking })
      continue
    }
    if (isAnthropicImageBlock(block)) {
      // url sources are inlined to base64 by normalizeAnthropicAttachments
      if (block.source.type === "base64") {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
      }
      continue
    }
    if (isAnthropicDocumentBlock(block)) {
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
      continue
    }
    if (isAnthropicToolReferenceBlock(block)) {
      contentParts.push({ type: "text", text: JSON.stringify(block) })
      continue
    }
    contentParts.push({ type: "text", text: JSON.stringify(block) })
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
    if (!isAnthropicNamedTool(tool) || tool.input_schema === undefined) {
      continue
    }

    result.push({
      type: "function",
      function: {
        name: tool.name,
        description:
          typeof tool.description === "string" ? tool.description : undefined,
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
        ...(choice.message.reasoning_opaque ?
          { signature: choice.message.reasoning_opaque }
        : {}),
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
  const metadata = response as ChatCompletionResponse & {
    copilot_usage?: unknown
    recommended_auto_tier?: "eco" | "balanced"
  }
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
    ...(metadata.copilot_usage !== undefined ?
      { copilot_usage: metadata.copilot_usage }
    : {}),
    ...(metadata.recommended_auto_tier !== undefined ?
      { recommended_auto_tier: metadata.recommended_auto_tier }
    : {}),
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
