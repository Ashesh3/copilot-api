import type { AnthropicMessagesPayload } from "./anthropic-types"

export function stripThinkingBlocks(
  payload: AnthropicMessagesPayload,
): boolean {
  let stripped = false
  for (const message of payload.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }
    const before = message.content.length
    message.content = message.content.filter(
      (block) => block.type !== "thinking",
    )
    if (message.content.length < before) stripped = true
  }
  return stripped
}

export async function isInvalidThinkingSignatureResponse(
  response: Response,
): Promise<boolean> {
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return false
  }
  if (!isRecord(body) || !isRecord(body.error)) return false
  const error = body.error
  const message = error.message
  return (
    typeof message === "string"
    && ((body.type === "error"
      && error.type === "invalid_request_error"
      && message === "Invalid signature in thinking block")
      || (error.code === "invalid_request_body"
        && message === "Invalid `signature` in thinking block"))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
