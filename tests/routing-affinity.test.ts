import { expect, test } from "bun:test"

import { getClientSessionId } from "~/lib/request-session"
import {
  getRoutingAffinity,
  installRoutingAffinityFallback,
  normalizeRoutingAffinityKey,
  resolveClaudeRoutingAffinity,
  resolveResponsesRoutingAffinity,
  resolveRoutingAffinityFromHeaders,
  runWithRoutingAffinity,
} from "~/lib/routing-affinity"

test("resolves supported headers in protocol precedence order", () => {
  const headers = new Headers({
    "thread-id": " thread ",
    "session-id": " codex ",
    "x-client-session-id": " copilot ",
    "x-claude-code-session-id": " claude ",
    "x-interaction-id": "interaction-must-not-win",
    "x-request-id": "request-must-not-win",
    "x-client-machine-id": "machine-must-not-win",
  })

  expect(resolveRoutingAffinityFromHeaders(headers)).toEqual({
    key: "claude",
    source: "claude_session",
  })
  headers.delete("x-claude-code-session-id")
  expect(resolveRoutingAffinityFromHeaders(headers)).toEqual({
    key: "copilot",
    source: "copilot_session",
  })
  headers.delete("x-client-session-id")
  expect(resolveRoutingAffinityFromHeaders(headers)).toEqual({
    key: "codex",
    source: "codex_session",
  })
  headers.delete("session-id")
  expect(resolveRoutingAffinityFromHeaders(headers)).toEqual({
    key: "thread",
    source: "codex_thread",
  })
})

test("ignores blank, oversized, and unrelated header identifiers", () => {
  expect(
    resolveRoutingAffinityFromHeaders(
      new Headers({
        "x-claude-code-session-id": "  ",
        "x-client-session-id": "x".repeat(513),
        "session-id": "y".repeat(513),
        "thread-id": "\t",
        "x-agent-task-id": "task",
        "x-client-machine-id": "machine",
        "x-interaction-id": "interaction",
        "x-request-id": "request",
      }),
    ),
  ).toBeUndefined()
})

test("accepts exactly 512 UTF-16 code units", () => {
  const value = "x".repeat(512)
  expect(
    resolveRoutingAffinityFromHeaders(
      new Headers({ "x-client-session-id": ` ${value} ` }),
    ),
  ).toEqual({ key: value, source: "copilot_session" })
  expect(normalizeRoutingAffinityKey("\ud83d\ude00".repeat(256))).toBe(
    "\ud83d\ude00".repeat(256),
  )
  expect(
    normalizeRoutingAffinityKey("\ud83d\ude00".repeat(257)),
  ).toBeUndefined()
})

test("extracts Claude session metadata best effort", () => {
  expect(
    resolveClaudeRoutingAffinity({
      user_id: JSON.stringify({ session_id: " claude-body " }),
    }),
  ).toEqual({ key: "claude-body", source: "claude_metadata" })
  expect(resolveClaudeRoutingAffinity({ user_id: "not json" })).toBeUndefined()
  expect(
    resolveClaudeRoutingAffinity({
      user_id: JSON.stringify({ session_id: "x".repeat(513) }),
    }),
  ).toBeUndefined()
  expect(resolveClaudeRoutingAffinity(undefined)).toBeUndefined()
})

test("extracts Responses session then thread metadata best effort", () => {
  expect(
    resolveResponsesRoutingAffinity({
      session_id: " response-session ",
      thread_id: "response-thread",
    }),
  ).toEqual({ key: "response-session", source: "codex_metadata" })
  expect(
    resolveResponsesRoutingAffinity(
      JSON.stringify({ session_id: " ", thread_id: " response-thread " }),
    ),
  ).toEqual({ key: "response-thread", source: "codex_thread" })
  expect(resolveResponsesRoutingAffinity("not json")).toBeUndefined()
  expect(
    resolveResponsesRoutingAffinity(["not", "an", "object"]),
  ).toBeUndefined()
  expect(
    resolveResponsesRoutingAffinity({ thread_id: "x".repeat(513) }),
  ).toBeUndefined()
})

test("keeps mutable affinity state and never overwrites an existing value", () => {
  const headerAffinity = {
    key: "header-session",
    source: "copilot_session" as const,
  }

  runWithRoutingAffinity(headerAffinity, () => {
    expect(getRoutingAffinity()).toEqual(headerAffinity)
    expect(getClientSessionId()).toBe("header-session")
    installRoutingAffinityFallback({
      key: "body-session",
      source: "codex_metadata",
    })
    expect(getRoutingAffinity()).toEqual(headerAffinity)
  })

  runWithRoutingAffinity(undefined, () => {
    expect(getRoutingAffinity()).toBeUndefined()
    installRoutingAffinityFallback({
      key: "body-session",
      source: "codex_metadata",
    })
    expect(getRoutingAffinity()).toEqual({
      key: "body-session",
      source: "codex_metadata",
    })
  })
  expect(getRoutingAffinity()).toBeUndefined()
})

test("isolates overlapping asynchronous routing affinity scopes", async () => {
  let releaseFirst: (() => void) | undefined
  let releaseSecond: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const observed: Array<string | undefined> = []

  const first = runWithRoutingAffinity(
    { key: "first-session", source: "claude_session" },
    async () => {
      observed.push(getRoutingAffinity()?.key)
      await firstGate
      observed.push(getRoutingAffinity()?.key)
    },
  )
  const second = runWithRoutingAffinity(
    { key: "second-session", source: "copilot_session" },
    async () => {
      observed.push(getRoutingAffinity()?.key)
      await secondGate
      observed.push(getRoutingAffinity()?.key)
    },
  )

  expect(getRoutingAffinity()).toBeUndefined()
  releaseSecond?.()
  await second
  expect(getRoutingAffinity()).toBeUndefined()
  releaseFirst?.()
  await first

  expect(observed).toEqual([
    "first-session",
    "second-session",
    "second-session",
    "first-session",
  ])
  expect(getRoutingAffinity()).toBeUndefined()
})
