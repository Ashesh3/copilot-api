import { AsyncLocalStorage } from "node:async_hooks"

const MAX_AFFINITY_KEY_LENGTH = 512

export type RoutingAffinitySource =
  | "claude_session"
  | "copilot_session"
  | "codex_session"
  | "claude_metadata"
  | "codex_metadata"
  | "codex_thread"

export interface RoutingAffinity {
  key: string
  source: RoutingAffinitySource
}

interface RoutingAffinityState {
  affinity?: RoutingAffinity
}

const routingAffinityStorage = new AsyncLocalStorage<RoutingAffinityState>()

export function normalizeRoutingAffinityKey(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_AFFINITY_KEY_LENGTH) {
    return undefined
  }
  return normalized
}

function affinity(
  value: unknown,
  source: RoutingAffinitySource,
): RoutingAffinity | undefined {
  const key = normalizeRoutingAffinityKey(value)
  return key ? { key, source } : undefined
}

export function resolveRoutingAffinityFromHeaders(
  headers: Headers,
): RoutingAffinity | undefined {
  return (
    affinity(headers.get("x-claude-code-session-id"), "claude_session")
    ?? affinity(headers.get("x-client-session-id"), "copilot_session")
    ?? affinity(headers.get("session-id"), "codex_session")
    ?? affinity(headers.get("thread-id"), "codex_thread")
  )
}

export function parseRoutingMetadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return undefined
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  return parsed as Record<string, unknown>
}

export function resolveClaudeRoutingAffinity(
  metadata: unknown,
): RoutingAffinity | undefined {
  const metadataRecord = parseRoutingMetadataRecord(metadata)
  if (!metadataRecord) return undefined
  const userMetadata = parseRoutingMetadataRecord(metadataRecord.user_id)
  return affinity(userMetadata?.session_id, "claude_metadata")
}

export function resolveResponsesRoutingAffinity(
  clientMetadata: unknown,
): RoutingAffinity | undefined {
  const metadata = parseRoutingMetadataRecord(clientMetadata)
  if (!metadata) return undefined
  return (
    affinity(metadata.session_id, "codex_metadata")
    ?? affinity(metadata.thread_id, "codex_thread")
  )
}

export function runWithRoutingAffinity<T>(
  initialAffinity: RoutingAffinity | undefined,
  callback: () => T,
): T {
  const state: RoutingAffinityState = {}
  if (initialAffinity) state.affinity = initialAffinity
  return routingAffinityStorage.run(state, callback)
}

export function getRoutingAffinity(): RoutingAffinity | undefined {
  return routingAffinityStorage.getStore()?.affinity
}

export function installRoutingAffinityFallback(
  fallback: RoutingAffinity | undefined,
): void {
  const state = routingAffinityStorage.getStore()
  if (!state || state.affinity || !fallback) return
  state.affinity = fallback
}
