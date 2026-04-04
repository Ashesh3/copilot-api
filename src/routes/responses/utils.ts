import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

/**
 * Expand proxy-generated compaction compatibility items back into regular messages.
 * Native Codex compaction items should be preserved as-is; only the proxy's own
 * synthetic "cmp_" items use base64 summaries that upstream cannot decrypt.
 */
export const expandCompactionItems = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.input)) return

  payload.input = payload.input.map((item) => {
    const record = item as Record<string, unknown>
    if (
      record.type !== "compaction"
      || typeof record.encrypted_content !== "string"
      || typeof record.id !== "string"
      || !record.id.startsWith("cmp_")
    ) {
      return item
    }

    let summary: string
    try {
      summary = Buffer.from(record.encrypted_content, "base64").toString("utf8")
    } catch {
      summary = record.encrypted_content
    }

    return {
      type: "message",
      role: "assistant",
      content: `[Previous conversation summary]\n${summary}`,
    } as ResponseInputItem
  })
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  // Refactor `isAgentCall` logic to check only the last message in the history rather than any message. This prevents valid user messages from being incorrectly flagged as agent calls due to previous assistant history, ensuring proper credit consumption for multi-turn conversations.
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) {
    return false
  }
  if (!("role" in lastItem) || !lastItem.role) {
    return true
  }
  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}
