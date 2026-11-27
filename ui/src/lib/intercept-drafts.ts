import { useSyncExternalStore } from "react"

import type { InterceptItemSummary } from "../../../src/lib/intercept/types"
import type { InterceptDraft, InterceptDraftUpdate } from "./intercept-view"

import { ApiError } from "./api"

/**
 * Unsaved Intercept edits per held item. The store lives above the routed
 * screen, so opening another dashboard section keeps them. Memory only: drafts
 * can hold prompts and secrets, so they are never written to Web Storage.
 */
let drafts: ReadonlyMap<string, InterceptDraft> = new Map()
const listeners = new Set<() => void>()

function setDrafts(next: ReadonlyMap<string, InterceptDraft>): void {
  if (next === drafts) return
  drafts = next
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
  if (next) updated.set(id, next)
  else updated.delete(id)
  setDrafts(updated)
}

/** Drafts only matter while their item is held; resolved items cannot change. */
export function retainHeldInterceptDrafts(
  pending: ReadonlyArray<InterceptItemSummary>,
): void {
  const held = new Set(pending.map((item) => item.id))
  if ([...drafts.keys()].every((id) => held.has(id))) return
  setDrafts(new Map([...drafts].filter(([id]) => held.has(id))))
}

/** The admin session ended (logout or a 401): nobody may see these edits again. */
export function clearInterceptDrafts(): void {
  if (drafts.size > 0) setDrafts(new Map())
}

/** Drops every draft when a request failed because the admin session is gone. */
export function clearInterceptDraftsOnAuthError(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) clearInterceptDrafts()
}
