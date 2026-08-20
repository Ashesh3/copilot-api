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

import { createEndpointTranslationError } from "~/lib/error"

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
  const signedThinkingBlocks = thinkingBlocks.filter((block) => block.signature)
  if (
    signedThinkingBlocks.length > 1
    || (signedThinkingBlocks.length === 1 && thinkingBlocks.length > 1)
  ) {
    throw createEndpointTranslationError({
      blockers: ["multiple_signed_thinking_blocks"],
      code: "endpoint_translation_unsupported",
      source: "chat",
    })
  }
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
