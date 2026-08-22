import { stripAssistantThinkingBlocks } from "~/services/copilot/compatibility-retry"

import type { AnthropicMessagesPayload } from "./anthropic-types"

export function stripThinkingBlocks(
  payload: AnthropicMessagesPayload,
): boolean {
  return stripAssistantThinkingBlocks(
    payload as unknown as Record<string, unknown>,
  )
}
