import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
} from "~/routes/messages/anthropic-types"

import { modelSupportsAssistantPrefill } from "~/lib/model-settings"

/**
 * Apply the model's assistant-prefill setting to a Messages payload that the
 * gateway translated from Chat Completions or Responses. When the model does
 * not accept prefill, the text of a final assistant turn is sent as a user
 * turn, matching the Chat Completions rewrite. Reasoning blocks cannot travel
 * on a user message and are dropped. A final turn with tool calls, or without
 * text, is left unchanged; the Messages contract repairs reasoning-only tails.
 */
export function rewriteUnsupportedAnthropicPrefill(
  payload: AnthropicMessagesPayload,
): void {
  const last = payload.messages.at(-1)
  if (last?.role !== "assistant") return
  const text = finalTurnText(last.content)
  if (!text) return
  if (modelSupportsAssistantPrefill(payload.model)) return

  payload.messages[payload.messages.length - 1] = {
    ...last,
    role: "user",
    content: text,
  }
}

const isReasoningBlockType = (type: unknown): boolean =>
  type === "thinking" || type === "redacted_thinking"

function finalTurnText(
  content: AnthropicMessage["content"],
): string | Array<AnthropicTextBlock> | undefined {
  if (typeof content === "string") return content || undefined
  const hasOtherBlocks = content.some(
    (block) => block.type !== "text" && !isReasoningBlockType(block.type),
  )
  if (hasOtherBlocks) return undefined
  const text = content.flatMap((block) =>
    block.type === "text" ? [block as AnthropicTextBlock] : [],
  )
  return text.length > 0 ? text : undefined
}
