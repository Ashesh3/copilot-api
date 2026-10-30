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
 * `foreign`: issued to another account, or expired. `unreadable`: the model
 * could not decrypt it, which may be transient.
 */
export type ReasoningStateRejection = "foreign" | "unreadable"

export interface ReasoningStateRejectionDetail {
  readonly kind: ReasoningStateRejection
  /** The ends of the state Copilot quotes when it cannot read it. */
  readonly quoted?: { readonly prefix: string; readonly suffix: string }
}

/** Picks replayed state by its value and fingerprint. */
export type ReasoningStateSelector = (
  state: string,
  fingerprint: string,
) => boolean

export interface ReasoningStateRecoveryStep {
  readonly select: ReasoningStateSelector
  /** A successful resend shows the account refuses the removed state. */
  readonly remember: boolean
}

const MAX_REMEMBERED_REJECTIONS = 4096
const MAX_REMEMBERED_ACCEPTANCES = 16_384
// Ownership is per account, so both sets key state by account and fingerprint.
const rejectedReasoningState = new Set<string>()
const acceptedReasoningState = new Set<string>()
// Copilot reports state it cannot open as, for example, "The encrypted content
// a96q...p3k= could not be verified. Reason: Encrypted content could not be
// decrypted or parsed." with code `invalid_request_body`. The quoted ends
// identify the item.
const UNREADABLE_STATE =
  /\bencrypted content\b.{1,256}?\bcould not be (?:verified|decrypted|parsed)\b/u
const QUOTED_STATE =
  /\bencrypted content ([\w+/=-]{1,16})\.\.\.([\w+/=-]{1,16}) could not be\b/iu
// Copilot message for item state issued to another account, or expired. Item
// IDs and previous response IDs are rejected with different messages.
const FOREIGN_STATE = /\binput item does not belong to this connection\b/u
const FOREIGN_ITEM_ID = /\binput item id does not belong to this connection\b/u

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

function accountStateKey(account: string, value: string): string {
  return `${account}:${value}`
}

function remember(set: Set<string>, limit: number, key: string): void {
  set.delete(key)
  if (set.size >= limit) {
    const oldest = set.values().next()
    if (!oldest.done) set.delete(oldest.value)
  }
  set.add(key)
}

export function hasReasoningState(body: Record<string, unknown>): boolean {
  return reasoningStateItems(body).length > 0
}

/**
 * A replayed reasoning ID can be refused independently of its ciphertext.
 * Retry self-contained reasoning without those IDs before considering removal
 * of encrypted state. Reference-only items still need their IDs to resolve.
 */
export async function recoverReasoningItemIds(
  body: Record<string, unknown>,
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  if (response.status !== 400) return undefined
  if (
    !reasoningStateItems(body).some(
      (item) => typeof item.id === "string" && item.id.length > 0,
    )
  ) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.clone().text()) as unknown
  } catch {
    return undefined
  }
  const rejection = readConnectionOwnershipRejection(parsed)
  if (rejection === undefined || !FOREIGN_ITEM_ID.test(rejection)) {
    return undefined
  }
  const repaired = structuredClone(body)
  for (const item of reasoningStateItems(repaired)) {
    Reflect.deleteProperty(item, "id")
  }
  return repaired
}

/** Remove the replayed state `select` picks, returning fingerprints of it. */
export function stripReasoningState(
  body: Record<string, unknown>,
  select: ReasoningStateSelector = () => true,
): Array<string> {
  const removed: Array<string> = []
  for (const item of reasoningStateItems(body)) {
    const value = fingerprint(item.encrypted_content)
    if (!select(item.encrypted_content, value)) continue
    removed.push(value)
    Reflect.deleteProperty(item, "encrypted_content")
    // Do not turn refused state into an ID reference on this or later turns.
    Reflect.deleteProperty(item, "id")
  }
  return removed
}

/**
 * Remove state the destination account already refused, so the turn does
 * not fail first. State another account refused stays. `account` scopes
 * ownership: the account in a pool, or one scope for a single account.
 */
export function omitRejectedReasoningState(
  body: Record<string, unknown>,
  account: string,
): number {
  if (rejectedReasoningState.size === 0) return 0
  return stripReasoningState(body, (_state, value) =>
    rejectedReasoningState.has(accountStateKey(account, value)),
  ).length
}

export function rememberRejectedReasoningState(
  account: string,
  fingerprints: Iterable<string>,
): void {
  for (const value of fingerprints) {
    remember(
      rejectedReasoningState,
      MAX_REMEMBERED_REJECTIONS,
      accountStateKey(account, value),
    )
  }
}

/** Note the state an account accepted, so a later refusal does not blame it. */
export function rememberAcceptedReasoningState(
  body: Record<string, unknown>,
  account: string,
): void {
  for (const item of reasoningStateItems(body)) {
    const key = accountStateKey(account, fingerprint(item.encrypted_content))
    rejectedReasoningState.delete(key)
    remember(acceptedReasoningState, MAX_REMEMBERED_ACCEPTANCES, key)
  }
}

export function resetRejectedReasoningStateForTest(): void {
  rejectedReasoningState.clear()
  acceptedReasoningState.clear()
}

/** Why Copilot or the model could not use the replayed reasoning state. */
export async function readReasoningStateRejection(
  response: Response,
): Promise<ReasoningStateRejectionDetail | undefined> {
  if (response.status !== 400) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.clone().text()) as unknown
  } catch {
    return undefined
  }
  const ownership = readConnectionOwnershipRejection(parsed)
  if (ownership !== undefined) {
    return FOREIGN_STATE.test(ownership) ? { kind: "foreign" } : undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined
  const { code, message } = parsed.error
  const text =
    typeof message === "string" ? message.replaceAll(/\s+/gu, " ") : ""
  if (
    code !== "invalid_encrypted_content"
    && !UNREADABLE_STATE.test(text.toLowerCase())
  ) {
    return undefined
  }
  const quoted = QUOTED_STATE.exec(text)
  return {
    kind: "unreadable",
    ...(quoted ? { quoted: { prefix: quoted[1], suffix: quoted[2] } } : {}),
  }
}

export async function classifyReasoningStateRejection(
  response: Response,
): Promise<ReasoningStateRejection | undefined> {
  return (await readReasoningStateRejection(response))?.kind
}

/**
 * Resends to try, narrowest first. Unreadable state Copilot quotes is removed
 * alone. For a foreign refusal, state this account never accepted goes first,
 * and only a successful resend marks it refused. Removing all of it is the
 * last resort and stays local to the request.
 */
export function reasoningStateRecoverySteps(
  rejection: ReasoningStateRejectionDetail,
  account: string,
): Array<ReasoningStateRecoveryStep> {
  if (rejection.kind === "unreadable") {
    const { quoted } = rejection
    return [
      {
        remember: false,
        select:
          quoted ?
            (state) =>
              state.startsWith(quoted.prefix) && state.endsWith(quoted.suffix)
          : () => true,
      },
    ]
  }
  return [
    {
      remember: true,
      select: (_state, value) =>
        !acceptedReasoningState.has(accountStateKey(account, value)),
    },
    { remember: false, select: () => true },
  ]
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
