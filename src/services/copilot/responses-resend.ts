import consola from "consola"

import {
  consumeExtraSend,
  type RetryBudget,
} from "~/services/copilot/transport-retry"

import {
  isCodexMemoryRequest,
  trimCodexMemoryRollout,
} from "./codex-memory-rollout"
import { readContextOverflowResponse } from "./context-overflow"

export interface ResponsesAttempt {
  /** The account that answered, as the router reports it. */
  readonly accountId: number | undefined
  readonly payload: Record<string, unknown>
  readonly response: Response
}

export type ResponsesResend = (
  payload: Record<string, unknown>,
) => Promise<Omit<ResponsesAttempt, "payload">>

// Each memory resend is sized from Copilot's latest count, so two suffice.
const MAX_MEMORY_ROLLOUT_TRIMS = 2

/**
 * Codex sizes a memory extraction's rollout at four bytes per token, and a
 * JSON-heavy rollout can exceed the model's prompt limit. Codex keeps the
 * start and end of an oversized rollout, so resend with more of the middle
 * removed, sized from the count and limit Copilot reports.
 */
export async function resendWithShorterMemoryRollout(options: {
  attempt: ResponsesAttempt
  retryBudget: RetryBudget
  send: ResponsesResend
}): Promise<ResponsesAttempt> {
  let { attempt } = options
  for (let trim = 0; trim < MAX_MEMORY_ROLLOUT_TRIMS; trim += 1) {
    if (attempt.response.ok || !isCodexMemoryRequest(attempt.payload)) break
    const overflow = await readContextOverflowResponse(attempt.response)
    if (!overflow) break
    const payload = structuredClone(attempt.payload)
    const removedChars = trimCodexMemoryRollout(payload, overflow)
    if (removedChars === 0 || !consumeExtraSend(options.retryBudget)) break
    consola.warn(
      "Codex memory rollout exceeds the model prompt limit; resending a shorter one",
      {
        limit: overflow.limit,
        promptTokens: overflow.promptTokens,
        removedChars,
      },
    )
    attempt = { payload, ...(await options.send(payload)) }
  }
  return attempt
}
