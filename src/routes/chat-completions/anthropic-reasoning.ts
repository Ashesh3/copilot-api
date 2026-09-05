import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicThinkingBlock,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  Message,
  ResponseMessage,
} from "~/services/copilot/create-chat-completions"

const NATIVE_CONTENT_PREFIX = "copilot-anthropic-content-v1:"

// Keep the native ordering and signed bytes separate from Chat's readable
// projections. Only the simple leading thinking block fits the legacy pair.
export function decodeAnthropicContent(
  opaque: unknown,
): Array<AnthropicAssistantContentBlock> | undefined {
  if (typeof opaque !== "string" || !opaque.startsWith(NATIVE_CONTENT_PREFIX))
    return undefined
  try {
    const content: unknown = JSON.parse(
      Buffer.from(
        opaque.slice(NATIVE_CONTENT_PREFIX.length),
        "base64",
      ).toString("utf8"),
    )
    if (
      Array.isArray(content)
      && content.length > 0
      && content.every(
        (block: unknown) =>
          typeof block === "object"
          && block !== null
          && !Array.isArray(block)
          && typeof (block as { type?: unknown }).type === "string",
      )
    )
      return content as Array<AnthropicAssistantContentBlock>
  } catch {
    // Unrecognized opaque values retain the existing signature fallback.
  }
  return undefined
}

export function createAssistantBlocks(
  message: Message,
): Array<AnthropicAssistantContentBlock> {
  if (!message.reasoning_text || !message.reasoning_opaque) return []
  return [
    {
      type: "thinking",
      thinking: message.reasoning_text,
      signature: message.reasoning_opaque,
    },
  ]
}

export function getAnthropicReasoning(
  content: Array<AnthropicAssistantContentBlock>,
): Pick<ResponseMessage, "reasoning_opaque" | "reasoning_text"> {
  const thinkingBlocks = content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )
  const reasoningText = thinkingBlocks
    .map((block) => block.thinking)
    .join("\n\n")
  const hasRedacted = content.some(
    (block) => block.type === "redacted_thinking",
  )
  const needsEnvelope =
    hasRedacted
    || (thinkingBlocks.some((block) => block.signature)
      && (thinkingBlocks.length > 1
        || content[0] !== thinkingBlocks[0]
        || !thinkingBlocks[0].thinking))
  const reasoningOpaque =
    needsEnvelope ?
      NATIVE_CONTENT_PREFIX
      + Buffer.from(JSON.stringify(content)).toString("base64")
    : thinkingBlocks[0]?.signature
  return {
    ...(reasoningText ? { reasoning_text: reasoningText } : {}),
    ...(reasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
  }
}

export function convertChatReasoningOptions(
  payload: ChatCompletionsPayload,
): Pick<AnthropicMessagesPayload, "output_config" | "thinking"> {
  const outputConfig: NonNullable<AnthropicMessagesPayload["output_config"]> =
    {}
  if (typeof payload.reasoning_effort === "string") {
    outputConfig.effort = payload.reasoning_effort as NonNullable<
      AnthropicMessagesPayload["output_config"]
    >["effort"]
  }
  const outputFormat = convertResponseFormat(payload.response_format)
  if (outputFormat) outputConfig.format = outputFormat
  return {
    ...(Object.keys(outputConfig).length > 0 ?
      { output_config: outputConfig }
    : {}),
    ...((
      payload.thinking_budget !== undefined && payload.thinking_budget !== null
    ) ?
      {
        thinking: {
          type: "enabled" as const,
          budget_tokens: payload.thinking_budget,
        },
      }
    : {}),
  }
}

export function applyParallelToolChoice(
  toolChoice: Pick<AnthropicMessagesPayload, "tool_choice">,
  parallelToolCalls: boolean | null | undefined,
  tools: ChatCompletionsPayload["tools"],
): Pick<AnthropicMessagesPayload, "tool_choice"> {
  if (parallelToolCalls !== false || !tools?.length) return toolChoice
  return {
    tool_choice: {
      ...(toolChoice.tool_choice ?? { type: "auto" as const }),
      disable_parallel_tool_use: true,
    },
  }
}

function convertResponseFormat(
  responseFormat: ChatCompletionsPayload["response_format"],
): NonNullable<AnthropicMessagesPayload["output_config"]>["format"] {
  if (!responseFormat) return undefined
  if (responseFormat.type !== "json_schema") return responseFormat
  const jsonSchema = responseFormat.json_schema
  if (!jsonSchema || typeof jsonSchema !== "object") return undefined
  return { type: "json_schema", ...jsonSchema }
}
