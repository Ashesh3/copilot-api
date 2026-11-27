import { afterEach, expect, test } from "bun:test"

import { runWithInterceptApprovals } from "~/lib/intercept/approvals"
import { interceptEngine } from "~/lib/intercept/engine"
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

test("resends carry the operator's approval instead of being held again", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { sent, send } = recorder()
  const original = chatBody("original", { reasoning_effort: "high" })
  const approved = chatBody("approved", { reasoning_effort: "high" })

  await runWithInterceptApprovals(async () => {
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

test("a resend that changed what the operator edited is reviewed again", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()

  await runWithInterceptApprovals(async () => {
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

test("a new request in the same client request is reviewed again", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const { send } = recorder()

  await runWithInterceptApprovals(async () => {
    await holdAndApprove(chatBody("round 1"), chatBody("edited"), send)
    const queued = nextQueued()
    const next = interceptUpstreamSend(
      { ...SEND, body: chatBody("round 2") },
      send,
    )
    interceptEngine.forwardItem(await queued)
    await next
  })

  expect(interceptEngine.getSnapshot().recent).toHaveLength(2)
})

test("a retry loop holds only the response it settles on", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "response" })
  const statuses: Array<number> = []
  interceptEngine.subscribe((event) => {
    if (event.type !== "queued") return
    statuses.push(event.item.responseStatus ?? 0)
    interceptEngine.forwardItem(event.item.id)
  })

  const { response } = await interceptLogicalSend(async () => {
    await interceptUpstreamSend({ ...SEND, body: chatBody("hi") }, () =>
      Promise.resolve(Response.json({ error: "busy" }, { status: 429 })),
    )
    return {
      response: await interceptUpstreamSend(
        { ...SEND, body: chatBody("hi"), reason: "failover" },
        () => Promise.resolve(Response.json({ ok: true })),
      ),
    }
  })

  expect(response.status).toBe(200)
  expect(statuses).toEqual([200])
})

test("responses to multipart requests are still held", async () => {
  interceptEngine.updateConfig({ enabled: true, direction: "response" })
  const queued = nextQueued()
  const pending = interceptUpstreamSend(
    { ...SEND, path: "/v1/images/edits", body: new FormData() },
    () => Promise.resolve(Response.json({ data: [] })),
  )

  const item = interceptEngine.getItem(await queued)
  expect(item?.phase).toBe("response")
  interceptEngine.forwardAllPending()
  expect((await pending).status).toBe(200)
})
