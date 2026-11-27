import type { StatusDotProps } from "@astryxdesign/core/StatusDot"

import { useEffect, useState } from "react"

import type {
  CanonicalItem,
  CanonicalItemKind,
  InterceptItemStatus,
} from "../../../src/lib/intercept/types"

import {
  documentDiagnostic,
  findJsonDocumentDiagnostic,
  type JsonDocumentDiagnostic,
} from "./json-document"

interface DraftState {
  /**
   * `revision` of the server item this draft was written against. Structured
   * IDs are positional, so a structured draft can only patch this revision.
   */
  baseRevision: number
  /** Local edit counter; a save clears the draft only if no newer edit landed. */
  edits: number
  /** `edits` value of the save request in flight, if any. */
  savingEdits?: number
}

/**
 * Unsaved operator edits for one held item. Exactly one editor owns a draft:
 * structured drafts live in Messages, raw drafts in Raw.
 */
export type InterceptDraft =
  | (DraftState & { source: "structured"; items: Array<CanonicalItem> })
  | (DraftState & { source: "raw"; body: string })

export type InterceptDraftUpdate = (
  prev: InterceptDraft | undefined,
) => InterceptDraft | undefined

/** Responses only need to be JSON; request-only rules (like `model`) do not apply. */
export function responseJsonDiagnostic(
  raw: string,
): JsonDocumentDiagnostic | null {
  const syntaxError = findJsonDocumentDiagnostic(raw)
  if (syntaxError) return syntaxError
  try {
    JSON.parse(raw)
    return null
  } catch {
    return documentDiagnostic({
      from: 0,
      kind: "syntax",
      message: "Invalid JSON.",
      raw,
      to: raw.length,
    })
  }
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** m:ss until a held item resolves on its own. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const seconds = total % 60
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, "0")}`
}

/** Wall clock that re-renders the caller once per interval, for countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export const STATUS_DOT: Record<
  InterceptItemStatus,
  StatusDotProps["variant"]
> = {
  pending: "warning",
  forwarded: "success",
  dropped: "error",
  timed_out: "neutral",
  aborted: "error",
}

export const STATUS_LABEL: Record<InterceptItemStatus, string> = {
  pending: "Held",
  forwarded: "Forwarded",
  dropped: "Dropped",
  timed_out: "Timed out",
  aborted: "Client aborted",
}

export const KIND_LABEL: Record<CanonicalItemKind, string> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
  thinking: "Thinking",
  tool_call: "Tool call",
  tool_result: "Tool result",
  other: "Other",
}
