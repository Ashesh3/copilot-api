/* eslint-disable @typescript-eslint/require-await -- Transport fixtures resolve immediately. */
import { expect, test } from "bun:test"

import { webDocuments } from "~/services/web/document-store"
import { executeWebFetch } from "~/services/web/fetch-page"
import {
  runWithWebTools,
  prepareManagedWebTools,
} from "~/services/web/tool-context"
import { executeManagedWebCall } from "~/services/web/tool-executor"

test("cached fetches enforce domain filters, pagination, token limits, and stable references", async () => {
  const page = await executeWebFetch(
    { url: "https://pages.test/" },
    { request: async () => new Response("test ".repeat(800)) },
  )
  if (!page.ok) throw new Error("Expected page")
  const reference = webDocuments.put("cached", page.document)
  if (!reference) throw new Error("Expected reference")
  const source = {
    tools: [{ type: "web_fetch", name: "web_fetch", max_content_tokens: 3 }],
  }
  await runWithWebTools(source, "cached", async () => {
    const prepared = prepareManagedWebTools(source, "messages")
    const tool = prepared.managed.get("web_fetch")
    if (!tool || !prepared.context) throw new Error("Missing tool")
    const options = { context: prepared.context }
    const call = { id: "c", name: "web_fetch", input: { url: reference } }
    const first = await executeManagedWebCall(call, tool, options)
    expect(first.isError).toBe(false)
    const parsed = JSON.parse(first.text) as {
      content: string
      reference: string
    }
    expect(parsed.content.length).toBeLessThan(40)
    expect(parsed.reference).toBe(reference)
    expect(
      (
        await executeManagedWebCall(
          { ...call, input: { url: reference, start_index: -1 } },
          tool,
          options,
        )
      ).isError,
    ).toBe(true)
    const blocked = await executeManagedWebCall(
      call,
      { ...tool, limits: { allowedDomains: ["allowed.test"] } },
      options,
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain("url_not_allowed")
  })
})

test("token-capped fetch content is an exact Unicode prefix with a lossless continuation", async () => {
  const text = "😁😎🎉🎉漢字é".repeat(30)
  const result = await executeWebFetch(
    { url: "https://pages.test/" },
    {
      limits: { maxContentTokens: 5 },
      request: async () => new Response(text),
    },
  )
  if (!result.ok) throw new Error("Expected page")
  expect(text.startsWith(result.content)).toBe(true)
  expect(
    result.content + text.slice(result.next_start_index ?? text.length),
  ).toBe(text)
  expect(result.content).not.toContain("\uFFFD")
})
