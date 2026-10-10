import type { AccountAssignment } from "~/lib/storage/account-distribution-repository"
import type { Account } from "~/lib/token-pool"

import { sessionTokenMatchesAccount } from "~/lib/copilot-session-token"
import { LocalHTTPError } from "~/lib/error"
import { getRoutingAffinity } from "~/lib/routing-affinity"
import { recordRoutingSelection } from "~/lib/routing-telemetry"
import {
  AccountDistributionConflictError,
  AccountDistributionRevisionError,
  AccountDistributionUnavailableError,
  createAccountDistributionRepository,
} from "~/lib/storage/account-distribution-repository"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"
import { peekStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"

export interface RoutedAccountAssignmentMetadata {
  assignmentReason?: AccountAssignment["reason"]
  eligibleAccountWeights?: AccountAssignment["eligibleAccountWeights"]
  allocationVersion?: number
}

export interface RoutedAccountPin extends RoutedAccountAssignmentMetadata {
  accountId?: number
  eligibleAccountIds?: Array<number>
  selectionMode?: "sticky" | "default"
}

export interface RoutedAccountSelection
  extends RoutedAccountAssignmentMetadata {
  account?: Account
  eligibleAccountIds: Array<number>
  selectionMode: "sticky" | "default"
}

function assignmentError(
  code: string,
  message: string,
  status: 409 | 503,
): LocalHTTPError {
  const body = { error: { code, message, type: "session_affinity_error" } }
  return new LocalHTTPError(message, Response.json(body, { status }), body)
}

export function unavailableConversationAccount(): LocalHTTPError {
  return assignmentError(
    "conversation_account_unavailable",
    "This conversation's assigned account cannot serve the requested model. Its account assignment was preserved.",
    409,
  )
}

function conflictingConversationAccount(): LocalHTTPError {
  return assignmentError(
    "conversation_account_conflict",
    "The requested account or Copilot session conflicts with this conversation's account assignment.",
    409,
  )
}

function issuerAccount(sessionToken: string | undefined, affinityKey: string) {
  if (!sessionToken) return undefined
  const issuers = tokenPool.getAllAccounts().filter((account) =>
    sessionTokenMatchesAccount({
      accountSubject: account.copilotAccountSubject,
      accountToken: account.copilotToken,
      sessionToken,
    }),
  )
  return tokenPool.selectAccountBySession(issuers, affinityKey)
}

interface PersistentCandidateOptions {
  affinityKey?: string
  /** The requesting Codex thread behind an inherited `affinityKey`. */
  threadAffinityKey?: string
  /** A Codex fork's agent-tree session, consulted after its fork parent. */
  sessionAffinityKey?: string
  /**
   * The request names no model, like a Copilot session or Auto call. It may
   * use a thread's existing assignment but never starts one, because whether
   * an inherited account serves the thread's model is not yet known.
   */
  modelAgnostic?: boolean
  candidates: ReadonlyArray<Account>
  copilotSessionToken?: string
  modelId: string
  accountPin?: RoutedAccountPin
  createAssignment?: boolean
}

type DistributionRepository = ReturnType<
  typeof createAccountDistributionRepository
>

export interface ConversationAffinity {
  /** Durable identity whose owner serves this request. */
  key: string
  /** Owner inherited from a fork parent or agent-tree session, not yet recorded for `key`. */
  inheritedAccountId?: number
  /**
   * Identity whose equal-hash choice seeds a new assignment before percentages
   * are saved. A thread leaving a healthy inherited account that lacks its
   * model hashes as itself, like any new conversation. Otherwise this stays
   * the inherited identity, keeping forks of conversations recorded before
   * this version on their earlier account.
   */
  placementKey: string
}

/**
 * Choose the durable identity for a request. A Codex subagent or fork is its
 * own conversation, keyed by its thread ID, and only ever records that key.
 * Its first assignment inherits the account of its fork parent, or else of its
 * agent-tree session, while that account serves the requested model; a healthy
 * inherited account that lacks the model leaves the thread to a new assignment.
 * An unavailable inherited account keeps its continuity error rather than
 * moving history to another account.
 */
export async function resolveConversationAffinity(options: {
  affinityKey: string
  threadAffinityKey?: string
  sessionAffinityKey?: string
  modelAgnostic?: boolean
  repository: Pick<DistributionRepository, "lookupAll">
  servesModel: (accountId: number) => boolean
}): Promise<ConversationAffinity> {
  const { affinityKey, threadAffinityKey } = options
  if (!threadAffinityKey || threadAffinityKey === affinityKey)
    return { key: affinityKey, placementKey: affinityKey }
  const inherited = [affinityKey]
  if (
    options.sessionAffinityKey
    && options.sessionAffinityKey !== affinityKey
    && options.sessionAffinityKey !== threadAffinityKey
  )
    inherited.push(options.sessionAffinityKey)
  const [threadOwner, ...inheritedOwners] = await options.repository.lookupAll([
    threadAffinityKey,
    ...inherited,
  ])
  const thread = { key: threadAffinityKey, placementKey: affinityKey }
  if (threadOwner !== undefined) return thread
  if (options.modelAgnostic)
    return { key: affinityKey, placementKey: affinityKey }
  const index = inheritedOwners.findIndex((owner) => owner !== undefined)
  const owner = inheritedOwners.at(index)
  if (index === -1 || owner === undefined) return thread
  if (options.servesModel(owner))
    return { ...thread, inheritedAccountId: owner }
  if (!tokenPool.getHealthyAccountIds().includes(owner))
    return { key: inherited[index], placementKey: affinityKey }
  return { key: threadAffinityKey, placementKey: threadAffinityKey }
}

function legacyCandidateSelection(
  options: PersistentCandidateOptions,
): RoutedAccountSelection {
  const legacy = selectCandidateAccount(options)
  const pinnedId = options.accountPin?.accountId
  if (pinnedId !== undefined) {
    legacy.account = options.candidates.find(
      (account) => account.id === pinnedId,
    )
    legacy.eligibleAccountIds =
      options.accountPin?.eligibleAccountIds ?? legacy.eligibleAccountIds
    legacy.selectionMode =
      options.accountPin?.selectionMode ?? legacy.selectionMode
  }
  return legacy
}

/** Read-only selection honors a recorded or inherited owner without recording one. */
function existingCandidateSelection(
  options: PersistentCandidateOptions,
  owner: number | undefined,
  preferredId: number | undefined,
): RoutedAccountSelection {
  const legacy = legacyCandidateSelection(options)
  if (owner === undefined) return legacy
  if (preferredId !== undefined && owner !== preferredId)
    throw conflictingConversationAccount()
  const account = options.candidates.find((candidate) => candidate.id === owner)
  if (!account) throw unavailableConversationAccount()
  return { ...legacy, account }
}

/**
 * As in admission, an inherited owner only seeds a thread without its own
 * record, so a pin or recognized issuer still takes precedence.
 */
async function readOnlyOwner(
  repository: DistributionRepository,
  conversation: ConversationAffinity,
  preferredId: number | undefined,
): Promise<number | undefined> {
  const recorded = await repository.lookup(conversation.key)
  if (recorded !== undefined || preferredId !== undefined) return recorded
  return conversation.inheritedAccountId
}

async function assignmentFailure(options: {
  error: unknown
  candidates: ReadonlyArray<Account>
  repository: DistributionRepository
  preferredId?: number
}): Promise<void> {
  const { error } = options
  if (error instanceof AccountDistributionConflictError)
    throw conflictingConversationAccount()
  if (error instanceof AccountDistributionRevisionError)
    throw assignmentError(
      "account_distribution_changed",
      "Account routing changed while this request was being admitted. Retry the request.",
      503,
    )
  if (error instanceof AccountDistributionUnavailableError) {
    if (
      options.candidates.length === 0
      && !(await options.repository.load()).configured
      && options.preferredId === undefined
    )
      return
    if (options.preferredId !== undefined)
      throw unavailableConversationAccount()
    throw assignmentError(
      "account_distribution_unavailable",
      "No eligible account has a positive allocation for this model.",
      503,
    )
  }
  throw error
}

function assignedCandidateSelection(
  options: PersistentCandidateOptions,
  assignment: AccountAssignment,
): RoutedAccountSelection {
  const account = options.candidates.find(
    (candidate) => candidate.id === assignment.accountId,
  )
  if (!account) throw unavailableConversationAccount()
  if (assignment.reason === "new")
    recordRoutingSelection({
      accountId: account.id,
      model: options.modelId,
      mode: "sticky",
      affinitySource: getRoutingAffinity()?.source,
      eligibleAccountIds: assignment.eligibleAccountWeights.map(
        (entry) => entry.accountId,
      ),
      eligibleAccountWeights: assignment.eligibleAccountWeights,
      assignmentReason: "new",
      allocationVersion: assignment.allocationVersion,
      assignmentOnly: true,
    })
  return {
    account,
    eligibleAccountIds: assignment.eligibleAccountWeights.map(
      (entry) => entry.accountId,
    ),
    selectionMode: "sticky",
    eligibleAccountWeights: assignment.eligibleAccountWeights,
    assignmentReason:
      assignment.reason === "new" ? "existing" : assignment.reason,
    allocationVersion: assignment.allocationVersion,
  }
}

/** Persistent ownership is resolved before endpoint selection, never after dispatch. */
export async function selectPersistentCandidateAccount(
  options: PersistentCandidateOptions,
): Promise<RoutedAccountSelection> {
  const runtime = peekStorageRuntime()
  if (!runtime || !options.affinityKey) return legacyCandidateSelection(options)
  const repository = createAccountDistributionRepository(runtime.storage)
  // Captured before the identity reads so a routing change during them is detected.
  const generation = tokenPool.routingGeneration
  const conversation = await resolveConversationAffinity({
    affinityKey: options.affinityKey,
    threadAffinityKey: options.threadAffinityKey,
    sessionAffinityKey: options.sessionAffinityKey,
    modelAgnostic: options.modelAgnostic,
    repository,
    servesModel: (accountId) =>
      options.candidates.some((candidate) => candidate.id === accountId),
  })
  const placed = { ...options, affinityKey: conversation.placementKey }
  const legacy = legacyCandidateSelection(placed)
  const pinnedId = options.accountPin?.accountId
  const issuer = issuerAccount(options.copilotSessionToken, options.affinityKey)
  if (pinnedId !== undefined && issuer && pinnedId !== issuer.id)
    throw conflictingConversationAccount()
  const preferredId = pinnedId ?? issuer?.id
  if (options.createAssignment === false)
    return existingCandidateSelection(
      placed,
      await readOnlyOwner(repository, conversation, preferredId),
      preferredId,
    )
  let assignment: AccountAssignment
  try {
    // The transaction rereads the thread's owner, so a concurrent first turn
    // that recorded it is adopted rather than treated as a conflict.
    assignment = await repository.assign({
      affinityKey: conversation.key,
      modelId: options.modelId,
      eligibleAccountIds: candidateIds(options.candidates),
      preferredAccountId: preferredId,
      preferredReason: pinnedId !== undefined ? "pinned" : "issuer",
      inheritedAccountId: conversation.inheritedAccountId,
      legacyAccountId: legacy.account?.id,
      expectedRevision:
        getRequestSnapshot()?.revision ?? runtime.snapshot.get().revision,
      validateCandidates: () => {
        if (generation !== tokenPool.routingGeneration)
          throw new AccountDistributionRevisionError()
      },
    })
  } catch (error) {
    await assignmentFailure({
      error,
      candidates: options.candidates,
      repository,
      preferredId,
    })
    return legacy
  }
  return assignedCandidateSelection(options, assignment)
}

function candidateIds(candidates: ReadonlyArray<Account>): Array<number> {
  return candidates
    .map((account) => account.id)
    .sort((left, right) => left - right)
}

export function selectCandidateAccount(options: {
  affinityKey?: string
  candidates: ReadonlyArray<Account>
  copilotSessionToken?: string
}): RoutedAccountSelection {
  const issuerCandidates =
    options.copilotSessionToken ?
      options.candidates.filter((account) =>
        sessionTokenMatchesAccount({
          accountSubject: account.copilotAccountSubject,
          accountToken: account.copilotToken,
          sessionToken: options.copilotSessionToken,
        }),
      )
    : []
  const candidates =
    issuerCandidates.length > 0 ? issuerCandidates : options.candidates
  return {
    account: tokenPool.selectAccountBySession(candidates, options.affinityKey),
    eligibleAccountIds: candidateIds(candidates),
    selectionMode: options.affinityKey ? "sticky" : "default",
  }
}

export async function selectModelAccount(options: {
  affinityKey?: string
  threadAffinityKey?: string
  sessionAffinityKey?: string
  copilotSessionToken?: string
  modelId: string
  pinnedAccountId?: number
  routedAccountPin?: RoutedAccountPin
  selectedAccountPin?: RoutedAccountPin
  createAssignment?: boolean
}): Promise<RoutedAccountSelection> {
  const candidates = tokenPool.getEligibleAccountsForModel(options.modelId)
  const fallback = {
    eligibleAccountIds: candidateIds(candidates),
    selectionMode:
      options.affinityKey ? ("sticky" as const) : ("default" as const),
  }
  const explicitPin = options.routedAccountPin
  const inheritedPin = options.selectedAccountPin
  const accountId =
    explicitPin?.accountId ?? options.pinnedAccountId ?? inheritedPin?.accountId
  const metadataPin =
    explicitPin?.accountId !== undefined ? explicitPin : inheritedPin
  const result = await selectPersistentCandidateAccount({
    affinityKey: options.affinityKey,
    threadAffinityKey: options.threadAffinityKey,
    sessionAffinityKey: options.sessionAffinityKey,
    candidates,
    copilotSessionToken: options.copilotSessionToken,
    modelId: options.modelId,
    createAssignment: options.createAssignment,
    accountPin:
      accountId === undefined ? undefined : (
        {
          ...metadataPin,
          accountId,
          eligibleAccountIds:
            metadataPin?.eligibleAccountIds ?? fallback.eligibleAccountIds,
          selectionMode: metadataPin?.selectionMode ?? fallback.selectionMode,
        }
      ),
  })
  if (result.account && result.allocationVersion !== undefined) {
    const current = tokenPool.getEligibleAccountForModel(
      options.modelId,
      result.account.id,
    )
    if (!current) throw unavailableConversationAccount()
    result.account = current
  }
  return result
}
