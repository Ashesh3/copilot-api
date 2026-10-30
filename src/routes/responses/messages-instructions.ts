import type {
  AnthropicMessage,
  AnthropicTextBlock,
} from "~/routes/messages/anthropic-types"

import { isAnthropicUserMessage } from "../messages/anthropic-types"

function systemReminder(text: string): AnthropicTextBlock {
  return {
    type: "text",
    text: `<system-reminder>\n${text}\n</system-reminder>`,
  }
}

/** An assistant turn whose tool calls still wait for their results. */
function awaitsToolResults(message: AnthropicMessage | undefined): boolean {
  return (
    message?.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_use")
  )
}

/** A developer or system message, which the bridge treats as instructions. */
export function isResponsesInstruction(item: {
  role?: unknown
  type?: unknown
}): boolean {
  return (
    (item.type === undefined || item.type === "message")
    && (item.role === "system" || item.role === "developer")
  )
}

/**
 * Codex adds developer messages mid-thread when permissions, the sandbox,
 * the model or the collaboration mode change. Hoisting them into `system`
 * changes the cached prefix at every change, and Messages may drop earlier
 * thinking bound to that prefix. Once the model has answered, an instruction
 * therefore stays at its position as user-turn text in a `<system-reminder>`,
 * the way Claude Code delivers mid-conversation instructions. Instructions
 * before the first answer remain the system prompt.
 */
export class MidThreadInstructions {
  private readonly messages: Array<AnthropicMessage>
  private readonly pending: Array<string> = []

  constructor(messages: Array<AnthropicMessage>) {
    this.messages = messages
  }

  /** Whether the model has answered, so an instruction belongs in place. */
  answered(): boolean {
    return this.messages.some((message) => message.role === "assistant")
  }

  add(text: string): void {
    this.pending.push(text)
  }

  /**
   * Place pending instructions before an item, unless it is a tool result,
   * since results must open the user turn that answers the calls, or another
   * instruction, which joins the pending ones.
   */
  settleBefore(item: { role?: unknown; type?: unknown }): void {
    if (item.type === "function_call_output" || isResponsesInstruction(item)) {
      return
    }
    this.flush()
  }

  /**
   * Tool results must directly follow the turn that made the calls, so
   * instructions wait while that turn is last, including through further
   * parallel calls. At the end of the input they are placed regardless.
   */
  flush(options: { final?: boolean } = {}): void {
    if (!options.final && awaitsToolResults(this.messages.at(-1))) return
    for (const text of this.pending.splice(0)) {
      const previous = this.messages.at(-1)
      if (
        previous
        && isAnthropicUserMessage(previous)
        && Array.isArray(previous.content)
      ) {
        previous.content.push(systemReminder(text))
      } else {
        this.messages.push({ role: "user", content: [systemReminder(text)] })
      }
    }
  }
}
