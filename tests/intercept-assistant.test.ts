import { describe, expect, test } from "bun:test"

import type {
  AssistantDiffOp,
  CanonicalItem,
  InterceptAssistantConfig,
  InterceptPendingItem,
} from "~/lib/intercept/types"

import {
  AssistantDiffError,
  buildAssistantPrompt,
  type InterceptAssistantResult,
  parseAssistantDiffResponse,
  runInterceptAssistant,
  validateDiffOps,
} from "~/lib/intercept/assistant"
import {
  isInterceptBypassed,
  runBypassingIntercept,
} from "~/lib/intercept/assistant-model"
import { applyCanonicalDiffOps } from "~/lib/intercept/canonical"
import { InterceptEngine, StaleRevisionError } from "~/lib/intercept/engine"
import { INTERCEPT_ASSISTANT_KINDS } from "~/lib/intercept/types"
import { runAsIndependentRequest } from "~/lib/request-scopes"
import {
  getRequestId,
  requestIdStorage,
  routedAccountStorage,
} from "~/lib/request-session"

const ASSISTANT: InterceptAssistantConfig = {
  enabled: true,
  autoRun: false,
  autopilot: "off",
  model: "test-model",
  systemPrompt: "",
  reasoningEffort: "low",
  messageKinds: [...INTERCEPT_ASSISTANT_KINDS],
  instructionMode: "shared",
  sharedInstruction: "Rewrite the user turn",
  requestInstruction: "",
  responseInstruction: "",
}

const ITEMS: Array<CanonicalItem> = [
  { id: "msg-0", kind: "user", label: "User", content: "hello" },
  {
    id: "img-0",
    kind: "other",
    label: "Image",
    content: "[image]",
    opaque: true,
  },
  {
    id: "tc-0",
    kind: "tool_call",
    label: "Tool call",
    content: '{"path":"a"}',
    toolName: "read",
    toolCallId: "call_1",
    toolArguments: '{"path":"a"}',
  },
]

function heldItem(
  items: Array<CanonicalItem>,
  overrides: Partial<InterceptPendingItem> = {},
): InterceptPendingItem {
  return {
    id: "item-1",
    phase: "request",
    status: "pending",
    createdAt: new Date(0).toISOString(),
    createdAtMs: 0,
    expiresAtMs: 60_000,
    modified: false,
    revision: 0,
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot",
    headers: {},
    originalBody: "{}",
    currentBody: "{}",
    canonical: {
      protocol: "chat_completions",
      phase: "request",
      items,
      editable: true,
    },
    assistantStatus: "idle",
    ...overrides,
  }
}

function result(operations: Array<AssistantDiffOp>): InterceptAssistantResult {
  return {
    id: "suggestion",
    createdAt: new Date(0).toISOString(),
    model: "test-model",
    summary: "test",
    operations,
    previewBody: null,
    previewCanonical: null,
    durationMs: 0,
    reusedItemCount: 0,
    reusedOperationCount: 0,
  }
}

function chatRequest(content: string, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot" as const,
    headers,
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content }],
    }),
  }
}

function pendingId(engine: InterceptEngine): string {
  const first = engine.getSnapshot().pending.at(0)
  if (!first) throw new Error("Nothing is held")
  return first.id
}

describe("assistant replies", () => {
  test.each([
    ["no operations array", '{"summary":"done"}'],
    ["an unknown operation", '{"operations":[{"op":"rename","id":"msg-0"}]}'],
    [
      "a replace that changes nothing",
      '{"operations":[{"op":"replace","id":"msg-0"}]}',
    ],
    ["prose instead of JSON", "Sure! I changed the greeting."],
  ])("rejects %s", (_, reply) => {
    expect(() => parseAssistantDiffResponse(reply)).toThrow(AssistantDiffError)
  })

  test.each<[string, Array<AssistantDiffOp>, string]>([
    ["an unknown id", [{ op: "delete", id: "msg-9" }], "msg-9"],
    [
      "content edits to a read-only item",
      [{ op: "replace", id: "img-0", content: "a cat" }],
      "read-only",
    ],
    [
      "tool arguments that are not JSON",
      [{ op: "replace", id: "tc-0", toolArguments: "{path: a}" }],
      "JSON",
    ],
    [
      "tool fields on a message",
      [{ op: "replace", id: "msg-0", toolName: "read" }],
      "not a tool call",
    ],
    [
      "two changes to one item",
      [
        { op: "replace", id: "msg-0", content: "a" },
        { op: "delete", id: "msg-0" },
      ],
      "more than once",
    ],
    [
      "an insert after a deleted item",
      [
        { op: "delete", id: "msg-0" },
        { op: "insert_after", afterId: "msg-0", kind: "user", content: "x" },
      ],
      "deleted",
    ],
    [
      "an inserted tool call without a name",
      [
        {
          op: "insert_after",
          afterId: null,
          kind: "tool_call",
          content: "",
          toolArguments: "{}",
        },
      ],
      "toolName",
    ],
    [
      "an edit whose text is not in the item",
      [{ op: "edit", id: "msg-0", find: "goodbye", replace: "hi" }],
      "not found",
    ],
    [
      "an edit whose text occurs more than once",
      [{ op: "edit", id: "tc-0", find: '"', replace: "'" }],
      "more than once",
    ],
    [
      "an edit that leaves tool arguments invalid",
      [{ op: "edit", id: "tc-0", find: '"a"}', replace: '"a"' }],
      "JSON",
    ],
    [
      "an edit and a replace of one item",
      [
        { op: "edit", id: "msg-0", find: "hello", replace: "hi" },
        { op: "replace", id: "msg-0", content: "a" },
      ],
      "more than once",
    ],
    [
      "an edit to a read-only item",
      [{ op: "edit", id: "img-0", find: "image", replace: "cat" }],
      "read-only",
    ],
  ])("refuses %s", (_, operations, message) => {
    expect(() => validateDiffOps(ITEMS, operations)).toThrow(message)
  })

  test("allows deleting a read-only item", () => {
    expect(() =>
      validateDiffOps(ITEMS, [{ op: "delete", id: "img-0" }]),
    ).not.toThrow()
  })

  test("applies edits in order, each to the text the previous one left", () => {
    const items: Array<CanonicalItem> = [
      { id: "msg-0", kind: "user", label: "User", content: "the cat sat" },
    ]
    const operations: Array<AssistantDiffOp> = [
      { op: "edit", id: "msg-0", find: "cat", replace: "dog" },
      { op: "edit", id: "msg-0", find: "dog sat", replace: "dog ran" },
    ]

    validateDiffOps(items, operations)

    expect(applyCanonicalDiffOps(items, operations)[0].content).toBe(
      "the dog ran",
    )
  })

  test("edits a tool call's arguments", () => {
    const call = applyCanonicalDiffOps(ITEMS, [
      { op: "edit", id: "tc-0", find: '"a"', replace: '"b.txt"' },
    ])[2]

    expect(call.toolArguments).toBe('{"path":"b.txt"}')
    expect(call.content).toBe('{"path":"b.txt"}')
  })
})

describe("assistant prompt", () => {
  test("names read-only items without sending their content", () => {
    const secret = "data:image/png;base64,UNIQUEPIXELS"
    const prompt = buildAssistantPrompt({
      item: heldItem([
        { id: "msg-0", kind: "user", label: "User", content: "describe" },
        {
          id: "img-0",
          kind: "other",
          label: "Image",
          content: secret,
          opaque: true,
        },
      ]),
      instruction: "Make it about dogs",
    })

    expect(prompt.user).not.toContain("UNIQUEPIXELS")
    expect(prompt.user).toContain("id=img-0 | kind=other | read-only")
  })

  test("keeps instructions and the newest turns when the conversation is long", () => {
    const turns = Array.from({ length: 60 }, (_, index) => ({
      id: `msg-${index + 1}`,
      kind: "user" as const,
      label: "User",
      content: `turn ${index + 1} ${"x".repeat(5000)}`,
    }))
    const items: Array<CanonicalItem> = [
      { id: "sys-0", kind: "system", label: "System", content: "Be terse." },
      ...turns,
    ]
    const prompt = buildAssistantPrompt({
      item: heldItem(items),
      instruction: "Change the last turn",
    })

    expect(prompt.targets.has("sys-0")).toBe(true)
    expect(prompt.targets.has("msg-60")).toBe(true)
    expect(prompt.targets.has("msg-1")).toBe(false)
    expect(prompt.user).toContain("older items are not shown")
    expect(() =>
      validateDiffOps(
        items,
        [{ op: "replace", id: "msg-1", content: "hidden" }],
        prompt.targets,
      ),
    ).toThrow("Unknown item id msg-1")
  })

  test("refuses to replace an item it could only partly see", () => {
    const items: Array<CanonicalItem> = [
      {
        id: "tr-0",
        kind: "tool_result",
        label: "Tool result",
        content: "y".repeat(20_000),
        toolCallId: "call_1",
      },
    ]
    const prompt = buildAssistantPrompt({
      item: heldItem(items),
      instruction: "Shorten it",
    })

    expect(prompt.targets.get("tr-0")?.truncated).toBe(true)
    expect(() =>
      validateDiffOps(
        items,
        [{ op: "replace", id: "tr-0", content: "short" }],
        prompt.targets,
      ),
    ).toThrow("truncated")
    expect(() =>
      validateDiffOps(items, [{ op: "delete", id: "tr-0" }], prompt.targets),
    ).not.toThrow()
  })

  test("refuses to replace the arguments of a tool call it could only partly see", () => {
    const args = JSON.stringify({ path: "a", data: "z".repeat(20_000) })
    const items: Array<CanonicalItem> = [
      {
        id: "tc-0",
        kind: "tool_call",
        label: "Tool call",
        content: args,
        toolName: "write",
        toolCallId: "call_1",
        toolArguments: args,
      },
    ]
    const prompt = buildAssistantPrompt({
      item: heldItem(items),
      instruction: "Rename the tool",
    })

    expect(prompt.targets.get("tc-0")?.truncated).toBe(true)
    for (const op of [
      { op: "replace", id: "tc-0", toolArguments: '{"path":"b"}' },
      { op: "replace", id: "tc-0", content: '{"path":"b"}' },
    ] as const) {
      expect(() => validateDiffOps(items, [op], prompt.targets)).toThrow(
        "truncated",
      )
    }
    expect(() =>
      validateDiffOps(
        items,
        [{ op: "replace", id: "tc-0", toolName: "save" }],
        prompt.targets,
      ),
    ).not.toThrow()
  })

  test("refuses raw-only payloads before calling a model", async () => {
    const item = heldItem([], {
      canonical: {
        protocol: "generic_json",
        phase: "request",
        items: [],
        editable: false,
        readOnlyReason: "Embeddings requests are edited as raw JSON.",
      },
    })

    const failure: unknown = await runInterceptAssistant({
      item,
      config: ASSISTANT,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain(
      "Embeddings requests are edited as raw JSON.",
    )
  })
})

describe("assistant prompt budget", () => {
  test("keeps instructions first but within the total budget", () => {
    const instructions = (prefix: string): Array<CanonicalItem> =>
      Array.from({ length: 12 }, (_, index) => ({
        id: `${prefix}-${index}`,
        kind: index % 2 === 0 ? ("system" as const) : ("developer" as const),
        label: "System",
        content: `${prefix} ${index} ${"s".repeat(30_000)}`,
      }))
    const items: Array<CanonicalItem> = [
      ...instructions("sys"),
      { id: "msg-0", kind: "assistant", label: "Assistant", content: "hi" },
    ]
    const prompt = buildAssistantPrompt({
      item: heldItem(items, {
        phase: "response",
        requestContext: {
          method: "POST",
          path: "/chat/completions",
          body: "{}",
          canonical: {
            protocol: "chat_completions",
            phase: "request",
            items: instructions("ctx"),
            editable: true,
          },
        },
      }),
      instruction: "Change the reply",
    })

    const shownChars = [...prompt.targets.values()].reduce(
      (total, entry) => total + entry.rendered.length,
      0,
    )
    expect(shownChars).toBeLessThanOrEqual(120_000)
    expect(prompt.targets.has("sys-0")).toBe(true)
    expect(prompt.targets.has("sys-11")).toBe(false)
    expect(prompt.targets.has("msg-0")).toBe(true)
    expect(prompt.user).toContain(
      "system or developer items are not shown: they exceed the size limit",
    )
    expect(prompt.user).toContain("id=ctx-0")
    expect(prompt.user).not.toContain("id=ctx-11")
    // 120k target budget, 40k context budget, plus fixed framing.
    expect(prompt.user.length).toBeLessThan(165_000)
    expect(() =>
      validateDiffOps(items, [{ op: "delete", id: "sys-11" }], prompt.targets),
    ).toThrow("Unknown item id sys-11")
  })

  test("charges item headers so many empty instructions stay within the budget", () => {
    const items: Array<CanonicalItem> = Array.from(
      { length: 5000 },
      (_, index) => ({
        id: `sys-${index}`,
        kind: "system" as const,
        label: "System",
        content: "",
      }),
    )
    const prompt = buildAssistantPrompt({
      item: heldItem(items),
      instruction: "Change nothing",
    })

    const header = "# TARGET ITEMS (the request you are editing)\n"
    const section = prompt.user.slice(
      prompt.user.indexOf(header) + header.length,
    )
    expect(section.length).toBeLessThanOrEqual(120_000)
    expect(section).toStartWith(
      `(${5000 - prompt.targets.size} system or developer items are not shown`,
    )
    expect(prompt.targets.has("sys-0")).toBe(true)
    expect(prompt.targets.has("sys-4999")).toBe(false)
    expect(section).not.toContain("id=sys-4999 ")
    expect(() =>
      validateDiffOps(
        items,
        [{ op: "delete", id: "sys-4999" }],
        prompt.targets,
      ),
    ).toThrow("Unknown item id sys-4999")
  })
})

function observeRequestScope() {
  return Promise.resolve({
    requestId: getRequestId(),
    routing: routedAccountStorage.getStore(),
    bypassed: isInterceptBypassed(),
  })
}

function startAssistant() {
  return runBypassingIntercept(() =>
    runAsIndependentRequest("Test", observeRequestScope),
  )
}

describe("assistant inference scope", () => {
  test("shares no request state with the held request", async () => {
    const parentRouting = {}
    const seen = await requestIdStorage.run("held-request", () =>
      routedAccountStorage.run(parentRouting, startAssistant),
    )

    expect(seen.requestId).toBeString()
    expect(seen.requestId).not.toBe("held-request")
    expect(seen.routing).toBeDefined()
    expect(seen.routing).not.toBe(parentRouting)
    expect(seen.bypassed).toBe(false)
  })
})

describe("suggestions follow the item revision", () => {
  test("drops a result that arrives after the operator edited the item", async () => {
    const reply = Promise.withResolvers<InterceptAssistantResult>()
    const engine = new InterceptEngine(() => reply.promise)
    engine.updateConfig({ enabled: true, direction: "request" })
    const pending = engine.interceptRequest(chatRequest("original"))
    const id = pendingId(engine)

    const running = engine.triggerAssistant(id)
    engine.editPendingItem(id, { body: chatRequest("edited").body })
    reply.resolve(result([{ op: "delete", id: "msg-0" }]))
    await running

    const item = engine.getItem(id)
    expect(item?.revision).toBe(1)
    expect(item?.assistantSuggestion).toBeUndefined()
    expect(() =>
      engine.applyAssistantDiff(id, {
        suggestionId: "suggestion",
        revision: 0,
      }),
    ).toThrow(StaleRevisionError)
    engine.forwardAllPending()
    expect((await pending).body).toBe(chatRequest("edited").body)
  })

  test("refuses a structured edit made against an older revision", async () => {
    const engine = new InterceptEngine()
    engine.updateConfig({ enabled: true, direction: "request" })
    const pending = engine.interceptRequest(chatRequest("original"))
    const id = pendingId(engine)
    engine.editPendingItem(id, { body: chatRequest("first").body })
    const item = engine.getItem(id)
    if (!item) throw new Error("Item is not held")

    expect(() =>
      engine.editPendingItem(id, {
        canonicalItems: item.canonical.items,
        baseRevision: 0,
      }),
    ).toThrow(StaleRevisionError)
    expect(engine.getItem(id)?.currentBody).toBe(chatRequest("first").body)
    engine.forwardAllPending()
    await pending
  })

  test("Autopilot keeps the item held when the changes do not fit", async () => {
    const engine = new InterceptEngine(() =>
      Promise.resolve(
        result([{ op: "replace", id: "msg-7", content: "invented" }]),
      ),
    )
    engine.updateConfig({
      enabled: true,
      direction: "request",
      assistant: { ...ASSISTANT, autopilot: "request" },
    })
    const failed = Promise.withResolvers<null>()
    engine.subscribe((event) => {
      if (event.type === "updated" && event.item.assistantStatus === "error") {
        failed.resolve(null)
      }
    })

    const pending = engine.interceptRequest(chatRequest("original"))
    await failed.promise

    const id = pendingId(engine)
    expect(engine.getItem(id)?.assistantError).toContain("msg-7")
    engine.forwardAllPending()
    expect((await pending).modified).toBe(false)
  })

  test("cancels the assistant call when the item is resolved", async () => {
    let signal: AbortSignal | undefined
    const engine = new InterceptEngine((options) => {
      signal = options.signal
      return new Promise(() => {})
    })
    engine.updateConfig({ enabled: true, direction: "request" })
    const pending = engine.interceptRequest(chatRequest("original"))

    void engine.triggerAssistant(pendingId(engine))
    expect(signal?.aborted).toBe(false)
    engine.forwardAllPending()

    expect(signal?.aborted).toBe(true)
    await pending
  })
})

test("held items never expose credential headers", async () => {
  const engine = new InterceptEngine()
  engine.updateConfig({ enabled: true, direction: "request" })
  const pending = engine.interceptRequest(
    chatRequest("original", {
      Authorization: "Bearer gho_secret",
      "content-type": "application/json",
    }),
  )

  const item = engine.getItem(pendingId(engine))
  expect(item?.headers).toEqual({
    Authorization: "[REDACTED]",
    "content-type": "application/json",
  })
  engine.forwardAllPending()
  await pending
})
