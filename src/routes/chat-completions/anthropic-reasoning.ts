import type {
  AnthropicAssistantContentBlock,
  AnthropicThinkingBlock,
} from "~/routes/messages/anthropic-types"
import type {
  Message,
  ResponseMessage,
} from "~/services/copilot/create-chat-completions"

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
  const reasoningOpaque = thinkingBlocks
    .map((block) => block.signature)
    .find(Boolean)
  return {
    ...(reasoningText ? { reasoning_text: reasoningText } : {}),
    ...(reasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
  }
}
