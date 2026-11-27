import { useSyncExternalStore } from "react"

import type { InterceptItemSummary } from "../../../src/lib/intercept/types"
import type { InterceptDraft, InterceptDraftUpdate } from "./intercept-view"

import { onAuthFailure } from "./api"

/**
 * Unsaved Intercept edits per held item. The store lives above the routed
 * screen, so opening another dashboard section keeps them. Memory only: drafts
 * can hold prompts and secrets, so they are never written to Web Storage.
 */
let drafts: ReadonlyMap<string, InterceptDraft> = new Map()
const listeners = new Set<() => void>()
/** Snapshot requests issued so far; see `beginInterceptDraftSnapshot`. */
let snapshotTickets = 0
/** Per draft: `snapshotTickets` when it was created. */
const draftSince = new Map<string, number>()

function setDrafts(next: ReadonlyMap<string, InterceptDraft>): void {
  if (next === drafts) return
  drafts = next
  for (const id of draftSince.keys()) {
    if (!drafts.has(id)) draftSince.delete(id)
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ReadonlyMap<string, InterceptDraft> {
  return drafts
}

export function useInterceptDrafts(): ReadonlyMap<string, InterceptDraft> {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function updateInterceptDraft(
  id: string,
  update: InterceptDraftUpdate,
): void {
  const current = drafts.get(id)
  const next = update(current)
  if (next === current) return
  const updated = new Map(drafts)
  if (next) {
    updated.set(id, next)
    if (!draftSince.has(id)) draftSince.set(id, snapshotTickets)
  } else {
    updated.delete(id)
  }
  setDrafts(updated)
}

/** Call right before requesting a snapshot whose `pending` list will prune drafts. */
export function beginInterceptDraftSnapshot(): number {
  snapshotTickets += 1
  return snapshotTickets
}

/**
 * Drafts only matter while their item is held; resolved items cannot change.
 * A held item stays pending until it resolves and never returns, so a snapshot
 * proves an item resolved only if its draft (hence the item) already existed
 * when that snapshot was requested. Responses that arrive late, out of order,
 * or after the screen unmounted therefore never drop a newer draft.
 */
export function retainHeldInterceptDrafts(
  ticket: number,
  pending: ReadonlyArray<InterceptItemSummary>,
): void {
  const held = new Set(pending.map((item) => item.id))
  const isResolved = (id: string) =>
    !held.has(id) && (draftSince.get(id) ?? ticket) < ticket
  if (![...drafts.keys()].some((id) => isResolved(id))) return
  setDrafts(new Map([...drafts].filter(([id]) => !isResolved(id))))
}

/** The admin session ended (logout or a 401): nobody may see these edits again. */
export function clearInterceptDrafts(): void {
  if (drafts.size > 0) setDrafts(new Map())
}

// Every dashboard request shares `api`, so a 401 from any section clears them.
onAuthFailure(clearInterceptDrafts)
