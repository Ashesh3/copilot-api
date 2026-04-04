import { describe, expect, test } from "bun:test"

import { extractResponsesPayload } from "../src/routes/responses/websocket"

describe("extractResponsesPayload", () => {
  test("merges top-level continuation fields with nested response payload", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      previous_response_id: "resp_prev",
      response: {
        model: "gpt-5.4",
        stream: true,
      },
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.stream).toBe(true)
    expect(payload.previous_response_id).toBe("resp_prev")
  })

  test("uses top-level payload when nested response object is absent", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      model: "gpt-5.4",
      input: "hello",
      stream: true,
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.input).toBe("hello")
    expect((payload as unknown as Record<string, unknown>).type).toBeUndefined()
  })

  test("prefers nested response values when keys overlap", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      model: "gpt-5-mini",
      response: {
        model: "gpt-5.4",
        input: "hello",
      },
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.input).toBe("hello")
  })
})
