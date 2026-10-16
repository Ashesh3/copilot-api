import type { SystemPromptOverride } from "~/lib/system-prompt-overrides"
import type {
  AnthropicCustomMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { createInvalidRequestError } from "~/lib/error"

interface OverrideResult {
  removed: number
  replacements: number
}

interface PromptTarget {
  clear: (prompt: string) => number
  prefix: (prompt: string, separate: boolean, write: TextWriter) => void
  replace: (rewrite: (text: string) => string) => void
}

interface TextWriter {
  prefix: (text: string, prompt: string) => string
  replace: (
    text: string,
    rule: Extract<SystemPromptOverride, { mode: "replace" }>,
  ) => string
}

const isInstructionRole = (role: unknown): boolean =>
  role === "system" || role === "developer"

function isMessagesInstruction(
  message: AnthropicMessage,
): message is AnthropicCustomMessage {
  return isInstructionRole(message.role)
}

function isInstructionItem(
  item: ResponseInputItem,
): item is ResponseInputMessage {
  return (
    (item.type === undefined || item.type === "message")
    && isInstructionRole(item.role)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertContent(content: unknown): void {
  if (content === undefined || content === null || typeof content === "string")
    return
  if (
    Array.isArray(content)
    && content.every((block: unknown) => isRecord(block))
  )
    return
  throw createInvalidRequestError(
    "System prompt content must be text or an array of content blocks.",
    "systemPromptOverrides",
  )
}

/** Transform text only; retain block metadata, role controls, and other data. */
function mapContent<Content>(
  content: Content,
  rewrite: (text: string) => string,
): Content {
  assertContent(content)
  if (typeof content === "string") return rewrite(content) as Content
  if (!Array.isArray(content)) return content
  return content.map((block: Record<string, unknown>) => {
    const isText =
      block.type === "text"
      || block.type === "input_text"
      || block.type === "output_text"
    return isText && typeof block.text === "string" ?
        { ...block, text: rewrite(block.text) }
      : block
  }) as Content
}

function prefixContent<Block extends object>(
  content: string | Array<Block> | null | undefined,
  prefix: Block & { type: string; text: string },
  write: TextWriter,
): string | Array<Block> {
  assertContent(content)
  if (!Array.isArray(content)) return write.prefix(content ?? "", prefix.text)
  const first = content.at(0)
  if (
    first
    && "type" in first
    && first.type === prefix.type
    && "text" in first
    && typeof first.text === "string"
  ) {
    return [
      { ...first, text: write.prefix(first.text, prefix.text) },
      ...content.slice(1),
    ]
  }
  return [{ ...prefix, text: write.prefix("", prefix.text) }, ...content]
}

/** Limit cumulative expansion before replacement strings are allocated. */
function textWriter(result: OverrideResult): TextWriter {
  let remainingGrowth = 2_000_000
  const accountGrowth = (growth: number) => {
    remainingGrowth -= Math.max(0, growth)
    if (remainingGrowth < 0) {
      throw createInvalidRequestError(
        "System prompt overrides expand the request by more than 2,000,000 characters.",
        "systemPromptOverrides",
      )
    }
  }
  return {
    prefix(text, prompt) {
      accountGrowth(prompt.length + (text ? 2 : 0))
      return text ? `${prompt}\n\n${text}` : prompt
    },
    replace(text, rule) {
      let matches = 0
      let position = text.indexOf(rule.find)
      while (position !== -1) {
        matches++
        position = text.indexOf(rule.find, position + rule.find.length)
      }
      if (!matches) return text
      accountGrowth(matches * (rule.replacement.length - rule.find.length))
      result.replacements += matches
      // A function keeps $&, $', and other replacement tokens literal.
      return text.replaceAll(rule.find, () => rule.replacement)
    },
  }
}

function runOverrides(
  target: PromptTarget,
  rules: Array<SystemPromptOverride>,
): OverrideResult {
  const result = { removed: 0, replacements: 0 }
  const write = textWriter(result)
  for (const rule of rules) {
    switch (rule.mode) {
      case "clear": {
        result.removed += target.clear(write.prefix("", rule.prompt))
        break
      }
      case "append":
      case "prepend": {
        target.prefix(rule.prompt, rule.mode === "prepend", write)
        break
      }
      case "replace": {
        target.replace((text) => write.replace(text, rule))
        break
      }
      default: {
        throw createInvalidRequestError(
          "Unknown system prompt override mode.",
          "systemPromptOverrides",
        )
      }
    }
  }
  return result
}

export function applyChatPromptOverrides(
  payload: { messages: Array<Message> },
  rules: Array<SystemPromptOverride>,
): OverrideResult {
  return runOverrides(
    {
      clear(prompt) {
        const original = payload.messages.length
        payload.messages = payload.messages.filter(
          (message) => !isInstructionRole(message.role),
        )
        const removed = original - payload.messages.length
        if (prompt)
          payload.messages.unshift({ role: "system", content: prompt })
        return removed
      },
      prefix(prompt, separate, write) {
        const existing =
          payload.messages.find((message) => message.role === "system")
          ?? payload.messages.find((message) => message.role === "developer")
        if (separate || !existing) {
          payload.messages = [
            { role: "system", content: write.prefix("", prompt) },
            ...payload.messages,
          ]
          return
        }
        const content = prefixContent(
          existing.content,
          { type: "text", text: prompt },
          write,
        )
        payload.messages = payload.messages.map((message) =>
          message === existing ? { ...existing, content } : message,
        )
      },
      replace(rewrite) {
        payload.messages = payload.messages.map((message) =>
          isInstructionRole(message.role) ?
            { ...message, content: mapContent(message.content, rewrite) }
          : message,
        )
      },
    },
    rules,
  )
}

function prefixMessages(
  payload: AnthropicMessagesPayload,
  prompt: string,
  write: TextWriter,
): void {
  if (payload.system && payload.system.length > 0) {
    payload.system = prefixContent(
      payload.system,
      { type: "text", text: prompt },
      write,
    )
    return
  }
  const instructions = payload.messages.filter(
    (message): message is AnthropicCustomMessage =>
      isInstructionRole(message.role),
  )
  const existing =
    instructions.find((message) => message.role === "system")
    ?? instructions.at(0)
  if (!existing) {
    payload.system = write.prefix("", prompt)
    return
  }
  const content = prefixContent(
    existing.content,
    { type: "text", text: prompt },
    write,
  )
  payload.messages = payload.messages.map((message) =>
    message === existing ? { ...existing, content } : message,
  )
}

export function applyMessagesPromptOverrides(
  payload: AnthropicMessagesPayload,
  rules: Array<SystemPromptOverride>,
): OverrideResult {
  const result = runOverrides(
    {
      clear(prompt) {
        const original = payload.messages.length
        const systemCount =
          Array.isArray(payload.system) ?
            payload.system.length
          : Number(Boolean(payload.system))
        payload.messages = payload.messages.filter(
          (message) => !isInstructionRole(message.role),
        )
        if (prompt) payload.system = prompt
        else delete payload.system
        return original - payload.messages.length + systemCount
      },
      prefix(prompt, separate, write) {
        if (!separate) {
          prefixMessages(payload, prompt, write)
          return
        }
        const system = payload.system
        const text = write.prefix("", prompt)
        payload.system =
          !system || system.length === 0 ?
            text
          : [
              { type: "text", text },
              ...(typeof system === "string" ?
                [{ type: "text" as const, text: system }]
              : system),
            ]
      },
      replace(rewrite) {
        if (payload.system !== undefined)
          payload.system = mapContent(payload.system, rewrite)
        payload.messages = payload.messages.map((message) =>
          isMessagesInstruction(message) ?
            { ...message, content: mapContent(message.content, rewrite) }
          : message,
        )
      },
    },
    rules,
  )
  // A later append may refill an emptied block, so clean up only after all rules.
  if (Array.isArray(payload.system)) {
    const system = payload.system.filter(
      (block) => block.type !== "text" || block.text !== "",
    )
    if (system.length > 0) payload.system = system
    else delete payload.system
  }
  payload.messages = payload.messages.flatMap<AnthropicMessage>((message) => {
    if (!isMessagesInstruction(message)) return [message]
    const content =
      Array.isArray(message.content) ?
        message.content.filter(
          (block) => block.type !== "text" || block.text !== "",
        )
      : message.content
    return content.length > 0 ? [{ ...message, content }] : []
  })
  return result
}

function replaceResponsesInput(
  payload: ResponsesPayload,
  rewrite: (text: string) => string,
): void {
  if (!Array.isArray(payload.input)) return
  payload.input = payload.input.map((item) =>
    isInstructionItem(item) ?
      { ...item, content: mapContent(item.content, rewrite) }
    : item,
  )
}

function prefixResponses(
  payload: ResponsesPayload,
  prompt: string,
  write: TextWriter,
): void {
  const instructions =
    typeof payload.instructions === "string" ? payload.instructions : ""
  if (!instructions && Array.isArray(payload.input)) {
    const items = payload.input.filter((item) => isInstructionItem(item))
    const existing = items.find((item) => item.role === "system") ?? items.at(0)
    if (existing) {
      const content = prefixContent(
        existing.content,
        { type: "input_text", text: prompt },
        write,
      )
      payload.input = payload.input.map((item) =>
        item === existing ? { ...existing, content } : item,
      )
      return
    }
  }
  payload.instructions = write.prefix(instructions, prompt)
}

function clearResponsesInput(payload: ResponsesPayload): number {
  if (!Array.isArray(payload.input)) return 0
  const original = payload.input.length
  payload.input = payload.input.filter((item) => !isInstructionItem(item))
  return original - payload.input.length
}

export function applyResponsesPromptOverrides(
  payload: ResponsesPayload,
  rules: Array<SystemPromptOverride>,
): OverrideResult {
  return runOverrides(
    {
      clear(prompt) {
        const removed =
          clearResponsesInput(payload) + Number(Boolean(payload.instructions))
        if (prompt) payload.instructions = prompt
        else delete payload.instructions
        return removed
      },
      prefix(prompt, separate, write) {
        if (separate)
          payload.instructions = write.prefix(
            payload.instructions ?? "",
            prompt,
          )
        else prefixResponses(payload, prompt, write)
      },
      replace(rewrite) {
        if (typeof payload.instructions === "string")
          payload.instructions = rewrite(payload.instructions)
        replaceResponsesInput(payload, rewrite)
      },
    },
    rules,
  )
}

/** Gateway summary instructions are appended after all user-configured rules. */
export function applyCompactionPromptOverrides(
  input: Array<ResponseInputItem>,
  rules: Array<SystemPromptOverride>,
): { input: Array<ResponseInputItem>; prompt: string; result: OverrideResult } {
  const payload: ResponsesPayload = { model: "", input }
  let prompt = ""
  const result = runOverrides(
    {
      clear(text) {
        const removed = clearResponsesInput(payload) + Number(Boolean(prompt))
        prompt = text
        return removed
      },
      prefix(text, _separate, write) {
        prompt = write.prefix(prompt, text)
      },
      replace(rewrite) {
        prompt = rewrite(prompt)
        replaceResponsesInput(payload, rewrite)
      },
    },
    rules,
  )
  return { input: payload.input as Array<ResponseInputItem>, prompt, result }
}
