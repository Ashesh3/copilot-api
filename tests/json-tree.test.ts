import { describe, expect, test } from "bun:test"

import {
  JSON_CHILD_PAGE_SIZE,
  collectJsonContainerPaths,
  escapeJsonPointerSegment,
  hasJsonEntries,
  initialJsonContainerPaths,
  jsonEntryPage,
  jsonPointerPath,
  measureJsonDocument,
  parseJsonBody,
} from "../ui/src/lib/json-tree"

describe("JSON tree helpers", () => {
  test("parses and formats valid JSON without changing key order", () => {
    const parsed = parseJsonBody('{"z":1,"a":{"ok":true}}')

    expect(parsed?.formatted).toBe(
      '{\n  "z": 1,\n  "a": {\n    "ok": true\n  }\n}',
    )
    expect(parsed?.value).toEqual({ z: 1, a: { ok: true } })
  })

  test("returns null for malformed JSON", () => {
    expect(parseJsonBody('{"unfinished":')).toBeNull()
  })

  test("builds RFC 6901 pointer paths", () => {
    expect(escapeJsonPointerSegment("a~/b")).toBe("a~0~1b")
    expect(jsonPointerPath("#", "a~/b")).toBe("#/a~0~1b")
  })

  test("collects the root and first-level containers for initial disclosure", () => {
    const parsed = parseJsonBody(
      '{"request":{"headers":{"x":"y"},"body":[{"text":"hi"}]},"ok":true}',
    )
    expect(parsed).not.toBeNull()
    if (!parsed) throw new Error("Expected valid JSON")

    expect([...collectJsonContainerPaths(parsed.value, 1)]).toEqual([
      "#",
      "#/request",
    ])
    expect([...collectJsonContainerPaths(parsed.value)]).toEqual([
      "#",
      "#/request",
      "#/request/headers",
      "#/request/body",
      "#/request/body/0",
    ])
  })

  test("does not treat scalar or empty roots as expandable", () => {
    const scalar = parseJsonBody("42")
    const empty = parseJsonBody("{}")
    expect(scalar).not.toBeNull()
    expect(empty).not.toBeNull()
    if (!scalar || !empty) throw new Error("Expected valid JSON")

    expect(collectJsonContainerPaths(scalar.value).size).toBe(0)
    expect(collectJsonContainerPaths(empty.value).size).toBe(0)
  })

  test("pages large arrays without materializing every entry", () => {
    const value = Array.from({ length: 250 }, (_, index) => index)

    expect(JSON_CHILD_PAGE_SIZE).toBe(100)
    expect(jsonEntryPage(value, 100)).toEqual({
      entries: Array.from({ length: 100 }, (_, index) => [
        String(index),
        index,
      ]),
      remaining: 150,
      total: 250,
    })
    expect(jsonEntryPage(value, 200)).toEqual({
      entries: Array.from({ length: 200 }, (_, index) => [
        String(index),
        index,
      ]),
      remaining: 50,
      total: 250,
    })
  })

  test("detects whether a JSON container has entries", () => {
    expect(hasJsonEntries([])).toBe(false)
    expect(hasJsonEntries([1])).toBe(true)
    expect(hasJsonEntries({})).toBe(false)
    expect(hasJsonEntries({ model: "gpt-test" })).toBe(true)
  })

  test("stops measuring after the large document node threshold", () => {
    const value = Array.from({ length: 5_100 }, (_, index) => ({ index }))

    expect(measureJsonDocument(value, 1_024)).toEqual({
      exceededNodeThreshold: true,
      isLarge: true,
      nodeCount: 5_001,
    })
  })

  test("skips node traversal when the byte threshold is exceeded", () => {
    expect(measureJsonDocument({ model: "gpt-test" }, 250 * 1_024 + 1)).toEqual(
      {
        exceededNodeThreshold: false,
        isLarge: true,
        nodeCount: 1,
      },
    )
  })

  test("only expands the root initially for large JSON documents", () => {
    const value = { input: [{ content: "hello" }], model: "gpt-test" }

    expect([...initialJsonContainerPaths(value, true)]).toEqual(["#"])
    expect([...initialJsonContainerPaths(value, false)]).toEqual([
      "#",
      "#/input",
    ])
  })
})
