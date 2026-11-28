import { afterEach, describe, expect, test } from "bun:test"

import {
  buildAssistantPrompt,
  type InterceptAssistantResult,
  parseAssistantDiffResponse,
} from "~/lib/intercept/assistant"
import {
  isInterceptBypassed,
  runBypassingIntercept,
} from "~/lib/intercept/assistant-model"
import {
  applyCanonicalDiffOps,
  parseCanonicalView,
  serializeCanonicalItemsToBody,
} from "~/lib/intercept/canonical"
import { InterceptEngine } from "~/lib/intercept/engine"
import {
  evaluateFilterCondition,
  matchesInterceptFilters,
  shouldIntercept,
  validateFilterRegex,
} from "~/lib/intercept/filters"
import {
  type AssistantDiffOp,
  DEFAULT_INTERCEPT_CONFIG,
  INTERCEPT_ASSISTANT_KINDS,
  type InterceptAssistantConfig,
  type InterceptFilterCondition,
} from "~/lib/intercept/types"

const makeCond = (
  partial: Partial<InterceptFilterCondition>,
): InterceptFilterCondition => ({
  id: "c1",
  enabled: true,
  field: "model",
  operator: "contains",
  value: "",
  ...partial,
})

describe("Intercept Filters", () => {
  const baseCtx = {
    phase: "request" as const,
    path: "/v1/messages",
    upstream: "copilot" as const,
    model: "claude-sonnet-4",
    sessionId: "sess_abc123",
    headers: { "X-Custom-Tag": "scenario-alpha" },
    requestBody: JSON.stringify({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Run ls -la in /tmp" }],
    }),
    responseBody: JSON.stringify({ content: [{ type: "text", text: "Done" }] }),
  }

  test("direction gating respects both / request / response", () => {
    const cfg = { ...DEFAULT_INTERCEPT_CONFIG, enabled: true }
    expect(shouldIntercept({ ...cfg, direction: "both" }, baseCtx)).toBe(true)
    expect(shouldIntercept({ ...cfg, direction: "request" }, baseCtx)).toBe(
      true,
    )
    expect(shouldIntercept({ ...cfg, direction: "response" }, baseCtx)).toBe(
      false,
    )
    expect(
      shouldIntercept(
        { ...cfg, direction: "response" },
        { ...baseCtx, phase: "response" },
      ),
    ).toBe(true)
  })

  test("evaluates sessionId, model, header, requestBody, and regex conditions", () => {
    expect(
      evaluateFilterCondition(
        makeCond({
          field: "sessionId",
          operator: "starts_with",
          value: "sess_",
        }),
        baseCtx,
      ),
    ).toBe(true)
    expect(
      evaluateFilterCondition(
        makeCond({
          field: "model",
          operator: "equals",
          value: "CLAUDE-SONNET-4",
        }),
        baseCtx,
      ),
    ).toBe(true)
    expect(
      evaluateFilterCondition(
        makeCond({
          field: "model",
          operator: "equals",
          value: "CLAUDE-SONNET-4",
          caseSensitive: true,
        }),
        baseCtx,
      ),
    ).toBe(false)
    expect(
      evaluateFilterCondition(
        makeCond({
          field: "header",
          headerName: "x-custom-tag",
          operator: "equals",
          value: "scenario-alpha",
        }),
        baseCtx,
      ),
    ).toBe(true)
    expect(
      evaluateFilterCondition(
        makeCond({
          field: "requestBody",
          operator: "regex",
          value: String.raw`ls\s+-la`,
        }),
        baseCtx,
      ),
    ).toBe(true)
  })

  test("matchMode all vs any", () => {
    const c1: InterceptFilterCondition = {
      id: "1",
      enabled: true,
      field: "model",
      operator: "contains",
      value: "claude",
    }
    const c2: InterceptFilterCondition = {
      id: "2",
      enabled: true,
      field: "sessionId",
      operator: "equals",
      value: "other-session",
    }
    expect(
      matchesInterceptFilters(
        { enabled: true, matchMode: "all", conditions: [c1, c2] },
        baseCtx,
      ),
    ).toBe(false)
    expect(
      matchesInterceptFilters(
        { enabled: true, matchMode: "any", conditions: [c1, c2] },
        baseCtx,
      ),
    ).toBe(true)
  })

  test("validateFilterRegex catches invalid RE2 patterns", () => {
    expect(validateFilterRegex("claude-[0-9]+")).toBeNull()
    expect(validateFilterRegex("(unclosed")).not.toBeNull()
  })
})

describe("Canonical Parsing, Diff Apply & Serialization", () => {
  test("parses Chat Completions request with tool calls, applies diff, and serializes back", () => {
    const raw = JSON.stringify({
      model: "gpt-4o",
      temperature: 0.5,
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Check disk space" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: '{"cmd":"df -h"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "bash",
          content: "10G free",
        },
      ],
    })

    const view = parseCanonicalView({
      path: "/chat/completions",
      phase: "request",
      body: raw,
    })
    expect(view.protocol).toBe("chat_completions")
    expect(view.items.map((i) => i.kind)).toEqual([
      "system",
      "user",
      "tool_call",
      "tool_result",
    ])

    const updated = applyCanonicalDiffOps(view.items, [
      {
        op: "replace",
        id: "msg-0",
        content: "You are a strict sandbox assistant.",
      },
      {
        op: "replace",
        id: "msg-2-tc-0",
        toolArguments: '{"cmd":"df -h /sandbox"}',
      },
      {
        op: "insert_after",
        afterId: "msg-3",
        kind: "user",
        content: "Summarize briefly.",
      },
    ])

    const serialized = serializeCanonicalItemsToBody({
      originalBody: raw,
      canonical: view,
      items: updated,
    })
    const parsed = JSON.parse(serialized) as {
      temperature: number
      messages: Array<Record<string, unknown>>
    }
    expect(parsed.temperature).toBe(0.5)
    expect(parsed.messages[0].content).toBe(
      "You are a strict sandbox assistant.",
    )
    expect(
      (
        parsed.messages[2].tool_calls as Array<{
          function: { arguments: string }
        }>
      )[0].function.arguments,
    ).toBe('{"cmd":"df -h /sandbox"}')
    expect(parsed.messages.at(-1)?.content).toBe("Summarize briefly.")
  })

  test("parses Anthropic request & buffered SSE response and re-synthesizes clean SSE", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("")

    const view = parseCanonicalView({
      path: "/v1/messages",
      phase: "response",
      body: sse,
      contentType: "text/event-stream",
    })
    expect(view.protocol).toBe("anthropic_messages")
    expect(view.stream).toBe(true)
    expect(view.items).toHaveLength(1)
    expect(view.items[0].content).toBe("Hello world")

    const edited = applyCanonicalDiffOps(view.items, [
      { op: "replace", id: "out-0", content: "Intercepted reply!" },
    ])
    const rebuiltSse = serializeCanonicalItemsToBody({
      originalBody: sse,
      canonical: view,
      items: edited,
      contentType: "text/event-stream",
    })
    expect(rebuiltSse).toContain("event: content_block_delta")
    expect(rebuiltSse).toContain("Intercepted reply!")
    expect(rebuiltSse).toContain("event: message_stop")

    const reparsed = parseCanonicalView({
      path: "/v1/messages",
      phase: "response",
      body: rebuiltSse,
      contentType: "text/event-stream",
    })
    expect(reparsed.items[0].content).toBe("Intercepted reply!")
  })
})

describe("Assistant Prompt & Diff Parser", () => {
  test("parses fenced JSON diff response cleanly", () => {
    const raw = [
      "```json",
      JSON.stringify({
        summary: "Rewrote user prompt for sandbox scenario",
        operations: [
          {
            op: "replace",
            id: "msg-1",
            content: "List files in /sandbox",
            reason: "Enforce sandbox directory",
          },
          {
            op: "delete",
            id: "msg-2",
            reason: "Remove unrelated note",
          },
        ],
      }),
      "```",
    ].join("\n")

    const parsed = parseAssistantDiffResponse(raw)
    expect(parsed.summary).toBe("Rewrote user prompt for sandbox scenario")
    expect(parsed.operations).toHaveLength(2)
    expect(parsed.operations[0].op).toBe("replace")
    expect(parsed.operations[1].op).toBe("delete")
  })

  test("runBypassingIntercept sets bypass flag inside scope only", () => {
    expect(isInterceptBypassed()).toBe(false)
    const inside = runBypassingIntercept(() => isInterceptBypassed())
    expect(inside).toBe(true)
    expect(isInterceptBypassed()).toBe(false)
  })

  test("buildAssistantPrompt formats compact structured items without raw HTTP noise", () => {
    const engine = new InterceptEngine()
    engine.updateConfig({ enabled: true, direction: "request" })
    const rawBody = JSON.stringify({
      model: "gpt-4o",
      extra_noise: "should_not_appear_in_prompt",
      messages: [{ role: "user", content: "Original message" }],
    })
    const pendingPromise = engine.interceptRequest({
      method: "POST",
      path: "/chat/completions",
      url: "https://api.githubcopilot.com/chat/completions",
      upstream: "copilot",
      headers: { Authorization: "Bearer secret" },
      body: rawBody,
    })

    const snap = engine.getSnapshot()
    const item = engine.getItem(snap.pending[0].id)
    expect(item).toBeDefined()
    if (!item) return
    const prompt = buildAssistantPrompt({
      item,
      instruction: "Translate to Spanish",
    })
    expect(prompt.user).toContain("id=msg-0")
    expect(prompt.user).toContain("Original message")
    expect(prompt.user).not.toContain("should_not_appear_in_prompt")
    expect(prompt.user).not.toContain("Bearer secret")

    engine.forwardAllPending()
    return pendingPromise
  })
})

describe("InterceptEngine Queue Lifecycle", () => {
  const engine = new InterceptEngine()

  afterEach(() => {
    engine.resetForTest()
  })

  test("holds request until edited and forwarded, returning modified body", async () => {
    engine.updateConfig({ enabled: true, direction: "both" })
    const origBody = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    })

    const promise = engine.interceptRequest({
      method: "POST",
      path: "/chat/completions",
      url: "https://api.githubcopilot.com/chat/completions",
      upstream: "copilot",
      headers: { "content-type": "application/json" },
      body: origBody,
    })

    const snap = engine.getSnapshot()
    expect(snap.pending).toHaveLength(1)
    const id = snap.pending[0].id

    const editedBody = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello (edited)" }],
    })
    expect(engine.forwardItem(id, { body: editedBody })).toBe(true)

    const outcome = await promise
    expect(outcome.modified).toBe(true)
    expect(outcome.body).toBe(editedBody)
    expect(engine.getSnapshot().pending).toHaveLength(0)
    expect(engine.getSnapshot().stats.modifiedCount).toBe(1)
  })

  test("holds and modifies SSE response when direction includes response", async () => {
    engine.updateConfig({ enabled: true, direction: "response" })
    const origSse =
      'data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Original"},"finish_reason":null}]}\n\n'
      + 'data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + "data: [DONE]\n\n"

    const upstreamResp = new Response(origSse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })

    const queued = Promise.withResolvers<string>()
    const unsubscribe = engine.subscribe((ev) => {
      if (ev.type === "queued") queued.resolve(ev.item.id)
    })

    const promise = engine.interceptResponse({
      method: "POST",
      path: "/chat/completions",
      url: "https://api.githubcopilot.com/chat/completions",
      upstream: "copilot",
      response: upstreamResp,
      requestSnapshot: {
        method: "POST",
        path: "/chat/completions",
        model: "gpt-4o",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
        headers: {},
      },
    })

    const id = await queued.promise
    unsubscribe()
    const snap = engine.getSnapshot()
    expect(snap.pending).toHaveLength(1)
    const item = engine.getItem(id)
    expect(item).toBeDefined()
    if (!item) return
    expect(item.canonical.items[0].content).toBe("Original")
    engine.forwardItem(id, {
      canonicalItems: [
        { ...item.canonical.items[0], content: "Modified SSE output" },
      ],
    })

    const finalResp = await promise
    const finalText = await finalResp.text()
    expect(finalText).toContain("Modified SSE output")
    expect(finalText).toContain("[DONE]")
  })

  test("toggling intercept OFF releases all queued items", async () => {
    engine.updateConfig({ enabled: true, direction: "request" })
    const p1 = engine.interceptRequest({
      method: "POST",
      path: "/chat/completions",
      url: "https://api.githubcopilot.com/chat/completions",
      upstream: "copilot",
      headers: {},
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })

    expect(engine.getSnapshot().pending).toHaveLength(1)
    engine.updateConfig({ enabled: false })
    expect(engine.getSnapshot().pending).toHaveLength(0)

    const res = await p1
    expect(res.modified).toBe(false)
  })

  test("dropping an item rejects the request with the operator's reason", async () => {
    engine.updateConfig({ enabled: true, direction: "request" })
    const p = engine.interceptRequest({
      method: "POST",
      path: "/chat/completions",
      url: "https://api.githubcopilot.com/chat/completions",
      upstream: "copilot",
      headers: {},
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })

    const id = engine.getSnapshot().pending[0].id
    engine.dropItem(id, "Blocked by test")
    let caught: unknown
    try {
      await p
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("Blocked by test")
    expect(engine.getSnapshot().stats.droppedCount).toBe(1)
  })
})

function suggestion(
  operations: Array<AssistantDiffOp>,
): InterceptAssistantResult {
  return {
    id: "sugg-test",
    createdAt: new Date(0).toISOString(),
    model: "test-model",
    summary: "test suggestion",
    operations,
    previewBody: null,
    previewCanonical: null,
    durationMs: 0,
    reusedItemCount: 0,
    reusedOperationCount: 0,
  }
}

const AUTOPILOT_ASSISTANT: Omit<InterceptAssistantConfig, "autopilot"> = {
  enabled: true,
  autoRun: false,
  model: "test-model",
  systemPrompt: "",
  reasoningEffort: "low",
  messageKinds: [...INTERCEPT_ASSISTANT_KINDS],
  instructionMode: "shared",
  sharedInstruction: "Rewrite the user turn",
  requestInstruction: "",
  responseInstruction: "",
}

function chatRequest(content: string) {
  return {
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot" as const,
    headers: {},
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content }],
    }),
  }
}

describe("Autopilot", () => {
  test("applies the assistant's changes and forwards without review", async () => {
    const engine = new InterceptEngine(() =>
      Promise.resolve(
        suggestion([
          { op: "replace", id: "msg-0", content: "Rewritten by assistant" },
        ]),
      ),
    )
    engine.updateConfig({
      enabled: true,
      direction: "request",
      assistant: { ...AUTOPILOT_ASSISTANT, autopilot: "request" },
    })

    const outcome = await engine.interceptRequest(chatRequest("Original"))

    expect(outcome.modified).toBe(true)
    const sent = JSON.parse(outcome.body) as {
      messages: Array<{ content: string }>
    }
    expect(sent.messages[0].content).toBe("Rewritten by assistant")
    const [resolved] = engine.getSnapshot().recent
    expect(resolved.status).toBe("forwarded")
    expect(resolved.autopilot).toBe(true)
  })

  test("leaves held items alone in directions it does not cover", async () => {
    let runs = 0
    const engine = new InterceptEngine(() => {
      runs += 1
      return Promise.resolve(suggestion([]))
    })
    engine.updateConfig({
      enabled: true,
      direction: "both",
      assistant: { ...AUTOPILOT_ASSISTANT, autopilot: "response" },
    })

    const pending = engine.interceptRequest(chatRequest("Original"))

    expect(engine.getSnapshot().pending).toHaveLength(1)
    expect(runs).toBe(0)
    engine.forwardAllPending()
    expect((await pending).modified).toBe(false)
  })

  test("keeps the item held for review when the assistant fails", async () => {
    const engine = new InterceptEngine(() =>
      Promise.reject(new Error("model unavailable")),
    )
    engine.updateConfig({
      enabled: true,
      direction: "request",
      assistant: { ...AUTOPILOT_ASSISTANT, autopilot: "both" },
    })
    const failed = Promise.withResolvers<null>()
    engine.subscribe((event) => {
      if (event.type === "updated" && event.item.assistantStatus === "error") {
        failed.resolve(null)
      }
    })

    const pending = engine.interceptRequest(chatRequest("Original"))
    await failed.promise

    expect(engine.getSnapshot().pending).toHaveLength(1)
    engine.forwardAllPending()
    expect((await pending).modified).toBe(false)
  })
})
