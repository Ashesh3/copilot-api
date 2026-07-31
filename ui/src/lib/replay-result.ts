import type { HttpResponseExportSource } from "./http-export"
import type { ReplayResult } from "./types"

export interface AcceptedReplayResult {
  generation: number
  responseIdentity: string
  result: ReplayResult
}

export interface ReplaySourceIdentity {
  body: string
  id: string
}

export interface ReplayRunState {
  runGeneration: number
  sourceGeneration: number
}

export interface ReplayRunToken extends ReplayRunState {
  source: ReplaySourceIdentity
}

export type ReplayResultClassification =
  | { ok: true }
  | { message: string; ok: false }

export function classifyReplayResult(result: {
  status: number
  statusText: string
}): ReplayResultClassification {
  if (result.status >= 200 && result.status < 300) return { ok: true }

  const statusText = result.statusText.trim()
  return {
    message: `Replay returned ${result.status}${statusText ? ` ${statusText}` : ""}`,
    ok: false,
  }
}

export function replayResponse(result: ReplayResult): HttpResponseExportSource {
  return {
    body: result.body,
    headers: result.headers,
    status: result.status,
    statusText: result.statusText,
  }
}

export function acceptReplayResult(
  id: string,
  result: ReplayResult,
  previous?: AcceptedReplayResult,
): AcceptedReplayResult {
  const generation = (previous?.generation ?? 0) + 1
  return {
    generation,
    responseIdentity: `${id}-replay-${generation}`,
    result,
  }
}

export function isSameReplaySource(
  source: ReplaySourceIdentity | undefined,
  id: string,
  body: string,
): boolean {
  return source?.id === id && source.body === body
}

export function initialReplayRunState(): ReplayRunState {
  return { runGeneration: 0, sourceGeneration: 0 }
}

export function advanceReplaySource(state: ReplayRunState): ReplayRunState {
  return {
    runGeneration: state.runGeneration,
    sourceGeneration: state.sourceGeneration + 1,
  }
}

export function advanceReplayRun(
  state: ReplayRunState,
  source: ReplaySourceIdentity,
): { state: ReplayRunState; token: ReplayRunToken } {
  const nextState = {
    runGeneration: state.runGeneration + 1,
    sourceGeneration: state.sourceGeneration,
  }
  return { state: nextState, token: { ...nextState, source } }
}

export function isCurrentReplayRun(
  token: ReplayRunToken,
  state: ReplayRunState,
  source: ReplaySourceIdentity,
): boolean {
  return (
    token.runGeneration === state.runGeneration
    && token.sourceGeneration === state.sourceGeneration
    && isSameReplaySource(token.source, source.id, source.body)
  )
}

export function replayErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message
  }
  return "Replay request failed"
}
