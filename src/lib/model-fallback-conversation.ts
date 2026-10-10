import {
  getRoutingAffinity,
  normalizeRoutingAffinityKey,
  parseRoutingMetadataRecord,
  resolveResponsesMemoryRoutingAffinity,
  resolveRoutingAffinityFromHeaders,
} from "~/lib/routing-affinity"

export function getModelFallbackConversationIdentity(options: {
  headers?: Headers
  payload?: unknown
  conversationKey?: string
}): string | undefined {
  const payload = payloadRecord(options.payload)
  const client = parseRoutingMetadataRecord(payload.client_metadata) ?? {}
  const metadata = parseRoutingMetadataRecord(payload.metadata) ?? {}
  const claude = parseRoutingMetadataRecord(metadata.user_id) ?? {}
  const headers = options.headers
  const memory = memoryConversationIdentity(client, headers)
  if (memory) return memory
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

function payloadRecord(payload: unknown): Record<string, unknown> {
  return (
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ) ?
      (payload as Record<string, unknown>)
    : {}
}

function memoryConversationIdentity(
  clientMetadata: unknown,
  headers: Headers | undefined,
): string | undefined {
  const installedAffinity = getRoutingAffinity()
  if (installedAffinity?.memoryThreadKey) return installedAffinity.key
  return resolveResponsesMemoryRoutingAffinity(
    clientMetadata,
    resolveRoutingAffinityFromHeaders(headers ?? new Headers()),
  )?.key
}
