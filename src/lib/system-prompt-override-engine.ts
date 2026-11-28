import type {
  SystemPromptAppendPosition,
  SystemPromptOverride,
} from "~/lib/system-prompt-overrides"
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
  /** Insert at the start or end of the existing prompt, creating one if absent. */
  append: (prompt: string, at: PositionedWriter) => void
  /** Add a separate prompt before all existing prompts. */
  prepend: (prompt: string, write: TextWriter) => void
  replace: (rewrite: (text: string) => string) => void
}

interface TextWriter {
  add: (
    text: string,
    prompt: string,
    position?: SystemPromptAppendPosition,
  ) => string
  replace: (
    text: string,
    rule: Extract<SystemPromptOverride, { mode: "replace" }>,
  ) => string
}

/** Where a force append rule writes inside the existing prompt. */
interface PositionedWriter {
  position: SystemPromptAppendPosition
  write: TextWriter
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

/** Responses instruction text may arrive as either input or output text. */
function isMergeableTextType(edgeType: unknown, blockType: string): boolean {
  return (
    edgeType === blockType
    || (blockType === "input_text" && edgeType === "output_text")
  )
}

/**
 * Some translators join blocks with "", " ", or "\n" (and may turn non-text
 * blocks into text placeholders), so end text that lands in its own block
 * after other blocks starts with a blank line. Beginning keeps its output.
 */
function ownBlockPrompt(
  prompt: string,
  position: SystemPromptAppendPosition,
  precededByBlocks: boolean,
): string {
  return position === "end" && precededByBlocks ? `\n\n${prompt}` : prompt
}

function insertContent<Block extends object>(
  content: string | Array<Block> | null | undefined,
  block: Block & { type: string; text: string },
  { position, write }: PositionedWriter,
): string | Array<Block> {
  assertContent(content)
  if (!Array.isArray(content)) {
    return write.add(content ?? "", block.text, position)
  }
  const index = position === "end" ? content.length - 1 : 0
  const edge = content.at(index)
  if (
    edge
    && "type" in edge
    && isMergeableTextType(edge.type, block.type)
    && "text" in edge
    && typeof edge.text === "string"
  ) {
    const text =
      edge.text ?
        write.add(edge.text, block.text, position)
      : write.add("", ownBlockPrompt(block.text, position, content.length > 1))
    return content.map((item, itemIndex) =>
      itemIndex === index ? { ...edge, text } : item,
    )
  }
  const prompt = ownBlockPrompt(block.text, position, content.length > 0)
  const added = { ...block, text: write.add("", prompt) }
  return position === "end" ? [...content, added] : [added, ...content]
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
    add(text, prompt, position = "start") {
      accountGrowth(prompt.length + (text ? 2 : 0))
      if (!text) return prompt
      return position === "end" ?
          `${text}\n\n${prompt}`
        : `${prompt}\n\n${text}`
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
        result.removed += target.clear(write.add("", rule.prompt))
        break
      }
      case "append": {
        target.append(rule.prompt, {
          position: rule.position ?? "start",
          write,
        })
        break
      }
      case "prepend": {
        target.prepend(rule.prompt, write)
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
  const addSystemMessage = (prompt: string, write: TextWriter) => {
    payload.messages = [
      { role: "system", content: write.add("", prompt) },
      ...payload.messages,
    ]
  }
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
      append(prompt, at) {
        const existing =
          payload.messages.find((message) => message.role === "system")
          ?? payload.messages.find((message) => message.role === "developer")
        if (!existing) {
          addSystemMessage(prompt, at.write)
          return
        }
        const content = insertContent(
          existing.content,
          { type: "text", text: prompt },
          at,
        )
        payload.messages = payload.messages.map((message) =>
          message === existing ? { ...existing, content } : message,
        )
      },
      prepend: addSystemMessage,
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

function appendMessages(
  payload: AnthropicMessagesPayload,
  prompt: string,
  at: PositionedWriter,
): void {
  if (payload.system && payload.system.length > 0) {
    payload.system = insertContent(
      payload.system,
      { type: "text", text: prompt },
      at,
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
    payload.system = at.write.add("", prompt)
    return
  }
  const content = insertContent(
    existing.content,
    { type: "text", text: prompt },
    at,
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
      append(prompt, at) {
        appendMessages(payload, prompt, at)
      },
      prepend(prompt, write) {
        const system = payload.system
        const text = write.add("", prompt)
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

function appendResponses(
  payload: ResponsesPayload,
  prompt: string,
  at: PositionedWriter,
): void {
  const instructions =
    typeof payload.instructions === "string" ? payload.instructions : ""
  if (!instructions && Array.isArray(payload.input)) {
    const items = payload.input.filter((item) => isInstructionItem(item))
    const existing = items.find((item) => item.role === "system") ?? items.at(0)
    if (existing) {
      const content = insertContent(
        existing.content,
        { type: "input_text", text: prompt },
        at,
      )
      payload.input = payload.input.map((item) =>
        item === existing ? { ...existing, content } : item,
      )
      return
    }
  }
  payload.instructions = at.write.add(instructions, prompt, at.position)
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
      append(prompt, at) {
        appendResponses(payload, prompt, at)
      },
      prepend(prompt, write) {
        payload.instructions = write.add(payload.instructions ?? "", prompt)
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

/**
 * Gateway summary instructions follow everything the rules produce, so an end
 * position places text after the configured prompt but before them.
 */
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
      append(text, { position, write }) {
        prompt = write.add(prompt, text, position)
      },
      prepend(text, write) {
        prompt = write.add(prompt, text)
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
