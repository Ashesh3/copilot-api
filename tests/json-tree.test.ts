import { describe, expect, test } from "bun:test"

import {
  collectJsonContainerPaths,
  escapeJsonPointerSegment,
  jsonPointerPath,
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

  test("does not auto-expand high-cardinality containers", () => {
    const parsed = parseJsonBody(JSON.stringify(Array.from({ length: 101 })))
    expect(parsed).not.toBeNull()
    if (!parsed) throw new Error("Expected valid JSON")

    expect([...collectJsonContainerPaths(parsed.value, 1, 100)]).toEqual([])
    expect([...collectJsonContainerPaths(parsed.value)]).toEqual(["#"])
  })
})
