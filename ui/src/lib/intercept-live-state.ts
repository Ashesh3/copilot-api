import type {
  InterceptConfig,
  InterceptItemSummary,
  InterceptSnapshot,
} from "../../../src/lib/intercept/types"

/** JSON text frames sent by the Intercept live-updates socket. */
export type InterceptSocketMessage =
  | { event: "snapshot"; data: { snapshot: InterceptSnapshot } }
  | { event: "config"; data: { config: InterceptConfig } }
  | { event: "queued" | "updated"; data: { item: InterceptItemSummary } }
  | { event: "resolved"; data: { id: string } }
  | { event: "ping"; data: number }

export function parseInterceptSocketMessage(
  data: unknown,
): InterceptSocketMessage | undefined {
  if (typeof data !== "string") return undefined
  try {
    return JSON.parse(data) as InterceptSocketMessage
  } catch {
    return undefined
  }
}

/** Held items stay ordered oldest first, as in the server snapshot. */
export function withQueued<S extends InterceptSnapshot>(
  state: S,
  item: InterceptItemSummary,
): S {
  const pending = [
    ...state.pending.filter((entry) => entry.id !== item.id),
    item,
  ].sort((a, b) => a.createdAtMs - b.createdAtMs)
  return {
    ...state,
    pending,
    stats: { ...state.stats, pendingCount: pending.length },
  }
}

function replaceSummary(
  list: Array<InterceptItemSummary>,
  item: InterceptItemSummary,
): Array<InterceptItemSummary> | undefined {
  if (!list.some((entry) => entry.id === item.id)) return undefined
  return list.map((entry) => (entry.id === item.id ? item : entry))
}

/**
 * Items outside both lists have aged out of Recent (or are announced by a
 * later frame), so an update for one changes nothing shown.
 */
export function withUpdated<S extends InterceptSnapshot>(
  state: S,
  item: InterceptItemSummary,
): S {
  const pending = replaceSummary(state.pending, item)
  if (pending) return { ...state, pending }
  const recent = replaceSummary(state.recent, item)
  return recent ? { ...state, recent } : state
}

export type StateUpdate<S> = (prev: S) => S

/**
 * Orders full state loads (a state GET or a config PUT): only the newest one
 * may land, and socket updates received while it was in flight are replayed
 * onto its result, so a steady stream of events never discards a load.
 */
export class InterceptStateLoads<S> {
  private seq = 0
  private updates: Array<StateUpdate<S>> | undefined

  begin(): number {
    this.updates = []
    return ++this.seq
  }

  /** Updates to replay onto load `seq`; undefined once it is superseded. */
  finish(seq: number): Array<StateUpdate<S>> | undefined {
    if (seq !== this.seq) return undefined
    const updates = this.updates ?? []
    this.updates = undefined
    return updates
  }

  /** Keeps `update` for the load in flight; false when none is. */
  record(update: StateUpdate<S>): boolean {
    this.updates?.push(update)
    return this.updates !== undefined
  }

  /** Drops every load in flight, such as those of an unmounted screen. */
  cancel(): void {
    this.seq += 1
    this.updates = undefined
  }
}
