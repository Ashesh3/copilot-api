/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- async attempt callbacks and Bun rejection assertions model upstream outcomes */
import { afterEach, expect, spyOn, test } from "bun:test"

import { setConfigForTest } from "~/lib/config"
import { HTTPError, LocalHTTPError } from "~/lib/error"
import {
  applyModelFallbackToPayload,
  recordModelFallbackResponse,
  runWithModelFallback,
} from "~/lib/model-fallback"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { copilotResponseHeadersStorage } from "~/lib/request-session"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const config = {
  enabled: true,
  notifyClient: false,
  nativeClientNotice: false,
  rules: [
    { id: "test", sourceModel: "source", targetModel: "target", enabled: true },
  ],
}

async function fakeRequest(
  options: Parameters<typeof runWithModelFallback>[0],
  beforeAccept?: () => void,
) {
  return await runWithModelFallback(options, async () => {
    const payload = applyModelFallbackToPayload({ model: "source" })
    if (payload.model === "target") beforeAccept?.()
    const response = new Response(null, {
      status: payload.model === "source" ? 422 : 200,
    })
    await recordModelFallbackResponse(response)
    if (!response.ok) throw new HTTPError("upstream", response)
    return payload.model
  })
}

test("ordinary source successes do not claim fallback diagnostic headers", async () => {
  setModelFallbackConfigForTest({ ...config, notifyClient: true })
  const headers: Record<string, string> = {}
  await copilotResponseHeadersStorage.run(
    headers,
    async () =>
      await runWithModelFallback({}, async () => {
        applyModelFallbackToPayload({ model: "source" })
        await recordModelFallbackResponse(new Response(null, { status: 200 }))
      }),
  )
  expect(headers).toEqual({})
})

test("final upstream 422 after existing compatibility retry remains eligible", async () => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await runWithModelFallback({}, async () => {
    attempts++
    const payload = applyModelFallbackToPayload({ model: "source" })
    if (payload.model === "source") {
      await recordModelFallbackResponse(new Response(null, { status: 400 }))
      const response = new Response(null, { status: 422 })
      await recordModelFallbackResponse(response)
      throw new HTTPError("upstream", response)
    }
    await recordModelFallbackResponse(new Response(null, { status: 200 }))
  })
  expect(attempts).toBe(2)
})

test("a later 422 after accepted output cannot restart the request", async () => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await expect(
    runWithModelFallback({}, async () => {
      attempts++
      applyModelFallbackToPayload({ model: "source" })
      await recordModelFallbackResponse(new Response(null, { status: 200 }))
      const response = new Response(null, { status: 422 })
      await recordModelFallbackResponse(response)
      throw new HTTPError("later tool loop", response)
    }),
  ).rejects.toBeInstanceOf(HTTPError)
  expect(attempts).toBe(1)
})

test("an in-flight accepted fallback does not publish after its configuration changes", async () => {
  setModelFallbackConfigForTest(config)
  await fakeRequest({ conversationKey: "thread" }, () => {
    setModelFallbackConfigForTest(config)
  })
  await runWithModelFallback({ conversationKey: "thread" }, async () => {
    expect(applyModelFallbackToPayload({ model: "source" }).model).toBe(
      "source",
    )
  })
})

test("new conversations retain previously stored conversation models", async () => {
  setModelFallbackConfigForTest(config)
  await fakeRequest({ conversationKey: "first" })
  await fakeRequest({ conversationKey: "second" })
  let source: string | undefined
  await runWithModelFallback({ conversationKey: "first" }, async () => {
    source = applyModelFallbackToPayload({ model: "source" }).model
  })
  expect(source).toBe("target")
})

test("stored conversation models do not expire with elapsed time", async () => {
  setModelFallbackConfigForTest(config)
  await fakeRequest({ conversationKey: "thread" })
  const future = Date.now() + 365 * 24 * 60 * 60 * 1000
  const now = spyOn(Date, "now").mockReturnValue(future)
  try {
    let source: string | undefined
    await runWithModelFallback({ conversationKey: "thread" }, async () => {
      source = applyModelFallbackToPayload({ model: "source" }).model
    })
    expect(source).toBe("target")
  } finally {
    now.mockRestore()
  }
})

test("changing a fallback rule re-evaluates its stored conversation route", async () => {
  setModelFallbackConfigForTest(config)
  await fakeRequest({ conversationKey: "thread" })
  setModelFallbackConfigForTest({
    ...config,
    rules: [
      {
        id: "test",
        sourceModel: "source",
        targetModel: "new-target",
        enabled: true,
      },
    ],
  })
  await runWithModelFallback({ conversationKey: "thread" }, async () => {
    expect(applyModelFallbackToPayload({ model: "source" }).model).toBe(
      "source",
    )
  })
})

test("notice and unrelated rule changes preserve the stored model and foreign history", async () => {
  setModelFallbackConfigForTest(config)
  await runWithModelFallback({ conversationKey: "stable-route" }, async () => {
    const payload = applyModelFallbackToPayload({
      model: "source",
      input: [{ type: "reasoning", encrypted_content: "old-source" }],
    })
    const response = new Response(null, {
      status: payload.model === "source" ? 422 : 200,
    })
    await recordModelFallbackResponse(response)
    if (!response.ok) throw new HTTPError("upstream", response)
  })
  setModelFallbackConfigForTest({
    ...config,
    notifyClient: true,
    rules: [
      ...config.rules,
      {
        id: "unrelated",
        sourceModel: "other",
        targetModel: "other-target",
        enabled: true,
      },
    ],
  })
  await runWithModelFallback({ conversationKey: "stable-route" }, async () => {
    const payload = applyModelFallbackToPayload({
      model: "source",
      input: [
        { type: "reasoning", encrypted_content: "old-source" },
        { type: "reasoning", encrypted_content: "new-target" },
      ],
    })
    expect(payload.model).toBe("target")
    expect(payload.input).toEqual([
      { type: "reasoning", encrypted_content: "new-target" },
    ])
  })
})

test("concurrent successful transitions merge all known foreign signatures", async () => {
  setModelFallbackConfigForTest(config)
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let firstReached: (() => void) | undefined
  const firstPending = new Promise<void>((resolve) => {
    firstReached = resolve
  })
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the concurrent fixture belongs to this race
  const original = (signatures: Array<string>) => ({
    model: "source",
    input: signatures.map((signature) => ({
      type: "reasoning",
      encrypted_content: signature,
    })),
  })
  const request = (signatures: Array<string>, delayed: boolean) =>
    runWithModelFallback(
      { conversationKey: "concurrent", payload: original(signatures) },
      async () => {
        const payload = applyModelFallbackToPayload(original(signatures))
        if (payload.model === "target" && delayed) {
          firstReached?.()
          await firstGate
        }
        const response = new Response(null, {
          status: payload.model === "source" ? 422 : 200,
        })
        await recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
      },
    )
  const first = request(["old-a"], true)
  await firstPending
  await request(["old-a", "old-b"], false)
  releaseFirst?.()
  await first
  await runWithModelFallback({ conversationKey: "concurrent" }, async () => {
    const payload = applyModelFallbackToPayload(
      original(["old-a", "old-b", "new-target"]),
    )
    expect(payload.input).toEqual([
      { type: "reasoning", encrypted_content: "new-target" },
    ])
  })
})

afterEach(() => {
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
})

function remappedProvider(upstreamModel: string) {
  return {
    customProviders: [
      {
        id: "remapped-provider",
        name: "Remapped provider",
        type: "openai-compatible" as const,
        baseUrl: "https://provider.example/v1",
        models: [
          { id: upstreamModel, aliases: ["target"], kind: "chat" as const },
        ],
      },
    ],
  }
}

test("repointing a provider alias re-evaluates a stored route before forwarding old target thinking", async () => {
  setConfigForTest(remappedProvider("old-upstream"))
  setModelFallbackConfigForTest(config)
  await fakeRequest({ conversationKey: "alias-remap" })
  setConfigForTest(remappedProvider("new-upstream"))
  const sent: Array<{ model: string; input: Array<Record<string, unknown>> }> =
    []
  await runWithModelFallback({ conversationKey: "alias-remap" }, async () => {
    const payload = applyModelFallbackToPayload({
      model: "source",
      input: [
        {
          type: "reasoning",
          encrypted_content: "thinking-issued-by-old-upstream",
        },
      ],
    })
    sent.push(payload)
    const response = new Response(null, {
      status: payload.model === "source" ? 422 : 200,
    })
    await recordModelFallbackResponse(response)
    if (!response.ok) throw new HTTPError("upstream", response)
  })
  expect(sent.map((payload) => payload.model)).toEqual(["source", "target"])
  expect(sent[1]?.input).toEqual([])
})

test("switches any upstream HTTP 422 once and preserves fallback thinking on the next turn", async () => {
  setModelFallbackConfigForTest(config)
  const sent: Array<{
    model: string
    messages: Array<Record<string, unknown>>
  }> = []
  const request = async (signature: string) =>
    await runWithModelFallback(
      {
        headers: new Headers({
          authorization: "Bearer client-a",
          "thread-id": "thread",
        }),
      },
      async () => {
        const payload = applyModelFallbackToPayload({
          model: "source",
          messages: [
            {
              role: "assistant",
              content: "answer",
              reasoning_text: "reasoning",
              reasoning_opaque: signature,
            },
          ],
        })
        sent.push(payload)
        const response =
          payload.model === "source" ?
            new Response("arbitrary", { status: 422 })
          : Response.json({ ok: true })
        await recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
        return payload.model
      },
    )
  expect(await request("old-signature")).toBe("target")
  expect(await request("fallback-signature")).toBe("target")
  expect(sent.map((payload) => payload.model)).toEqual([
    "source",
    "target",
    "target",
  ])
  expect(sent[1].messages[0]).toEqual({ role: "assistant", content: "answer" })
  expect(sent[2].messages[0].reasoning_opaque).toBe("fallback-signature")
})

test.each([400, 401, 403, 408, 429, 500, 502, 503, 504])(
  "never switches HTTP %s",
  async (status) => {
    setModelFallbackConfigForTest(config)
    let attempts = 0
    await expect(
      runWithModelFallback({}, async () => {
        attempts++
        applyModelFallbackToPayload({ model: "source" })
        const response = new Response("failure", { status })
        await recordModelFallbackResponse(response)
        throw new HTTPError("upstream", response)
      }),
    ).rejects.toBeInstanceOf(HTTPError)
    expect(attempts).toBe(1)
  },
)

test.each([
  new Error("network error"),
  new DOMException("timeout", "TimeoutError"),
  new DOMException("aborted", "AbortError"),
])("never switches transport errors", async (error) => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await expect(
    runWithModelFallback({}, async () => {
      attempts++
      applyModelFallbackToPayload({ model: "source" })
      throw error
    }),
  ).rejects.toBe(error)
  expect(attempts).toBe(1)
})

test("does not retry synthetic or local 422 errors", async () => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await expect(
    runWithModelFallback({}, async () => {
      attempts++
      applyModelFallbackToPayload({ model: "source" })
      const response = Response.json({ error: "local" }, { status: 422 })
      throw new LocalHTTPError("local", response, { error: "local" })
    }),
  ).rejects.toBeInstanceOf(LocalHTTPError)
  expect(attempts).toBe(1)
})

test("isolates child threads and credentials despite a shared parent session", async () => {
  setModelFallbackConfigForTest(config)
  const sent: Array<string> = []
  const request = (thread: string, credential: string) =>
    runWithModelFallback(
      {
        headers: new Headers({
          authorization: `Bearer ${credential}`,
          "session-id": "parent",
          "x-codex-parent-thread-id": "parent",
        }),
        payload: {
          client_metadata: { session_id: "parent", thread_id: thread },
        },
      },
      async () => {
        const payload = applyModelFallbackToPayload({ model: "source" })
        sent.push(payload.model)
        const response = new Response(null, {
          status: payload.model === "source" ? 422 : 200,
        })
        await recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
        return payload.model
      },
    )
  await request("child-a", "client-a")
  await request("child-a", "client-a")
  await request("child-b", "client-a")
  await request("child-a", "client-b")
  expect(sent).toEqual([
    "source",
    "target",
    "target",
    "source",
    "target",
    "source",
    "target",
  ])
})

test("without identity repeats the 422 attempt on each request", async () => {
  setModelFallbackConfigForTest(config)
  const sent: Array<string> = []
  const request = () =>
    runWithModelFallback({}, async () => {
      const payload = applyModelFallbackToPayload({ model: "source" })
      sent.push(payload.model)
      const response = new Response(null, {
        status: payload.model === "source" ? 422 : 200,
      })
      await recordModelFallbackResponse(response)
      if (!response.ok) throw new HTTPError("upstream", response)
      return payload.model
    })
  await request()
  await request()
  expect(sent).toEqual(["source", "target", "source", "target"])
})
