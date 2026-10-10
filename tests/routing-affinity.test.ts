import { expect, test } from "bun:test"

import { getClientSessionId } from "~/lib/request-session"
import {
  getRoutingAffinity,
  installResponsesRoutingAffinity,
  installRoutingAffinityFallback,
  normalizeRoutingAffinityKey,
  resolveClaudeRoutingAffinity,
  resolveResponsesRequestRoutingAffinity,
  resolveResponsesRoutingAffinity,
  resolveRoutingAffinityFromHeaders,
  runWithRoutingAffinity,
  type RoutingAffinity,
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
    threadKey: "thread",
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
  ).toEqual({
    key: "response-session",
    source: "codex_metadata",
    threadKey: "response-thread",
  })
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

function memoryMetadata(thread = "memory-root") {
  return {
    session_id: "memory-root",
    thread_id: thread,
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "memory",
      thread_source: "memory_consolidation",
      turn_id: "memory-job",
    }),
  }
}

test("isolates Codex memory from its thread with a stable identity across transports and jobs", () => {
  const metadata = memoryMetadata()
  const expected = resolveResponsesRoutingAffinity(metadata)
  expect(expected?.key).toBeDefined()
  expect(expected?.key).not.toBe("memory-root")
  expect(expected?.threadKey).toBeUndefined()
  expect(expected?.sessionKey).toBeUndefined()
  expect(resolveResponsesRoutingAffinity(JSON.stringify(metadata))).toEqual(
    expected,
  )
  for (const headers of [
    new Headers({ "session-id": "memory-root", "thread-id": "memory-root" }),
    new Headers({ "session-id": "memory-root" }),
    new Headers({ "thread-id": "memory-root" }),
  ]) {
    const header = resolveRoutingAffinityFromHeaders(headers)
    const resolved = resolveResponsesRequestRoutingAffinity(metadata, header)
    expect(resolved?.key).toBe(expected?.key)
    expect(resolveResponsesRequestRoutingAffinity(metadata, resolved)).toEqual(
      resolved,
    )
  }
  expect(
    resolveResponsesRoutingAffinity({
      ...metadata,
      "x-codex-turn-metadata": { request_kind: "memory", turn_id: "next-job" },
    })?.key,
  ).toBe(expected?.key)
})

test("memory uses its own requesting thread without inheriting a fork or agent-tree owner", () => {
  const root = resolveResponsesRoutingAffinity(memoryMetadata())
  const childMetadata = memoryMetadata("memory-child")
  const child = resolveResponsesRoutingAffinity(childMetadata)
  const fork = resolveResponsesRoutingAffinity({
    ...childMetadata,
    "x-codex-turn-metadata": {
      request_kind: "memory",
      forked_from_thread_id: "other-parent",
    },
  })
  expect(child?.key).not.toBe(root?.key)
  expect(child?.key).not.toBe("memory-child")
  expect(fork?.key).toBe(child?.key)
  expect(fork?.threadKey).toBeUndefined()
  expect(fork?.sessionKey).toBeUndefined()
  expect(
    resolveResponsesRequestRoutingAffinity(childMetadata, {
      key: "other-parent",
      source: "codex_thread",
      threadKey: "memory-child",
      sessionKey: "memory-root",
    })?.key,
  ).toBe(child?.key)
})

test.each(["turn", "prewarm", "compaction", "unknown", undefined])(
  "keeps %s on the ordinary conversation identity",
  (requestKind) => {
    const metadata = {
      ...memoryMetadata(),
      "x-codex-turn-metadata": { request_kind: requestKind },
    }
    expect(resolveResponsesRoutingAffinity(metadata)).toEqual({
      key: "memory-root",
      source: "codex_metadata",
    })
  },
)

test("memory metadata cannot replace a higher-priority or conflicting header identity", () => {
  for (const header of [
    { key: "memory-root", source: "claude_session" as const },
    { key: "memory-root", source: "copilot_session" as const },
    { key: "different-root", source: "codex_session" as const },
    {
      key: "memory-root",
      source: "codex_session" as const,
      threadKey: "different-child",
    },
  ])
    expect(
      resolveResponsesRequestRoutingAffinity(memoryMetadata(), header),
    ).toEqual(header)
  expect(
    resolveResponsesRoutingAffinity({
      "x-codex-turn-metadata": { request_kind: "memory" },
    }),
  ).toBeUndefined()
})

test("routes Codex forks with the parent thread before the child session", () => {
  for (const clientMetadata of [
    {
      session_id: "fork-child",
      thread_id: "fork-child",
      "x-codex-turn-metadata": {
        forked_from_thread_id: " fork-parent ",
      },
    },
    JSON.stringify({
      session_id: "fork-child",
      thread_id: "fork-child",
      "x-codex-turn-metadata": JSON.stringify({
        forked_from_thread_id: " fork-parent ",
      }),
    }),
  ]) {
    expect(resolveResponsesRoutingAffinity(clientMetadata)).toEqual({
      key: "fork-parent",
      source: "codex_thread",
      threadKey: "fork-child",
    })
  }
})

test("keeps a Codex subagent's own thread behind its agent-tree session", () => {
  expect(
    resolveRoutingAffinityFromHeaders(
      new Headers({ "session-id": " root-thread ", "thread-id": " subagent " }),
    ),
  ).toEqual({
    key: "root-thread",
    source: "codex_session",
    threadKey: "subagent",
  })
  expect(
    resolveResponsesRoutingAffinity({
      session_id: "root-thread",
      thread_id: "subagent",
    }),
  ).toEqual({
    key: "root-thread",
    source: "codex_metadata",
    threadKey: "subagent",
  })
  // A root thread is its own session, so it has no separate thread identity.
  expect(
    resolveRoutingAffinityFromHeaders(
      new Headers({ "session-id": "root-thread", "thread-id": "root-thread" }),
    ),
  ).toEqual({ key: "root-thread", source: "codex_session" })
})

test("routes a fork inside an agent tree through its parent, then its session", () => {
  const clientMetadata = {
    session_id: "root-thread",
    thread_id: "grandchild",
    "x-codex-turn-metadata": JSON.stringify({
      forked_from_thread_id: "child",
    }),
  }
  const expected: RoutingAffinity = {
    key: "child",
    source: "codex_thread",
    threadKey: "grandchild",
    sessionKey: "root-thread",
  }

  expect(resolveResponsesRoutingAffinity(clientMetadata)).toEqual(expected)
  runWithRoutingAffinity(
    resolveRoutingAffinityFromHeaders(
      new Headers({ "session-id": "root-thread", "thread-id": "grandchild" }),
    ),
    () => {
      installResponsesRoutingAffinity(clientMetadata)
      expect(getRoutingAffinity()).toEqual(expected)
    },
  )
})

test("keeps the header thread when fork metadata omits its thread", () => {
  runWithRoutingAffinity(
    resolveRoutingAffinityFromHeaders(
      new Headers({ "session-id": "root-thread", "thread-id": "subagent" }),
    ),
    () => {
      installResponsesRoutingAffinity({
        session_id: "root-thread",
        "x-codex-turn-metadata": JSON.stringify({
          forked_from_thread_id: "fork-parent",
        }),
      })
      expect(getRoutingAffinity()).toEqual({
        key: "fork-parent",
        source: "codex_thread",
        threadKey: "subagent",
        sessionKey: "root-thread",
      })
    },
  )
})

test("ignores fork metadata for a different thread than the header's", () => {
  const headerAffinity = resolveRoutingAffinityFromHeaders(
    new Headers({ "session-id": "root-thread", "thread-id": "subagent" }),
  )
  runWithRoutingAffinity(headerAffinity, () => {
    installResponsesRoutingAffinity({
      session_id: "root-thread",
      thread_id: "other-thread",
      "x-codex-turn-metadata": JSON.stringify({
        forked_from_thread_id: "fork-parent",
      }),
    })
    expect(getRoutingAffinity()).toEqual({
      key: "root-thread",
      source: "codex_session",
      threadKey: "subagent",
    })
  })
})

test("adds the metadata thread to a header session that omitted it", () => {
  runWithRoutingAffinity(
    { key: "root-thread", source: "codex_session" },
    () => {
      installResponsesRoutingAffinity({
        session_id: "root-thread",
        thread_id: "subagent",
      })
      expect(getRoutingAffinity()).toEqual({
        key: "root-thread",
        source: "codex_session",
        threadKey: "subagent",
      })
    },
  )
  runWithRoutingAffinity({ key: "other", source: "codex_session" }, () => {
    installResponsesRoutingAffinity({
      session_id: "root-thread",
      thread_id: "subagent",
    })
    expect(getRoutingAffinity()).toEqual({
      key: "other",
      source: "codex_session",
    })
  })
})

test("ignores malformed Codex fork metadata", () => {
  expect(
    resolveResponsesRoutingAffinity({
      session_id: "fork-child",
      "x-codex-turn-metadata": "not json",
    }),
  ).toEqual({ key: "fork-child", source: "codex_metadata" })
  expect(
    resolveResponsesRoutingAffinity({
      session_id: "fork-child",
      "x-codex-turn-metadata": JSON.stringify({
        forked_from_thread_id: "x".repeat(513),
      }),
    }),
  ).toEqual({ key: "fork-child", source: "codex_metadata" })
})

test("preserves unrelated header affinity over Codex fork metadata", () => {
  const clientMetadata = {
    session_id: "fork-child",
    thread_id: "fork-child",
    "x-codex-turn-metadata": JSON.stringify({
      forked_from_thread_id: "fork-parent",
    }),
  }

  runWithRoutingAffinity(
    { key: "unrelated-header", source: "copilot_session" },
    () => {
      installResponsesRoutingAffinity(clientMetadata)
      expect(getRoutingAffinity()).toEqual({
        key: "unrelated-header",
        source: "copilot_session",
      })
    },
  )
})

test("preserves higher-priority headers that reuse the child id", () => {
  const clientMetadata = {
    session_id: "shared-child-id",
    thread_id: "shared-child-id",
    "x-codex-turn-metadata": JSON.stringify({
      forked_from_thread_id: "fork-parent",
    }),
  }

  for (const source of ["claude_session", "copilot_session"] as const) {
    runWithRoutingAffinity({ key: "shared-child-id", source }, () => {
      installResponsesRoutingAffinity(clientMetadata)
      expect(getRoutingAffinity()).toEqual({ key: "shared-child-id", source })
    })
  }
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
