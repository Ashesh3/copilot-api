import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { getLastUsedAccountId } from "~/lib/account-router"
import { createChatCompletionsWithProcessedPayload } from "~/services/copilot/create-chat-completions"

export interface PreparedGoogleChatCompletion {
  readonly accountId?: number
  readonly processedPayload: ChatCompletionsPayload
  readonly response:
    | ChatCompletionResponse
    | AsyncIterable<{
        readonly data?: string
        readonly event?: string
        readonly id?: string | number
        readonly retry?: number
      }>
}

export type GoogleChatCompletionFactory = (
  payload: ChatCompletionsPayload,
  options: {
    readonly allowCompatibilityRetry?: boolean
    readonly signal?: AbortSignal
  },
) => Promise<PreparedGoogleChatCompletion>

export const createCopilotGoogleChatCompletion: GoogleChatCompletionFactory =
  async (payload, options) => {
    const completion = await createChatCompletionsWithProcessedPayload(
      payload,
      {
        allowCompatibilityRetry: options.allowCompatibilityRetry,
        candidatePrepared: true,
        signal: options.signal,
      },
    )
    return {
      ...completion,
      accountId: getLastUsedAccountId(),
    }
  }
