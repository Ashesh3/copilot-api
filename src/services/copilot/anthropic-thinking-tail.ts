const UNFINISHED_REASONING = "[Unfinished assistant reasoning]"
const RESUME_RESPONSE = "Continue the interrupted assistant response."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isInstruction(message: Record<string, unknown>): boolean {
  return message.role === "system" || message.role === "developer"
}

function isThinkingBlock(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value)
    && ((value.type === "thinking" && typeof value.thinking === "string")
      || (value.type === "redacted_thinking" && typeof value.data === "string"))
  )
}

function trimReasoningSuffix(
  content: Array<unknown>,
  thoughts: Array<string>,
): number {
  let tail = content.length
  while (tail > 0 && isThinkingBlock(content[tail - 1])) {
    const block = content[tail - 1] as Record<string, unknown>
    if (typeof block.thinking === "string" && block.thinking.trim()) {
      thoughts.push(block.thinking)
    }
    tail -= 1
  }
  return tail
}

/** Historical thinking-only turns are valid; only trim unfinished terminal reasoning. */
export function normalizeAnthropicThinkingTail(
  body: Record<string, unknown>,
): boolean {
  if (!Array.isArray(body.messages)) return false
  const messages: Array<unknown> = body.messages
  const thoughts: Array<string> = []
  const emptyMessages = new Set<Record<string, unknown>>()
  let changed = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) break
    if (isInstruction(message)) continue
    if (message.role !== "assistant") break
    if (message.content === "") {
      emptyMessages.add(message)
      continue
    }
    if (!Array.isArray(message.content)) break
    const content: Array<unknown> = message.content
    const tail = trimReasoningSuffix(content, thoughts)
    if (tail < content.length) {
      message.content = content.slice(0, tail)
      changed = true
    }
    if (tail === 0) emptyMessages.add(message)
    if (tail > 0) break
  }
  if (!changed) return false
  const retained = messages.filter(
    (message) => !isRecord(message) || !emptyMessages.has(message),
  )
  const text = thoughts.reverse().join("\n\n")
  const last = retained.findLast(
    (message) => !isRecord(message) || !isInstruction(message),
  )
  if (text || (isRecord(last) && last.role === "assistant")) {
    retained.push({
      role: "user",
      content: [
        {
          type: "text",
          text: text ? `${UNFINISHED_REASONING}\n${text}` : RESUME_RESPONSE,
        },
      ],
    })
  }
  body.messages = retained
  return true
}
