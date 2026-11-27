import { afterEach, expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { interceptEngine } from "~/lib/intercept/engine"
import { deferUntilResponseDecided } from "~/lib/intercept/send-owner"
import {
  interceptLogicalSend,
  interceptUpstreamSend,
  type UpstreamSend,
} from "~/lib/intercept/upstream"

afterEach(() => {
  interceptEngine.resetForTest()
})

const SEND: Omit<UpstreamSend, "body"> = {
  method: "POST",
  path: "/chat/completions",
  url: "https://api.githubcopilot.com/chat/completions",
  upstream: "copilot",
  headers: {},
}

function chatBody(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "gpt-4o",
    ...extra,
    messages: [{ role: "user", content }],
  })
}

function nextQueued(): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const unsubscribe = interceptEngine.subscribe((event) => {
    if (event.type !== "queued") return
    unsubscribe()
    resolve(event.item.id)
  })
  return promise
}

function recorder() {
  const sent: Array<string | undefined> = []
  const send = (body: string | undefined) => {
    sent.push(body)
    return Promise.resolve(Response.json({ ok: true }))
  }
  return { sent, send }
}

async function holdAndApprove(
  body: string,
  approved: string,
  send: (body: string | undefined) => Promise<Response>,
): Promise<void> {
  const queued = nextQueued()
  const first = interceptUpstreamSend({ ...SEND, body }, send)
  interceptEngine.forwardItem(await queued, { body: approved })
  await first
}

async function logicalSend(work: () => Promise<void>): Promise<void> {
  await interceptLogicalSend(async () => {
    await work()
    return { response: Response.json({ ok: true }) }
  })
}

test("resends carry the operator's approval instead of being held again", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { sent, send } = recorder()
  const original = chatBody("original", { reasoning_effort: "high" })
  const approved = chatBody("approved", { reasoning_effort: "high" })

  await logicalSend(async () => {
    await holdAndApprove(original, approved, send)
    // Account failover resends the same body.
    await interceptUpstreamSend(
      { ...SEND, body: original, reason: "failover" },
      send,
    )
    // A compatibility retry drops a field the operator did not edit.
    await interceptUpstreamSend(
      { ...SEND, body: chatBody("original"), reason: "compatibility_retry" },
      send,
    )
  })

  expect(sent).toEqual([approved, approved, chatBody("approved")])
  expect(interceptEngine.getSnapshot().recent).toHaveLength(1)
})

test("approvals keep replaying after Intercept is turned off", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { sent, send } = recorder()
  const approved = chatBody("approved")

  await logicalSend(async () => {
    await holdAndApprove(chatBody("original"), approved, send)
    interceptEngine.updateConfig({ enabled: false })
    await interceptUpstreamSend(
      { ...SEND, body: chatBody("original"), reason: "failover" },
      send,
    )
  })

  expect(sent).toEqual([approved, approved])
})

test("another logical request never inherits an approval", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()

  await logicalSend(async () => {
    await holdAndApprove(chatBody("original"), chatBody("approved"), send)
  })
  await logicalSend(async () => {
    const queued = nextQueued()
    const resend = interceptUpstreamSend(
      { ...SEND, body: chatBody("original"), reason: "failover" },
      send,
    )
    interceptEngine.forwardItem(await queued)
    await resend
  })

  expect(interceptEngine.getSnapshot().recent).toHaveLength(2)
})

test("a resend that changed what the operator edited is reviewed again", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()

  await logicalSend(async () => {
    await holdAndApprove(chatBody("original"), chatBody("approved"), send)
    const queued = nextQueued()
    const resend = interceptUpstreamSend(
      { ...SEND, body: chatBody("rewritten"), reason: "compatibility_retry" },
      send,
    )
    interceptEngine.forwardItem(await queued)
    await resend
  })

  expect(interceptEngine.getSnapshot().recent).toHaveLength(2)
})

test("a new request in the same logical send is reviewed again", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()

  await logicalSend(async () => {
    await holdAndApprove(chatBody("round 1"), chatBody("edited"), send)
    const queued = nextQueued()
    const next = interceptUpstreamSend(
      { ...SEND, body: chatBody("round 1") },
      send,
    )
    interceptEngine.forwardItem(await queued)
    await next
  })

  expect(interceptEngine.getSnapshot().recent).toHaveLength(2)
})

test("replay never writes through an inherited __proto__", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()
  const original = '{"__proto__":{"polluted":1},"model":"gpt-4o","x":"a"}'
  const approved = '{"__proto__":{"polluted":2},"model":"gpt-4o","x":"a"}'

  await logicalSend(async () => {
    await holdAndApprove(original, approved, send)
    // The retry body has no own __proto__ to edit, so it is reviewed again.
    const queued = nextQueued()
    const resend = interceptUpstreamSend(
      {
        ...SEND,
        body: '{"model":"gpt-4o","x":"a"}',
        reason: "compatibility_retry",
      },
      send,
    )
    interceptEngine.forwardItem(await queued)
    await resend
  })

  expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false)
  expect(interceptEngine.getSnapshot().recent).toHaveLength(2)
})

test("an approved __proto__ key is replayed as an own property", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { sent, send } = recorder()

  await logicalSend(async () => {
    await holdAndApprove(
      '{"model":"gpt-4o","drop":1}',
      '{"model":"gpt-4o","drop":1,"__proto__":{"polluted":true}}',
      send,
    )
    await interceptUpstreamSend(
      { ...SEND, body: '{"model":"gpt-4o"}', reason: "compatibility_retry" },
      send,
    )
  })

  expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false)
  expect(sent.at(-1)).toBe('{"model":"gpt-4o","__proto__":{"polluted":true}}')
})

function holdEachResponse(statuses: Array<number>): () => void {
  return interceptEngine.subscribe((event) => {
    if (event.type !== "queued") return
    statuses.push(event.item.responseStatus ?? 0)
    interceptEngine.forwardItem(event.item.id)
  })
}

async function failoverLoop(): Promise<Response> {
  const { response } = await interceptLogicalSend(async () => {
    await interceptUpstreamSend({ ...SEND, body: chatBody("hi") }, () =>
      Promise.resolve(Response.json({ error: "busy" }, { status: 429 })),
    )
    interceptEngine.updateConfig({ enabled: true })
    return {
      response: await interceptUpstreamSend(
        { ...SEND, body: chatBody("hi"), reason: "failover" },
        () => Promise.resolve(Response.json({ ok: true })),
      ),
    }
  })
  return response
}

test("a retry loop holds only the response it settles on", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "response" })
  const statuses: Array<number> = []
  const unsubscribe = holdEachResponse(statuses)

  const response = await failoverLoop()
  unsubscribe()

  expect(response.status).toBe(200)
  expect(statuses).toEqual([200])
})

test("turning Intercept on mid-loop still holds only the settled response", async () => {
  interceptEngine.updateConfig({ enabled: false, direction: "response" })
  const statuses: Array<number> = []
  const unsubscribe = holdEachResponse(statuses)

  const response = await failoverLoop()
  unsubscribe()

  expect(response.status).toBe(200)
  expect(statuses).toEqual([200])
})

function responsesInput(items: Array<string>): string {
  return JSON.stringify({
    model: "gpt-4o",
    input: items.map((content) => ({ content })),
  })
}

test("an index edit replays only while its array is unchanged", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()
  const input = responsesInput

  await logicalSend(async () => {
    await holdAndApprove(input(["a", "b"]), input(["a", "B"]), send)
    // A memory-rollout retry dropped the first entry: index 1 moved.
    const queued = nextQueued()
    const resend = interceptUpstreamSend(
      { ...SEND, body: input(["b", "c"]), reason: "compatibility_retry" },
      send,
    )
    interceptEngine.forwardItem(await queued)
    await resend
  })

  expect(interceptEngine.getSnapshot().recent).toHaveLength(2)
})

test("a conflicting retry is not sent once Intercept is off", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { sent, send } = recorder()
  let failure: unknown

  await logicalSend(async () => {
    await holdAndApprove(chatBody("original"), chatBody("approved"), send)
    interceptEngine.updateConfig({ enabled: false })
    failure = await interceptUpstreamSend(
      { ...SEND, body: chatBody("rewritten"), reason: "compatibility_retry" },
      send,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
  })

  expect(failure).toBeInstanceOf(LocalHTTPError)
  if (failure instanceof LocalHTTPError) {
    expect(failure.response.status).toBe(409)
  }
  expect(sent).toEqual([chatBody("approved")])
})

test("a conflicting retry that is no longer held is not sent", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { sent, send } = recorder()
  let failure: unknown

  await logicalSend(async () => {
    await holdAndApprove(chatBody("original"), chatBody("approved"), send)
    // Still on, but the filters no longer match, so nobody reviews the retry.
    interceptEngine.updateConfig({
      filters: {
        enabled: true,
        matchMode: "all",
        conditions: [
          {
            id: "only-original",
            enabled: true,
            field: "requestBody",
            operator: "contains",
            value: "original",
          },
        ],
      },
    })
    failure = await interceptUpstreamSend(
      { ...SEND, body: chatBody("rewritten"), reason: "compatibility_retry" },
      send,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
  })

  expect(failure).toBeInstanceOf(LocalHTTPError)
  expect(sent).toEqual([chatBody("approved")])
})

test("a response is held when Intercept turns on during its send", async () => {
  interceptEngine.updateConfig({ enabled: false, direction: "response" })
  const statuses: Array<number> = []
  const unsubscribe = holdEachResponse(statuses)

  await interceptLogicalSend(async () => ({
    response: await interceptUpstreamSend(
      { ...SEND, body: chatBody("hi") },
      () => {
        interceptEngine.updateConfig({ enabled: true })
        return Promise.resolve(Response.json({ ok: true }))
      },
    ),
  }))
  unsubscribe()

  expect(statuses).toEqual([200])
})

test("deferred bookkeeping sees only the response the operator lets through", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "response" })
  const settled: Array<string> = []
  const loop = () =>
    interceptLogicalSend(async () => {
      const response = await interceptUpstreamSend(
        { ...SEND, body: chatBody("hi") },
        () => Promise.resolve(Response.json({ ok: true })),
      )
      deferUntilResponseDecided(settled, async (decided) => {
        settled.push(await decided.clone().text())
        return decided
      })
      return { response }
    })

  const unsubscribe = interceptEngine.subscribe((event) => {
    if (event.type !== "queued") return
    if (settled.length === 0) interceptEngine.dropItem(event.item.id)
    else interceptEngine.forwardItem(event.item.id, { body: '{"ok":"edited"}' })
  })
  await loop().catch(() => undefined)
  settled.push("after drop")
  await loop()
  unsubscribe()

  expect(settled).toEqual(["after drop", '{"ok":"edited"}'])
})

test("responses to multipart requests are held with their routed model", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "response" })
  const queued = nextQueued()
  const pending = interceptUpstreamSend(
    {
      ...SEND,
      path: "/v1/images/edits",
      body: new Uint8Array([1, 2, 3]),
      model: "gpt-image-1",
    },
    () => Promise.resolve(Response.json({ data: [] })),
  )

  const item = interceptEngine.getItem(await queued)
  expect(item?.phase).toBe("response")
  expect(item?.model).toBe("gpt-image-1")
  interceptEngine.forwardAllPending()
  expect((await pending).status).toBe(200)
})
