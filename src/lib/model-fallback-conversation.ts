import {
  normalizeRoutingAffinityKey,
  parseRoutingMetadataRecord,
} from "~/lib/routing-affinity"

export function getModelFallbackConversationIdentity(options: {
  headers?: Headers
  payload?: unknown
  conversationKey?: string
}): string | undefined {
  const payload =
    (
      options.payload !== null
      && typeof options.payload === "object"
      && !Array.isArray(options.payload)
    ) ?
      (options.payload as Record<string, unknown>)
    : {}
  const client = parseRoutingMetadataRecord(payload.client_metadata) ?? {}
  const metadata = parseRoutingMetadataRecord(payload.metadata) ?? {}
  const claude = parseRoutingMetadataRecord(metadata.user_id) ?? {}
  const headers = options.headers
  // Child threads may share account affinity with their parent; they must not
  // share model fallback or client retry evidence with their siblings.
  const identities = [
    client.thread_id,
    payload.thread_id,
    payload.threadId,
    headers?.get("thread-id"),
    headers?.get("x-thread-id"),
    metadata.thread_id,
    metadata.threadId,
    headers?.get("x-claude-code-session-id"),
    headers?.get("x-client-session-id"),
    headers?.get("session-id"),
    client.session_id,
    claude.session_id,
    payload.conversation_id,
    payload.conversationId,
    payload.session_id,
    payload.sessionId,
    metadata.conversation_id,
    metadata.conversationId,
    metadata.session_id,
    metadata.sessionId,
    typeof metadata.user_id === "string" ?
      metadata.user_id.match(/_session_(.+)$/u)?.[1]
    : undefined,
    options.conversationKey,
  ]
  for (const value of identities) {
    const normalized = normalizeRoutingAffinityKey(value)
    if (normalized) return normalized
  }
  return undefined
}
