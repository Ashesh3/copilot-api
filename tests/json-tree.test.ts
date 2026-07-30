import { describe, expect, test } from "bun:test"

import {
  JSON_CHILD_PAGE_SIZE,
  collectJsonContainerPaths,
  escapeJsonPointerSegment,
  hasJsonEntries,
  initialJsonContainerPaths,
  jsonCopyErrorMessage,
  jsonEntryPage,
  jsonExpandedPathsForDocument,
  jsonPaginationButtonForTreeItem,
  jsonPointerPath,
  jsonVisibleCountForValue,
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

  test("only activates a direct button on a marked pagination tree item", () => {
    let clicks = 0
    const directButton = {
      click: () => {
        clicks += 1
      },
      tagName: "BUTTON",
    }
    const nestedButton = {
      children: [directButton],
      tagName: "DIV",
    }

    expect(
      jsonPaginationButtonForTreeItem({
        children: [directButton],
        dataset: {},
      }),
    ).toBeNull()
    expect(
      jsonPaginationButtonForTreeItem({
        children: [nestedButton],
        dataset: { jsonPagination: "true" },
      }),
    ).toBeNull()

    const button = jsonPaginationButtonForTreeItem({
      children: [directButton],
      dataset: { jsonPagination: "true" },
    })
    expect(button).not.toBeNull()
    if (!button) throw new Error("Expected direct pagination button")
    button.click()
    expect(clicks).toBe(1)
  })

  test("derives paging synchronously from the JSON value identity", () => {
    const storedValue = Array.from({ length: 600 }, (_, index) => index)
    const nextValue = Array.from({ length: 600 }, (_, index) => index)
    const storedState = { value: storedValue, visibleCount: 500 }

    expect(jsonVisibleCountForValue(storedState, storedValue)).toBe(500)
    expect(jsonVisibleCountForValue(storedState, nextValue)).toBe(
      JSON_CHILD_PAGE_SIZE,
    )
  })

  test("derives disclosure synchronously from the document identity", () => {
    const firstValue = { input: [{ content: "first" }] }
    const nextValue = { input: [{ content: "next" }] }
    const currentPaths = new Set(["#", "#/input", "#/input/0"])
    const nextInitialPaths = initialJsonContainerPaths(nextValue, false)
    const storedState = {
      expandedPaths: currentPaths,
      isLarge: false,
      value: firstValue,
    }

    expect(
      jsonExpandedPathsForDocument(
        storedState,
        { isLarge: false, value: firstValue },
        nextInitialPaths,
      ),
    ).toBe(currentPaths)
    expect(
      jsonExpandedPathsForDocument(
        storedState,
        { isLarge: false, value: nextValue },
        nextInitialPaths,
      ),
    ).toBe(nextInitialPaths)
  })

  test("derives disclosure synchronously from the document scale", () => {
    const value = { input: [{ content: "hello" }] }
    const currentPaths = new Set(["#", "#/input", "#/input/0"])
    const largeInitialPaths = initialJsonContainerPaths(value, true)

    expect(
      jsonExpandedPathsForDocument(
        { expandedPaths: currentPaths, isLarge: false, value },
        { isLarge: true, value },
        largeInitialPaths,
      ),
    ).toBe(largeInitialPaths)
  })

  test("normalizes clipboard failures for accessible feedback", () => {
    expect(jsonCopyErrorMessage(new Error("Clipboard permission denied"))).toBe(
      "Clipboard permission denied",
    )
    expect(jsonCopyErrorMessage(new Error(""))).toBe("Copy failed")
    expect(jsonCopyErrorMessage("Clipboard permission denied")).toBe(
      "Copy failed",
    )
  })
})
