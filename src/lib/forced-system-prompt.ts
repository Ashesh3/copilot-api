import type { RequestBehavior } from "~/lib/request-logger"
import type { SystemPromptOverride } from "~/lib/system-prompt-overrides"
import type {
  AnthropicCustomMessage,
  AnthropicMessagesPayload,
  AnthropicSystemContentBlock,
} from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { createInvalidRequestError } from "~/lib/error"
import { normalizeModelName } from "~/lib/model-resolver"
import { getModelSettings } from "~/lib/model-settings"
import { parseModelSuffix } from "~/lib/model-suffix"
import { isClaudePermissionReviewRequest } from "~/lib/permission-review"
import {
  applyChatPromptOverrides,
  applyCompactionPromptOverrides,
  applyMessagesPromptOverrides,
  applyResponsesPromptOverrides,
} from "~/lib/system-prompt-override-engine"

/** A model's forced system prompt, found from the model a client requested. */
export interface ForcedSystemPrompt {
  /** The model settings entry that supplied the prompt. */
  model: string
  prompt: string
  /** Remove the client's own system and developer prompts. */
  clearOtherSystemPrompts: boolean
  forceAppendSystemPrompt: boolean
  /** Ordered rules supersede the legacy single-prompt fields when present. */
  overrides?: Array<SystemPromptOverride>
}

interface ForcedSystemPromptOutcome {
  forced: ForcedSystemPrompt
  /** Client system or developer prompts removed from the request. */
  removed: number
  replacements?: number
}

const isInstructionRole = (role: unknown): boolean =>
  role === "system" || role === "developer"

/** A Responses input message that carries system or developer instructions. */
function isResponsesInstructionItem(
  item: unknown,
): item is ResponseInputMessage {
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
    if (settings?.systemPromptOverrides?.length) {
      return {
        model,
        prompt: "",
        clearOtherSystemPrompts: false,
        forceAppendSystemPrompt: false,
        overrides: settings.systemPromptOverrides,
      }
    }
    if (settings?.forcedSystemPrompt) {
      return {
        model,
        prompt: settings.forcedSystemPrompt,
        clearOtherSystemPrompts: settings.clearOtherSystemPrompts === true,
        forceAppendSystemPrompt: settings.forceAppendSystemPrompt === true,
      }
    }
  }
  return undefined
}

function prependPromptText(text: string, prompt: string): string {
  if (text === prompt || text.startsWith(`${prompt}\n\n`)) return text
  return text ? `${prompt}\n\n${text}` : prompt
}

function assertPromptContent(
  content: unknown,
  param: string,
): asserts content is string | Array<object> | null | undefined {
  if (content === undefined || content === null || typeof content === "string")
    return
  if (
    Array.isArray(content)
    && content.every(
      (block: unknown) =>
        typeof block === "object" && block !== null && !Array.isArray(block),
    )
  )
    return
  throw createInvalidRequestError(
    "System prompt content must be text or an array of content blocks.",
    param,
  )
}

/** Keep the first text block's metadata and all later blocks intact. */
function prependTextBlock<Block extends object>(
  blocks: Array<Block>,
  prefix: Block & { type: string; text: string },
): Array<Block> {
  const first = blocks.at(0)
  if (
    first
    && "type" in first
    && first.type === prefix.type
    && "text" in first
    && typeof first.text === "string"
  ) {
    return [
      { ...first, text: prependPromptText(first.text, prefix.text) },
      ...blocks.slice(1),
    ]
  }
  return [prefix, ...blocks]
}

function appendToChatSystemPrompt(
  payload: { messages: Array<Message> },
  prompt: string,
): boolean {
  const existing =
    payload.messages.find((message) => message.role === "system")
    ?? payload.messages.find((message) => message.role === "developer")
  if (!existing) return false
  const content =
    Array.isArray(existing.content) ?
      prependTextBlock(existing.content, { type: "text", text: prompt })
    : prependPromptText(existing.content ?? "", prompt)
  payload.messages = payload.messages.map((message) =>
    message === existing ? { ...existing, content } : message,
  )
  return true
}

/** Put the prompt first, optionally within the client's existing message. */
function applyForcedSystemPromptToChat(
  payload: { messages: Array<Message> },
  forced: ForcedSystemPrompt,
): ForcedSystemPromptOutcome {
  if (forced.overrides) {
    return { forced, ...applyChatPromptOverrides(payload, forced.overrides) }
  }
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
  if (
    forced.forceAppendSystemPrompt
    && !forced.clearOtherSystemPrompts
    && appendToChatSystemPrompt(payload, forced.prompt)
  ) {
    return { forced, removed }
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

function appendToMessagesSystemPrompt(
  system: AnthropicMessagesPayload["system"],
  prompt: string,
): AnthropicMessagesPayload["system"] {
  if (system === undefined || typeof system === "string") {
    return prependPromptText(system ?? "", prompt)
  }
  return prependTextBlock(system, { type: "text", text: prompt })
}

function appendToMessagesInstructionTurn(
  payload: AnthropicMessagesPayload,
  prompt: string,
): boolean {
  const instructions = payload.messages.filter(
    (message): message is AnthropicCustomMessage =>
      isInstructionRole(message.role),
  )
  const existing =
    instructions.find((message) => message.role === "system")
    ?? instructions.at(0)
  if (!existing) return false
  assertPromptContent(existing.content, "messages")
  const content =
    Array.isArray(existing.content) ?
      prependTextBlock(existing.content, { type: "text", text: prompt })
    : prependPromptText(existing.content, prompt)
  payload.messages = payload.messages.map((message) =>
    message === existing ? { ...existing, content } : message,
  )
  return true
}

/**
 * Put the forced prompt first in the Messages `system` field. Clearing also
 * removes system and developer turns that Claude clients send in `messages`;
 * the request contract has already lifted their per-turn controls.
 */
function applyForcedSystemPromptToMessages(
  payload: AnthropicMessagesPayload,
  forced: ForcedSystemPrompt,
): ForcedSystemPromptOutcome {
  if (forced.overrides) {
    return {
      forced,
      ...applyMessagesPromptOverrides(payload, forced.overrides),
    }
  }
  if (!forced.clearOtherSystemPrompts) {
    if (
      forced.forceAppendSystemPrompt
      && (!payload.system || payload.system.length === 0)
      && appendToMessagesInstructionTurn(payload, forced.prompt)
    ) {
      return { forced, removed: 0 }
    }
    payload.system =
      forced.forceAppendSystemPrompt ?
        appendToMessagesSystemPrompt(payload.system, forced.prompt)
      : prependSystemBlock(payload.system, forced.prompt)
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

function appendToResponsesInput(
  payload: ResponsesPayload,
  prompt: string,
): boolean {
  if (!Array.isArray(payload.input)) return false
  const instructions = payload.input.filter((item) =>
    isResponsesInstructionItem(item),
  )
  const existing =
    instructions.find((item) => item.role === "system") ?? instructions.at(0)
  if (!existing) return false
  assertPromptContent(existing.content, "input")
  const content =
    Array.isArray(existing.content) ?
      prependTextBlock(existing.content, { type: "input_text", text: prompt })
    : prependPromptText(existing.content ?? "", prompt)
  payload.input = payload.input.map((item) =>
    item === existing ? { ...existing, content } : item,
  )
  return true
}

/**
 * Prefix Responses `instructions`, or the first instruction input message
 * when force append is enabled and no top-level instructions exist.
 */
export function applyForcedSystemPromptToResponses(
  payload: ResponsesPayload,
  forced: ForcedSystemPrompt,
): ForcedSystemPromptOutcome {
  if (forced.overrides) {
    return {
      forced,
      ...applyResponsesPromptOverrides(payload, forced.overrides),
    }
  }
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
  if (
    forced.forceAppendSystemPrompt
    && !instructions
    && appendToResponsesInput(payload, forced.prompt)
  ) {
    return { forced, removed: 0 }
  }
  payload.instructions = prependPromptText(instructions, forced.prompt)
  return { forced, removed: 0 }
}

/** Request-log entry for an applied forced system prompt. */
export function forcedSystemPromptBehavior(
  outcome: ForcedSystemPromptOutcome,
): RequestBehavior {
  const { forced, removed } = outcome
  if (forced.overrides) {
    return {
      kind: "forced_system_prompt",
      message: `Applied ${forced.overrides.length} system prompt override rules for ${forced.model} in order`,
      data: {
        model: forced.model,
        modes: forced.overrides.map((rule) => rule.mode).join(", "),
        removedSystemPrompts: removed,
        replacements: outcome.replacements ?? 0,
      },
    }
  }
  const plural = removed === 1 ? "" : "s"
  let message = `Sent the forced system prompt from the ${forced.model} model setting before the client's system prompts`
  if (forced.clearOtherSystemPrompts) {
    message = `Sent the forced system prompt from the ${forced.model} model setting and removed ${removed} other system prompt${plural}`
  } else if (forced.forceAppendSystemPrompt) {
    message = `Sent the forced system prompt from the ${forced.model} model setting with force append`
  }
  return {
    kind: "forced_system_prompt",
    message,
    data: {
      model: forced.model,
      clearOtherSystemPrompts: forced.clearOtherSystemPrompts,
      forceAppendSystemPrompt: forced.forceAppendSystemPrompt,
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
  if (forced.overrides) {
    const output = applyCompactionPromptOverrides(
      options.input,
      forced.overrides,
    )
    return {
      behavior: forcedSystemPromptBehavior({ forced, ...output.result }),
      input: output.input,
      instructions:
        output.prompt ?
          `${output.prompt}\n\n${options.instructions}`
        : options.instructions,
    }
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
