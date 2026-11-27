import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import { interceptEngine } from "~/lib/intercept/engine"
import {
  handleApplyInterceptAssistant,
  handleEditInterceptItem,
  handleForwardInterceptItem,
} from "~/routes/dashboard/intercept"

const app = new Hono()
app.put("/items/:id", handleEditInterceptItem)
app.post("/items/:id/forward", handleForwardInterceptItem)
app.post("/items/:id/assistant/apply", handleApplyInterceptAssistant)

afterEach(() => {
  interceptEngine.resetForTest()
})

function holdRequest(): { id: string; outcome: Promise<unknown> } {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  const outcome = interceptEngine.interceptRequest({
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot",
    headers: {},
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "original" }],
    }),
  })
  const held = interceptEngine.getSnapshot().pending.at(0)
  if (!held) throw new Error("Nothing is held")
  return { id: held.id, outcome }
}

async function send(method: string, path: string, body: string) {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body,
  })
  await response.body?.cancel()
  return { status: response.status }
}

test("a malformed forward body leaves the item held", async () => {
  const { id, outcome } = holdRequest()

  const result = await send("POST", `/items/${id}/forward`, '{"body": ')

  expect(result.status).toBe(400)
  expect(interceptEngine.getSnapshot().pending).toHaveLength(1)
  interceptEngine.forwardAllPending()
  await outcome
})

test("a malformed operation selection applies nothing", async () => {
  const { id, outcome } = holdRequest()

  const result = await send(
    "POST",
    `/items/${id}/assistant/apply`,
    JSON.stringify({ operations: [{ op: "replace" }] }),
  )

  expect(result.status).toBe(400)
  expect(interceptEngine.getItem(id)?.revision).toBe(0)
  interceptEngine.forwardAllPending()
  await outcome
})

test("structured edits must name the revision they were made from", async () => {
  const { id, outcome } = holdRequest()
  const item = interceptEngine.getItem(id)
  if (!item) throw new Error("Item is not held")
  const canonicalItems = item.canonical.items

  const missing = await send(
    "PUT",
    `/items/${id}`,
    JSON.stringify({ canonicalItems }),
  )
  interceptEngine.editPendingItem(id, {
    body: item.currentBody.replace("original", "newer"),
  })
  const stale = await send(
    "PUT",
    `/items/${id}`,
    JSON.stringify({ canonicalItems, baseRevision: 0 }),
  )

  expect(missing.status).toBe(400)
  expect(stale.status).toBe(409)
  expect(interceptEngine.getItem(id)?.currentBody).toContain("newer")
  interceptEngine.forwardAllPending()
  await outcome
})
