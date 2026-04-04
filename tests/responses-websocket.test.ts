import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import {
  extractResponsesPayload,
  isSyntheticWarmupRequest,
  rehydrateWarmupPayload,
} from "../src/routes/responses/websocket"

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

describe("responses websocket warmup handling", () => {
  test("detects generate=false Codex prewarm requests", () => {
    expect(
      isSyntheticWarmupRequest({
        model: "gpt-5.4",
        instructions: "You are Codex.",
        input: [],
        tools: [],
        generate: false,
        stream: true,
      }),
    ).toBe(true)

    expect(
      isSyntheticWarmupRequest({
        model: "gpt-5.4",
        instructions: "You are Codex.",
        input: [],
        tools: [],
        stream: true,
      }),
    ).toBe(false)
  })

  test("rehydrates follow-up requests that reference a synthetic warmup", () => {
    const warmupPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the failing tests." }],
        },
      ],
      tools: [],
      generate: false,
      stream: true,
    }

    const followUpPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      previous_response_id: "warmup_123",
      input: [],
      tools: [],
      stream: true,
    }

    expect(
      rehydrateWarmupPayload(warmupPayload, followUpPayload),
    ).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: warmupPayload.input,
      tools: [],
      stream: true,
    })

    const startupWarmup: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [],
      tools: [],
      generate: false,
      stream: true,
    }
    const firstTurnPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      previous_response_id: "warmup_456",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      tools: [],
      stream: true,
    }

    expect(
      rehydrateWarmupPayload(startupWarmup, firstTurnPayload),
    ).toMatchObject({
      input: firstTurnPayload.input,
      stream: true,
    })
  })
})
