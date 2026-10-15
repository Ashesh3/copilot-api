/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import { expect, test } from "bun:test"

import { dispatchWebCommands } from "~/routes/codex-search/web-commands"

test("long unbroken lines are fully recoverable through stable line continuation", async () => {
  const deps = {
    fetch: async () => new Response("A".repeat(12000) + "TAIL"),
    search: async () => "SEARCH",
  }
  let result = await dispatchWebCommands(
    { open: [{ ref_id: "https://pages.test/long" }], response_length: "short" },
    "long",
    deps,
  )
  let seen = result
  let rounds = 0
  while (result.includes("More content:")) {
    const ref = result.match(/capi_fetch_[a-z0-9]+/)?.[0]
    const line = Number(result.match(/at lineno (\d+)/)?.[1])
    expect(result.length).toBeLessThanOrEqual(5000)
    result = await dispatchWebCommands(
      { open: [{ ref_id: ref, lineno: line }], response_length: "short" },
      "long",
      deps,
    )
    seen += result
    if (++rounds > 8) throw new Error("Pagination failed to advance")
  }
  expect(seen).toContain("TAIL")
  expect(rounds).toBeGreaterThan(0)
})

test("Codex opens actual page content, finds text, and follows a real link", async () => {
  const fetches: Array<string> = []
  let searches = 0
  const deps = {
    fetch: async (url: URL) => {
      fetches.push(url.href)
      return new Response(
        '<html><head><title>Episodes</title></head><body><h1>Episodes</h1><p>Fame is episode one.</p><a href="/next">Next</a></body></html>',
        { headers: { "content-type": "text/html" } },
      )
    },
    search: async () => {
      searches++
      return "SEARCH"
    },
  }
  const opened = await dispatchWebCommands(
    { open: [{ ref_id: "https://pages.test/" }] },
    "scope-a",
    deps,
  )
  expect(opened).toContain("Fame is episode one")
  expect(searches).toBe(0)
  const ref = opened.match(/capi_fetch_[a-z0-9]+/)?.[0] ?? "missing"
  expect(
    await dispatchWebCommands(
      { find: [{ ref_id: ref, pattern: "Fame" }] },
      "scope-a",
      deps,
    ),
  ).toContain("Fame")
  expect(
    await dispatchWebCommands({ open: [{ ref_id: ref }] }, "scope-b", deps),
  ).toContain("reference_not_found")
  await dispatchWebCommands(
    { click: [{ ref_id: ref, id: 1 }] },
    "scope-a",
    deps,
  )
  expect(fetches).toEqual(["https://pages.test/", "https://pages.test/next"])
})

test("Codex keeps search-only output and does not convert a failed open to search", async () => {
  let searches = 0
  const deps = {
    fetch: async () => new Response("limited", { status: 429 }),
    search: async () => {
      searches++
      return "EXACT_SEARCH_RESULT"
    },
  }
  expect(
    await dispatchWebCommands(
      { search_query: [{ q: "query" }] },
      "search-scope",
      deps,
    ),
  ).toBe("EXACT_SEARCH_RESULT")
  expect(
    await dispatchWebCommands(
      { open: [{ ref_id: "https://pages.test/" }] },
      "search-scope",
      deps,
    ),
  ).toContain("too_many_requests")
  expect(searches).toBe(1)
})
