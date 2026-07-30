import { describe, expect, test } from "bun:test"

import {
  acceptReplayResult,
  advanceReplayRun,
  advanceReplaySource,
  classifyReplayResult,
  initialReplayRunState,
  isCurrentReplayRun,
  isSameReplaySource,
  replayErrorMessage,
  replayResponse,
} from "../ui/src/lib/replay-result"

describe("replay result helpers", () => {
  test("accepts a successful replay", () => {
    expect(classifyReplayResult({ status: 200, statusText: "OK" })).toEqual({
      ok: true,
    })
  })

  test("rejects an upstream error response", () => {
    expect(
      classifyReplayResult({ status: 400, statusText: "Bad Request" }),
    ).toEqual({
      message: "Replay returned 400 Bad Request",
      ok: false,
    })
  })

  test("adapts a replay result to an inspectable HTTP response", () => {
    const result = {
      body: '{"id":"response-1"}',
      durationMs: 42,
      finishReason: "stop",
      headers: { "content-type": "application/json" },
      parsed: { id: "response-1" },
      responseId: "response-1",
      status: 201,
      statusText: "Created",
      streamEvents: [],
      usage: null,
    }

    expect(replayResponse(result)).toEqual({
      body: result.body,
      headers: result.headers,
      status: result.status,
      statusText: result.statusText,
    })
  })

  test("assigns every accepted replay a distinct inspection identity", () => {
    const result = {
      body: '{"id":"response-1"}',
      durationMs: 42,
      finishReason: "stop",
      headers: { "content-type": "application/json" },
      parsed: { id: "response-1" },
      responseId: "response-1",
      status: 200,
      statusText: "OK",
      streamEvents: [],
      usage: null,
    }
    const first = acceptReplayResult("entry-1", result)
    const second = acceptReplayResult("entry-1", result, first)

    expect(first.responseIdentity).toBe("entry-1-replay-1")
    expect(second.responseIdentity).toBe("entry-1-replay-2")
    expect(second.result).toBe(result)
  })

  test("compares source identity without constructing a body-derived key", () => {
    const source = { body: '{"model":"gpt"}', id: "entry-1" }

    expect(isSameReplaySource(source, "entry-1", source.body)).toBe(true)
    expect(isSameReplaySource(source, "entry-2", source.body)).toBe(false)
    expect(isSameReplaySource(source, "entry-1", '{"model":"codex"}')).toBe(
      false,
    )
    expect(isSameReplaySource(undefined, "entry-1", source.body)).toBe(false)
  })

  test("uses API error detail and a safe fallback for replay failures", () => {
    expect(replayErrorMessage({ message: "Source expired" })).toBe(
      "Source expired",
    )
    expect(replayErrorMessage(new Error("Network unavailable"))).toBe(
      "Network unavailable",
    )
    expect(replayErrorMessage("failed")).toBe("Replay request failed")
  })

  test("rejects a run after the replay source changes", () => {
    const replaySourceA = { body: '{"model":"a"}', id: "entry-a" }
    const replaySourceB = { body: '{"model":"b"}', id: "entry-b" }
    const sourceA = advanceReplaySource(initialReplayRunState())
    const { state: runningA, token: runA } = advanceReplayRun(
      sourceA,
      replaySourceA,
    )
    const sourceB = advanceReplaySource(runningA)

    expect(isCurrentReplayRun(runA, sourceB, replaySourceB)).toBe(false)
    expect(isCurrentReplayRun(runA, runningA, replaySourceB)).toBe(false)
  })

  test("rejects an older overlapping run for the same source", () => {
    const replaySource = { body: '{"model":"a"}', id: "entry-a" }
    const source = advanceReplaySource(initialReplayRunState())
    const { state: firstRunning, token: firstRun } = advanceReplayRun(
      source,
      replaySource,
    )
    const { state: secondRunning, token: secondRun } = advanceReplayRun(
      firstRunning,
      replaySource,
    )

    expect(isCurrentReplayRun(firstRun, secondRunning, replaySource)).toBe(
      false,
    )
    expect(isCurrentReplayRun(secondRun, secondRunning, replaySource)).toBe(
      true,
    )
    expect(secondRun.source).toBe(replaySource)
  })
})
