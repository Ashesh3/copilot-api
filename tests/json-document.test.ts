import { describe, expect, test } from "bun:test"

import {
  findJsonDocumentDiagnostic,
  formatJsonDocument,
  prepareReplayDocument,
  validateReplayDocument,
} from "../ui/src/lib/json-document"

describe("JSON document helpers", () => {
  test("formats valid JSON with two spaces while preserving key order", () => {
    expect(formatJsonDocument('{"z":1,"model":"gpt-test","a":true}')).toBe(
      '{\n  "z": 1,\n  "model": "gpt-test",\n  "a": true\n}',
    )
  })

  test("preserves malformed replay source exactly", () => {
    expect(prepareReplayDocument('{"model":')).toBe('{"model":')
  })

  test("reports the first JSON syntax error with its location", () => {
    const diagnostic = findJsonDocumentDiagnostic(
      '{\n  "model": "gpt-test",\n}',
    )

    expect(diagnostic).not.toBeNull()
    if (!diagnostic) throw new Error("Expected a syntax diagnostic")

    expect(diagnostic.line).toBe(3)
    expect(diagnostic.column).toBeGreaterThan(0)
    expect(diagnostic.kind).toBe("syntax")
    expect(diagnostic.message).toContain("Invalid JSON at line 3")
  })

  test("rejects a replay body whose root is not an object", () => {
    const validation = validateReplayDocument('["gpt-test"]')

    expect(validation.ok).toBe(false)
    if (validation.ok) throw new Error("Expected root validation to fail")

    expect(validation.diagnostic.message).toBe(
      "Replay body must be a JSON object.",
    )
    expect(validation.diagnostic.kind).toBe("root")
  })

  test("rejects a replay body without a nonblank model", () => {
    const validation = validateReplayDocument('{"model":"  ","input":[]}')

    expect(validation.ok).toBe(false)
    if (validation.ok) throw new Error("Expected model validation to fail")

    expect(validation.diagnostic.message).toBe("model is required.")
    expect(validation.diagnostic.kind).toBe("model")
  })

  test("accepts a replay object with a nonblank model", () => {
    const validation = validateReplayDocument(
      '{"model":"gpt-test","stream":true}',
    )

    expect(validation.ok).toBe(true)
    if (!validation.ok) throw new Error("Expected replay validation to pass")

    expect(validation.value).toEqual({ model: "gpt-test", stream: true })
  })
})
