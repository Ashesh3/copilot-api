import { createHash } from "node:crypto"

import { readConnectionOwnershipRejection } from "./connection-ownership"

/**
 * Copilot binds each reasoning item's `encrypted_content` to the account that
 * produced it. Replaying that state lets a model continue from its own
 * reasoning; a reasoning item without it is dropped upstream, summary and all.
 * State therefore stays on the wire and is removed only when Copilot cannot
 * use it or the request would not fit otherwise.
 */

type ReasoningStateItem = Record<string, unknown> & {
  encrypted_content: string
}

/**
 * `foreign`: issued to another account, or expired; deterministic, so later
 * turns omit it. `unreadable`: the model could not decrypt it, which may be
 * transient, so it is removed only from the request that failed.
 */
export type ReasoningStateRejection = "foreign" | "unreadable"

const MAX_REMEMBERED_REJECTIONS = 4096
const rejectedReasoningState = new Set<string>()
// Copilot reports state it cannot open as, for example, "The encrypted content
// a96q...p3k= could not be verified. Reason: Encrypted content could not be
// decrypted or parsed." with code `invalid_request_body`.
const UNREADABLE_STATE =
  /\bencrypted content\b.{1,256}?\bcould not be (?:verified|decrypted|parsed)\b/u
// Copilot message for item state issued to another account, or expired. Item
// IDs and previous response IDs are rejected with different messages.
const FOREIGN_STATE = /\binput item does not belong to this connection\b/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reasoningStateItems(
  body: Record<string, unknown>,
): Array<ReasoningStateItem> {
  if (!Array.isArray(body.input)) return []
  return body.input.filter(
    (item): item is ReasoningStateItem =>
      isRecord(item)
      && item.type === "reasoning"
      && typeof item.encrypted_content === "string"
      && item.encrypted_content.length > 0,
  )
}

function fingerprint(state: string): string {
  return createHash("sha256").update(state).digest("base64url")
}

export function hasReasoningState(body: Record<string, unknown>): boolean {
  return reasoningStateItems(body).length > 0
}

/** Remove every replayed reasoning state, returning fingerprints of it. */
export function stripReasoningState(
  body: Record<string, unknown>,
): Array<string> {
  const removed: Array<string> = []
  for (const item of reasoningStateItems(body)) {
    removed.push(fingerprint(item.encrypted_content))
    Reflect.deleteProperty(item, "encrypted_content")
  }
  return removed
}

/** Remove only state Copilot already refused, so later turns do not fail first. */
export function omitRejectedReasoningState(
  body: Record<string, unknown>,
): number {
  if (rejectedReasoningState.size === 0) return 0
  let omitted = 0
  for (const item of reasoningStateItems(body)) {
    if (!rejectedReasoningState.has(fingerprint(item.encrypted_content))) {
      continue
    }
    Reflect.deleteProperty(item, "encrypted_content")
    omitted += 1
  }
  return omitted
}

export function rememberRejectedReasoningState(
  fingerprints: Iterable<string>,
): void {
  for (const value of fingerprints) {
    rejectedReasoningState.delete(value)
    if (rejectedReasoningState.size >= MAX_REMEMBERED_REJECTIONS) {
      const oldest = rejectedReasoningState.values().next()
      if (!oldest.done) rejectedReasoningState.delete(oldest.value)
    }
    rejectedReasoningState.add(value)
  }
}

export function resetRejectedReasoningStateForTest(): void {
  rejectedReasoningState.clear()
}

/** Why Copilot or the model could not use the replayed reasoning state. */
export async function classifyReasoningStateRejection(
  response: Response,
): Promise<ReasoningStateRejection | undefined> {
  if (response.status !== 400) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.clone().text()) as unknown
  } catch {
    return undefined
  }
  const ownership = readConnectionOwnershipRejection(parsed)
  if (ownership !== undefined) {
    return FOREIGN_STATE.test(ownership) ? "foreign" : undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined
  const { code, message } = parsed.error
  if (code === "invalid_encrypted_content") return "unreadable"
  if (typeof message !== "string") return undefined
  const normalized = message.toLowerCase().replaceAll(/\s+/gu, " ")
  return UNREADABLE_STATE.test(normalized) ? "unreadable" : undefined
}

export interface ReasoningStateBudget {
  readonly currentBytes: number
  readonly targetBytes: number
  /** Drop nothing unless dropping state alone makes the payload fit. */
  readonly onlyIfSufficient?: boolean
}

/**
 * Drop replayed reasoning state, oldest first, until the payload fits, so the
 * most recent reasoning survives longest.
 */
export function omitReasoningStateToFit(
  record: Record<string, unknown>,
  budget: ReasoningStateBudget,
): { bytes: number; omitted: number } {
  const { currentBytes, targetBytes } = budget
  const items = reasoningStateItems(record)
  // The property and its separating comma leave the serialized payload.
  const savings = items.map(
    (item) =>
      Buffer.byteLength(
        JSON.stringify({ encrypted_content: item.encrypted_content }),
        "utf8",
      ) - 1,
  )
  const totalSavings = savings.reduce((total, bytes) => total + bytes, 0)
  if (budget.onlyIfSufficient && currentBytes - totalSavings > targetBytes) {
    return { bytes: currentBytes, omitted: 0 }
  }
  let bytes = currentBytes
  let omitted = 0
  for (const [index, item] of items.entries()) {
    if (bytes <= targetBytes) break
    bytes -= savings[index]
    Reflect.deleteProperty(item, "encrypted_content")
    omitted += 1
  }
  if (omitted === 0) return { bytes: currentBytes, omitted }
  return { bytes: Buffer.byteLength(JSON.stringify(record), "utf8"), omitted }
}
