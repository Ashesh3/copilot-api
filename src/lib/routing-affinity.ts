import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import { isDroidRequest } from "~/lib/droid-client"

const MAX_AFFINITY_KEY_LENGTH = 512
const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata"

export type RoutingAffinitySource =
  | "claude_session"
  | "copilot_session"
  | "codex_session"
  | "claude_metadata"
  | "codex_metadata"
  | "codex_thread"
  | "droid_session"

export interface RoutingAffinity {
  key: string
  source: RoutingAffinitySource
  /**
   * The requesting Codex thread when `key` belongs to its agent tree's session
   * or its fork parent. Account routing records this thread's own assignment,
   * starting from the inherited account when that account serves the model.
   */
  threadKey?: string
  /** A fork's agent-tree session, consulted after its fork parent. */
  sessionKey?: string
  /** Independent background memory work for this requesting Codex thread. */
  memoryThreadKey?: string
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

/** Attach the Codex thread and session identities that differ from `key`. */
function withCodexThread(
  inherited: RoutingAffinity,
  identities: { session?: unknown; thread?: unknown },
): RoutingAffinity {
  const threadKey = normalizeRoutingAffinityKey(identities.thread)
  const sessionKey = normalizeRoutingAffinityKey(identities.session)
  const result: RoutingAffinity = { ...inherited }
  if (threadKey && threadKey !== inherited.key) result.threadKey = threadKey
  if (
    sessionKey
    && sessionKey !== inherited.key
    && sessionKey !== result.threadKey
  )
    result.sessionKey = sessionKey
  return result
}

/**
 * Codex sends its agent tree's root thread as the session and the requesting
 * thread separately, so subagents share the session's account by default.
 */
function codexSessionAffinity(
  session: unknown,
  thread: unknown,
  source: "codex_metadata" | "codex_session",
): RoutingAffinity | undefined {
  const inherited = affinity(session, source)
  return inherited && withCodexThread(inherited, { thread })
}

export function resolveRoutingAffinityFromHeaders(
  headers: Headers,
): RoutingAffinity | undefined {
  return (
    affinity(headers.get("x-claude-code-session-id"), "claude_session")
    ?? affinity(headers.get("x-client-session-id"), "copilot_session")
    ?? codexSessionAffinity(
      headers.get("session-id"),
      headers.get("thread-id"),
      "codex_session",
    )
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

/**
 * Droid sends no session header or client metadata. Its Responses
 * `prompt_cache_key` is its session's cache identity: the session ID, which
 * the app's forks, rewinds and side chats of that session keep. Other clients
 * may share one cache key across conversations, so only Droid's names a
 * session.
 */
export function resolveDroidRoutingAffinity(
  headers: Headers,
  promptCacheKey: unknown,
): RoutingAffinity | undefined {
  return isDroidRequest(headers) ?
      affinity(promptCacheKey, "droid_session")
    : undefined
}

/** JSON with sorted keys and without cache breakpoints, which Droid moves. */
function canonicalPrefix(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalPrefix(item))
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (key !== "cache_control") canonical[key] = canonicalPrefix(record[key])
  }
  return canonical
}

/** Text content as a block list, the form Droid uses with breakpoints. */
function contentBlocks(content: unknown): unknown {
  return typeof content === "string" ?
      [{ type: "text", text: content }]
    : content
}

function isRoutingRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The user messages before the first assistant message. */
function firstUserTurn(messages: unknown): Array<unknown> | undefined {
  if (!Array.isArray(messages)) return undefined
  const turn: Array<unknown> = []
  for (const message of messages) {
    if (!isRoutingRecord(message) || message.role !== "user") break
    turn.push(contentBlocks(message.content))
  }
  return turn.length > 0 ? turn : undefined
}

/**
 * Droid's Messages requests carry no session identity, unlike its Responses
 * requests. Every request of a session repeats the prefix Droid pins with
 * cache breakpoints: the system prompt and the first user turn, which holds
 * the session's start-up context and first prompt. A digest of that prefix,
 * with the model family, names the session without retaining its content.
 * Forks and side chats share it; a compaction rewrites it and so starts a
 * new identity.
 */
export function resolveDroidMessagesRoutingAffinity(
  headers: Headers,
  payload: { model?: unknown; system?: unknown; messages?: unknown },
): RoutingAffinity | undefined {
  if (!isDroidRequest(headers)) return undefined
  const turn = firstUserTurn(payload.messages)
  if (!turn) return undefined
  const family =
    typeof payload.model === "string" ?
      (/^[a-z]+/iu.exec(payload.model.trim())?.[0].toLowerCase() ?? "")
    : ""
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalPrefix([
          "copilot-api/droid-messages/v1",
          family,
          contentBlocks(payload.system ?? []),
          turn,
        ]),
      ),
    )
    .digest("hex")
  return { key: `droid-messages:${digest}`, source: "droid_session" }
}

export function resolveResponsesRoutingAffinity(
  clientMetadata: unknown,
): RoutingAffinity | undefined {
  const memoryAffinity = resolveResponsesMemoryRoutingAffinity(clientMetadata)
  if (memoryAffinity) return memoryAffinity
  const forkAffinity = resolveResponsesForkRoutingAffinity(clientMetadata)
  if (forkAffinity) return forkAffinity

  const metadata = parseRoutingMetadataRecord(clientMetadata)
  if (!metadata) return undefined
  return (
    codexSessionAffinity(
      metadata.session_id,
      metadata.thread_id,
      "codex_metadata",
    ) ?? affinity(metadata.thread_id, "codex_thread")
  )
}

/** Memory consolidation reuses the chat's IDs but has its own upstream history. */
export function resolveResponsesMemoryRoutingAffinity(
  clientMetadata: unknown,
  currentAffinity?: RoutingAffinity,
): RoutingAffinity | undefined {
  const metadata = parseRoutingMetadataRecord(clientMetadata)
  if (!metadata) return undefined
  const turn = parseRoutingMetadataRecord(metadata[CODEX_TURN_METADATA_KEY])
  if (turn?.request_kind !== "memory") return undefined
  const sessionId = normalizeRoutingAffinityKey(metadata.session_id)
  const threadId = normalizeRoutingAffinityKey(metadata.thread_id)
  if (
    currentAffinity
    && !describesMemoryThread(currentAffinity, sessionId, threadId)
  )
    return undefined
  const thread = memoryRequestingThread(currentAffinity, threadId, sessionId)
  if (!thread) return undefined
  const digest = createHash("sha256")
    .update(JSON.stringify(["copilot-api/codex-memory/v1", thread]))
    .digest("hex")
  return {
    key: `codex-memory:${digest}`,
    source: currentAffinity?.source ?? "codex_metadata",
    memoryThreadKey: thread,
  }
}

function memoryRequestingThread(
  current: RoutingAffinity | undefined,
  threadId: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  return (
    current?.memoryThreadKey
    ?? current?.threadKey
    ?? threadId
    ?? current?.key
    ?? sessionId
  )
}

function describesMemoryThread(
  current: RoutingAffinity,
  sessionId: string | undefined,
  threadId: string | undefined,
): boolean {
  if (
    current.source !== "codex_session"
    && current.source !== "codex_thread"
    && current.source !== "codex_metadata"
  )
    return false
  if (current.memoryThreadKey)
    return current.memoryThreadKey === (threadId ?? sessionId)
  if (current.threadKey)
    return threadId ?
        current.threadKey === threadId
      : current.key === sessionId || current.sessionKey === sessionId
  return current.key === sessionId || current.key === threadId
}

/**
 * Whether body metadata describes the same Codex conversation as the header
 * affinity: a Codex identity matching its session or thread, and no other
 * thread than the one the header already named.
 */
function describesCurrentThread(
  current: RoutingAffinity,
  sessionId: string | undefined,
  threadId: string | undefined,
): boolean {
  if (current.source !== "codex_session" && current.source !== "codex_thread")
    return false
  if (current.key !== sessionId && current.key !== threadId) return false
  return !current.threadKey || !threadId || current.threadKey === threadId
}

export function resolveResponsesForkRoutingAffinity(
  clientMetadata: unknown,
  currentAffinity?: RoutingAffinity,
): RoutingAffinity | undefined {
  const metadata = parseRoutingMetadataRecord(clientMetadata)
  if (!metadata) return undefined
  const turnMetadata = parseRoutingMetadataRecord(
    metadata[CODEX_TURN_METADATA_KEY],
  )
  const forkAffinity = affinity(
    turnMetadata?.forked_from_thread_id,
    "codex_thread",
  )
  if (!forkAffinity) return undefined
  const sessionId = normalizeRoutingAffinityKey(metadata.session_id)
  const threadId = normalizeRoutingAffinityKey(metadata.thread_id)
  if (
    currentAffinity
    && !describesCurrentThread(currentAffinity, sessionId, threadId)
  )
    return undefined
  return withCodexThread(forkAffinity, {
    session: sessionId,
    // A header thread outranks the session, which names the agent tree's root.
    thread: threadId ?? currentAffinity?.threadKey ?? sessionId,
  })
}

/** Add a body-only Codex thread to a header session that omitted it. */
function withMetadataThread(
  current: RoutingAffinity,
  clientMetadata: unknown,
): RoutingAffinity {
  if (current.source !== "codex_session" || current.threadKey) return current
  const metadata = parseRoutingMetadataRecord(clientMetadata)
  if (normalizeRoutingAffinityKey(metadata?.session_id) !== current.key)
    return current
  return withCodexThread(current, { thread: metadata?.thread_id })
}

/** Combine a request's header affinity with its Responses client metadata. */
export function resolveResponsesRequestRoutingAffinity(
  clientMetadata: unknown,
  currentAffinity: RoutingAffinity | undefined,
): RoutingAffinity | undefined {
  const memoryAffinity = resolveResponsesMemoryRoutingAffinity(
    clientMetadata,
    currentAffinity,
  )
  if (memoryAffinity) return memoryAffinity
  const forkAffinity = resolveResponsesForkRoutingAffinity(
    clientMetadata,
    currentAffinity,
  )
  if (forkAffinity) return forkAffinity
  if (!currentAffinity) return resolveResponsesRoutingAffinity(clientMetadata)
  return withMetadataThread(currentAffinity, clientMetadata)
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

/**
 * Install a Responses request's identity. `fallback` applies only when
 * neither the headers nor the client metadata identify the conversation.
 */
export function installResponsesRoutingAffinity(
  clientMetadata: unknown,
  fallback?: RoutingAffinity,
): void {
  const state = routingAffinityStorage.getStore()
  if (!state) return
  const affinity =
    resolveResponsesRequestRoutingAffinity(clientMetadata, state.affinity)
    ?? fallback
  if (affinity) state.affinity = affinity
}
