import { describe, expect, test } from "bun:test"

import {
  initialResponseInspectorViewState,
  metadataItemKey,
  responseBodyLanguage,
  responseInspectorViewState,
} from "../ui/src/lib/response-inspector"

describe("response inspector state", () => {
  test("resets view state synchronously for a distinct response identity", () => {
    const previous = {
      responseId: "response-a",
      selectedEvent: 4,
      tab: "raw" as const,
    }

    expect(responseInspectorViewState(previous, "response-a")).toBe(previous)
    expect(responseInspectorViewState(previous, "response-b")).toEqual(
      initialResponseInspectorViewState("response-b"),
    )
  })

  test("selects raw syntax highlighting without parsing the body", () => {
    expect(responseBodyLanguage('  {"ok":true}', {})).toBe("json")
    expect(
      responseBodyLanguage("true", { "Content-Type": "application/json" }),
    ).toBe("json")
    expect(responseBodyLanguage('data: {"ok":true}\n\n', {})).toBe("text")
  })

  test("gives repeated metadata labels distinct source-index keys", () => {
    expect(metadataItemKey("copilot-usage", "input", 0)).not.toBe(
      metadataItemKey("copilot-usage", "input", 1),
    )
    expect(metadataItemKey("token-usage", "input", 0)).not.toBe(
      metadataItemKey("copilot-usage", "input", 0),
    )
  })
})
