import type { Account } from "~/lib/token-pool"

import {
  inspectCopilotBearerTokenIssuer,
  inspectCopilotSessionToken,
} from "~/lib/copilot-session-token"
import { tokenPool } from "~/lib/token-pool"

export interface RoutedAccountPin {
  accountId?: number
  eligibleAccountIds?: Array<number>
  selectionMode?: "sticky" | "default"
}

export interface RoutedAccountSelection {
  account?: Account
  eligibleAccountIds: Array<number>
  selectionMode: "sticky" | "default"
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
  const issuerSubject =
    options.copilotSessionToken ?
      inspectCopilotSessionToken(options.copilotSessionToken)?.issuerSubject
    : undefined
  const issuerCandidates =
    issuerSubject ?
      options.candidates.filter(
        (account) =>
          inspectCopilotBearerTokenIssuer(account.copilotToken)
          === issuerSubject,
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

export function selectModelAccount(options: {
  affinityKey?: string
  copilotSessionToken?: string
  modelId: string
  pinnedAccountId?: number
  routedAccountPin?: RoutedAccountPin
  selectedAccountPin?: RoutedAccountPin
}): RoutedAccountSelection {
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
  if (accountId !== undefined) {
    const metadataPin =
      explicitPin?.accountId !== undefined ? explicitPin : inheritedPin
    return {
      account: tokenPool.getEligibleAccountForModel(options.modelId, accountId),
      eligibleAccountIds:
        metadataPin?.eligibleAccountIds ?? fallback.eligibleAccountIds,
      selectionMode: metadataPin?.selectionMode ?? fallback.selectionMode,
    }
  }
  return selectCandidateAccount({
    affinityKey: options.affinityKey,
    candidates,
    copilotSessionToken: options.copilotSessionToken,
  })
}
