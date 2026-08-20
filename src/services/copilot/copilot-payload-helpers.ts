interface ContentPart {
  type: string
}

interface CacheableMessage {
  role: string
  content?: string | Array<unknown> | null
  tool_calls?: Array<unknown>
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null
}

export function hasVisionContent(
  messages: ReadonlyArray<{
    content?: string | ReadonlyArray<ContentPart> | null
  }>,
): boolean {
  const attachmentTypes = new Set([
    "image_url",
    "image",
    "input_image",
    "file",
    "input_file",
    "document",
  ])

  return messages.some(
    (message) =>
      Array.isArray(message.content)
      && (message.content as ReadonlyArray<ContentPart>).some((part) =>
        attachmentTypes.has(part.type),
      ),
  )
}

export function detectInitiator(
  messages: ReadonlyArray<{ role: string }>,
  override?: "agent" | "user",
): "agent" | "user" {
  if (override) return override

  const lastMessage = messages.at(-1)
  return lastMessage?.role === "assistant" || lastMessage?.role === "tool" ?
      "agent"
    : "user"
}

export function addPromptCaching(
  messages: Array<CacheableMessage>,
  tools?: Array<object>,
): void {
  const lastSystemMessage = messages.findLast(
    (message) => message.role === "system",
  )
  if (lastSystemMessage) setCacheControl(lastSystemMessage)

  const lastNonUserMessage = messages.findLast(
    (message) => message.role !== "user" && !isReasoningOnlyMessage(message),
  )
  if (lastNonUserMessage) setCacheControl(lastNonUserMessage)

  const lastTool = tools?.at(-1)
  if (lastTool) setCacheControl(lastTool)
}

function setCacheControl(value: object): void {
  ;(value as Record<string, unknown>).copilot_cache_control = {
    type: "ephemeral",
  }
}

function isReasoningOnlyMessage(message: CacheableMessage): boolean {
  if (message.role !== "assistant") return false

  const hasReasoning = Boolean(
    message.reasoning_text
      || message.reasoning_opaque
      || message.encrypted_content,
  )
  if (!hasReasoning) return false

  const hasContent =
    typeof message.content === "string" ?
      message.content.trim().length > 0
    : Array.isArray(message.content) && message.content.length > 0
  const hasToolCalls =
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0

  return !hasContent && !hasToolCalls
}
