import type { RequestBehavior } from "~/lib/request-logger"
import type {
  AnthropicMessagesPayload,
  AnthropicSystemContentBlock,
} from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { normalizeModelName } from "~/lib/model-resolver"
import { getModelSettings } from "~/lib/model-settings"
import { parseModelSuffix } from "~/lib/model-suffix"
import { isClaudePermissionReviewRequest } from "~/lib/permission-review"

/** A model's forced system prompt, found from the model a client requested. */
export interface ForcedSystemPrompt {
  /** The model settings entry that supplied the prompt. */
  model: string
  prompt: string
  /** Remove the client's own system and developer prompts. */
  clearOtherSystemPrompts: boolean
}

export interface ForcedSystemPromptOutcome {
  forced: ForcedSystemPrompt
  /** Client system or developer prompts removed from the request. */
  removed: number
}

const isInstructionRole = (role: unknown): boolean =>
  role === "system" || role === "developer"

/** A Responses input message that carries system or developer instructions. */
export function isResponsesInstructionItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false
  const record = item as Record<string, unknown>
  if (record.type !== undefined && record.type !== "message") return false
  return isInstructionRole(record.role)
}

/**
 * Find the forced system prompt for the model a client asked for. The exact
 * requested ID wins, then the ID without a reasoning suffix, then its
 * normalized form, so "claude-opus-4-6:high" matches a setting saved as
 * "claude-opus-4.6".
 */
export function resolveForcedSystemPrompt(
  requestedModel: unknown,
): ForcedSystemPrompt | undefined {
  if (typeof requestedModel !== "string") return undefined
  const exact = requestedModel.trim()
  if (!exact) return undefined
  const { baseModel } = parseModelSuffix(exact)
  for (const model of new Set([
    exact,
    baseModel,
    normalizeModelName(baseModel),
  ])) {
    const settings = getModelSettings(model)
    if (settings?.forcedSystemPrompt) {
      return {
        model,
        prompt: settings.forcedSystemPrompt,
        clearOtherSystemPrompts: settings.clearOtherSystemPrompts === true,
      }
    }
  }
  return undefined
}

/**
 * Put the forced prompt first as its own system message. Applying it again
 * leaves an already-forced request unchanged.
 */
export function applyForcedSystemPromptToChat(
  payload: { messages: Array<Message> },
  forced: ForcedSystemPrompt,
): ForcedSystemPromptOutcome {
  let removed = 0
  if (forced.clearOtherSystemPrompts) {
    removed = payload.messages.filter(
      (message) =>
        isInstructionRole(message.role) && message.content !== forced.prompt,
    ).length
    payload.messages = payload.messages.filter(
      (message) => !isInstructionRole(message.role),
    )
  }
  const first = payload.messages.at(0)
  if (first?.role !== "system" || first.content !== forced.prompt) {
    payload.messages.unshift({ role: "system", content: forced.prompt })
  }
  return { forced, removed }
}

function textBlock(text: string): AnthropicSystemContentBlock {
  return { type: "text", text }
}

function countOtherSystemBlocks(
  system: AnthropicMessagesPayload["system"],
  prompt: string,
): number {
  if (system === undefined) return 0
  if (typeof system === "string") return system && system !== prompt ? 1 : 0
  return system.filter(
    (block) => block.type !== "text" || block.text !== prompt,
  ).length
}

function prependSystemBlock(
  system: AnthropicMessagesPayload["system"],
  prompt: string,
): AnthropicMessagesPayload["system"] {
  if (system === undefined || system.length === 0) return prompt
  if (typeof system === "string") {
    return system === prompt ? system : [textBlock(prompt), textBlock(system)]
  }
  const first = system[0]
  if (first.type === "text" && first.text === prompt) return system
  return [textBlock(prompt), ...system]
}

/**
 * Put the forced prompt first in the Messages `system` field. Clearing also
 * removes system and developer turns that Claude clients send in `messages`;
 * the request contract has already lifted their per-turn controls.
 */
export function applyForcedSystemPromptToMessages(
  payload: AnthropicMessagesPayload,
  forced: ForcedSystemPrompt,
): ForcedSystemPromptOutcome {
  if (!forced.clearOtherSystemPrompts) {
    payload.system = prependSystemBlock(payload.system, forced.prompt)
    return { forced, removed: 0 }
  }
  const instructionTurns = payload.messages.filter((message) =>
    isInstructionRole(message.role),
  ).length
  const removed =
    countOtherSystemBlocks(payload.system, forced.prompt) + instructionTurns
  payload.messages = payload.messages.filter(
    (message) => !isInstructionRole(message.role),
  )
  payload.system = forced.prompt
  return { forced, removed }
}

function withoutInstructionItems(
  input: Array<ResponseInputItem>,
): Array<ResponseInputItem> {
  return input.filter((item) => !isResponsesInstructionItem(item))
}

/**
 * Put the forced prompt at the start of Responses `instructions`, which every
 * upstream route places before the input items.
 */
export function applyForcedSystemPromptToResponses(
  payload: ResponsesPayload,
  forced: ForcedSystemPrompt,
): ForcedSystemPromptOutcome {
  const instructions =
    typeof payload.instructions === "string" ? payload.instructions : ""
  if (forced.clearOtherSystemPrompts) {
    let removed = instructions.trim() && instructions !== forced.prompt ? 1 : 0
    if (Array.isArray(payload.input)) {
      const kept = withoutInstructionItems(payload.input)
      removed += payload.input.length - kept.length
      payload.input = kept
    }
    payload.instructions = forced.prompt
    return { forced, removed }
  }
  const alreadyForced =
    instructions === forced.prompt
    || instructions.startsWith(`${forced.prompt}\n\n`)
  if (!alreadyForced) {
    payload.instructions =
      instructions ? `${forced.prompt}\n\n${instructions}` : forced.prompt
  }
  return { forced, removed: 0 }
}

/** Request-log entry for an applied forced system prompt. */
export function forcedSystemPromptBehavior(
  outcome: ForcedSystemPromptOutcome,
): RequestBehavior {
  const { forced, removed } = outcome
  const plural = removed === 1 ? "" : "s"
  return {
    kind: "forced_system_prompt",
    message:
      forced.clearOtherSystemPrompts ?
        `Sent the forced system prompt from the ${forced.model} model setting and removed ${removed} other system prompt${plural}`
      : `Sent the forced system prompt from the ${forced.model} model setting before the client's system prompts`,
    data: {
      model: forced.model,
      clearOtherSystemPrompts: forced.clearOtherSystemPrompts,
      removedSystemPrompts: removed,
    },
  }
}

export function forceChatSystemPrompt(
  payload: { messages: Array<Message> },
  requestedModel: unknown,
): RequestBehavior | undefined {
  const forced = resolveForcedSystemPrompt(requestedModel)
  if (!forced) return undefined
  return forcedSystemPromptBehavior(
    applyForcedSystemPromptToChat(payload, forced),
  )
}

/**
 * Claude's permission classifier is left alone: its policy prompt defines the
 * verdict format, and the permission review settings own that request.
 */
export function forceMessagesSystemPrompt(
  payload: AnthropicMessagesPayload,
  requestedModel: unknown,
): RequestBehavior | undefined {
  const forced = resolveForcedSystemPrompt(requestedModel)
  if (!forced || isClaudePermissionReviewRequest(payload)) return undefined
  return forcedSystemPromptBehavior(
    applyForcedSystemPromptToMessages(payload, forced),
  )
}

export function forceResponsesSystemPrompt(
  payload: ResponsesPayload,
  requestedModel: unknown,
): RequestBehavior | undefined {
  const forced = resolveForcedSystemPrompt(requestedModel)
  if (!forced) return undefined
  return forcedSystemPromptBehavior(
    applyForcedSystemPromptToResponses(payload, forced),
  )
}

/**
 * A compaction request summarizes with the gateway's own instructions. The
 * forced prompt goes before them, and clearing removes only the client's
 * system and developer items from the history being summarized.
 */
export function forceCompactionSystemPrompt(options: {
  input: Array<ResponseInputItem>
  instructions: string
  requestedModel: unknown
}): {
  behavior?: RequestBehavior
  input: Array<ResponseInputItem>
  instructions: string
} {
  const forced = resolveForcedSystemPrompt(options.requestedModel)
  if (!forced) {
    return { input: options.input, instructions: options.instructions }
  }
  const input =
    forced.clearOtherSystemPrompts ?
      withoutInstructionItems(options.input)
    : options.input
  return {
    behavior: forcedSystemPromptBehavior({
      forced,
      removed: options.input.length - input.length,
    }),
    input,
    instructions: `${forced.prompt}\n\n${options.instructions}`,
  }
}
