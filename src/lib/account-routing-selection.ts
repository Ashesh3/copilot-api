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
  candidates: ReadonlyArray<Account>
  copilotSessionToken?: string
  modelId: string
  accountPin?: RoutedAccountPin
  createAssignment?: boolean
}

type DistributionRepository = ReturnType<
  typeof createAccountDistributionRepository
>

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

async function existingCandidateSelection(
  options: PersistentCandidateOptions & { affinityKey: string },
  repository: DistributionRepository,
  preferredId: number | undefined,
): Promise<RoutedAccountSelection> {
  const legacy = legacyCandidateSelection(options)
  const owner = await repository.lookup(options.affinityKey)
  if (owner === undefined) return legacy
  if (preferredId !== undefined && owner !== preferredId)
    throw conflictingConversationAccount()
  const account = options.candidates.find((candidate) => candidate.id === owner)
  if (!account) throw unavailableConversationAccount()
  return { ...legacy, account }
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
  const legacy = legacyCandidateSelection(options)
  const pinnedId = options.accountPin?.accountId
  const runtime = peekStorageRuntime()
  if (!runtime || !options.affinityKey) return legacy
  const repository = createAccountDistributionRepository(runtime.storage)
  const generation = tokenPool.routingGeneration
  const issuer = issuerAccount(options.copilotSessionToken, options.affinityKey)
  if (pinnedId !== undefined && issuer && pinnedId !== issuer.id)
    throw conflictingConversationAccount()
  const preferredId = pinnedId ?? issuer?.id
  if (options.createAssignment === false)
    return existingCandidateSelection(
      { ...options, affinityKey: options.affinityKey },
      repository,
      preferredId,
    )
  let assignment: AccountAssignment
  try {
    assignment = await repository.assign({
      affinityKey: options.affinityKey,
      modelId: options.modelId,
      eligibleAccountIds: candidateIds(options.candidates),
      preferredAccountId: preferredId,
      preferredReason: pinnedId !== undefined ? "pinned" : "issuer",
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
