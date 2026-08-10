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

  test("preserves integer-like property order while formatting", () => {
    expect(formatJsonDocument('{"2":"second","1":"first"}')).toBe(
      '{\n  "2": "second",\n  "1": "first"\n}',
    )
  })

  test("preserves unsafe integer lexemes while formatting", () => {
    expect(
      formatJsonDocument('{"model":"gpt-test","value":9007199254740993}'),
    ).toBe('{\n  "model": "gpt-test",\n  "value": 9007199254740993\n}')
  })

  test("preserves overflowing exponent lexemes while formatting", () => {
    expect(formatJsonDocument('{"model":"gpt-test","value":1e400}')).toBe(
      '{\n  "model": "gpt-test",\n  "value": 1e400\n}',
    )
  })

  test("preserves string escape lexemes while formatting", () => {
    const escapedLexeme = String.raw`\u0061\/\n`

    expect(
      formatJsonDocument(`{"model":"gpt-test","escaped":"${escapedLexeme}"}`),
    ).toBe(`{\n  "model": "gpt-test",\n  "escaped": "${escapedLexeme}"\n}`)
  })

  test("formats whitespace-only empty containers without adding lines", () => {
    expect(
      formatJsonDocument('{"model":"gpt-test","object": { }, "array": [ ]}'),
    ).toBe('{\n  "model": "gpt-test",\n  "object": {},\n  "array": []\n}')
  })

  test("preserves malformed replay source exactly", () => {
    expect(prepareReplayDocument('{"model":')).toBe('{"model":')
  })

  test("preserves valid replay source exactly until formatting is explicit", () => {
    const source = ` {\r\n\t"model" : "gpt-test", "api_key" : "body-secret"\r\n}\r\n`

    expect(prepareReplayDocument(source)).toBe(source)
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

  test("maps LF, CRLF, and CR syntax errors to exact locations", () => {
    const cases = [
      {
        expected: { column: 1, from: 25, line: 3, to: 26 },
        raw: '{\n  "model": "gpt-test",\n}',
      },
      {
        expected: { column: 1, from: 27, line: 3, to: 28 },
        raw: '{\r\n  "model": "gpt-test",\r\n}',
      },
      {
        expected: { column: 1, from: 25, line: 3, to: 26 },
        raw: '{\r  "model": "gpt-test",\r}',
      },
    ]

    for (const { expected, raw } of cases) {
      const diagnostic = findJsonDocumentDiagnostic(raw)
      expect(diagnostic).not.toBeNull()
      if (!diagnostic) throw new Error("Expected a syntax diagnostic")

      expect({
        column: diagnostic.column,
        from: diagnostic.from,
        line: diagnostic.line,
        to: diagnostic.to,
      }).toEqual(expected)
    }
  })

  test("returns the first of multiple syntax errors", () => {
    const diagnostic = findJsonDocumentDiagnostic('{"a":,"b":}')

    expect(diagnostic).not.toBeNull()
    if (!diagnostic) throw new Error("Expected a syntax diagnostic")

    expect({
      column: diagnostic.column,
      from: diagnostic.from,
      line: diagnostic.line,
      to: diagnostic.to,
    }).toEqual({ column: 6, from: 5, line: 1, to: 6 })
  })

  test("clamps an EOF syntax error to a zero-length range", () => {
    const diagnostic = findJsonDocumentDiagnostic('{"model":')

    expect(diagnostic).not.toBeNull()
    if (!diagnostic) throw new Error("Expected a syntax diagnostic")

    expect({
      column: diagnostic.column,
      from: diagnostic.from,
      line: diagnostic.line,
      to: diagnostic.to,
    }).toEqual({ column: 10, from: 9, line: 1, to: 9 })
  })

  test("uses a zero-length syntax diagnostic for an empty document", () => {
    const diagnostic = findJsonDocumentDiagnostic("")

    expect(diagnostic).not.toBeNull()
    if (!diagnostic) throw new Error("Expected a syntax diagnostic")

    expect({
      column: diagnostic.column,
      from: diagnostic.from,
      line: diagnostic.line,
      to: diagnostic.to,
    }).toEqual({ column: 1, from: 0, line: 1, to: 0 })
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
