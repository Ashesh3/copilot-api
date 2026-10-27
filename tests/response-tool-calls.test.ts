import { describe, expect, test } from "bun:test"

import {
  buildAssistantOutputMarkdown,
  buildResponseJson,
} from "../ui/src/lib/http-export"
import { describeResponseOutput } from "../ui/src/lib/response-output"
import { parseResponsesBody } from "../ui/src/lib/responses-body"

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`
}

const functionCall = {
  id: "item_added",
  call_id: "call_agent",
  type: "function_call",
  name: "spawn_agent",
  arguments: '{"message":"Inspect parsing"}',
}

function rotatingArgumentEvents(): Array<string> {
  return ['{"message":', '"Inspect ', 'parsing"}'].map((delta, index) =>
    sse("response.function_call_arguments.delta", {
      output_index: 2,
      item_id: `fragment_${index}`,
      delta,
    }),
  )
}

function addedEvent(): string {
  return sse("response.output_item.added", {
    output_index: 2,
    item: { ...functionCall, arguments: "" },
  })
}

function itemDoneEvent(): string {
  return sse("response.output_item.done", {
    output_index: 2,
    item: { ...functionCall, id: "item_done" },
  })
}

function completedEvent(): string {
  return sse("response.completed", {
    response: {
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", id: "reasoning_1", summary: [] },
        { type: "reasoning", id: "reasoning_2", summary: [] },
        { ...functionCall, id: "item_final" },
      ],
    },
  })
}

describe("Responses tool calls with rotating upstream item IDs", () => {
  test("assembles argument fragments into one named call and export", () => {
    const raw = [
      addedEvent(),
      ...rotatingArgumentEvents(),
      sse("response.function_call_arguments.done", {
        output_index: 2,
        item_id: "arguments_done",
        arguments: '{"message":"Inspect parsing"}',
      }),
      itemDoneEvent(),
      completedEvent(),
    ].join("")
    const parsed = parseResponsesBody(raw)

    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"message":"Inspect parsing"}',
        argumentsJson: { message: "Inspect parsing" },
        callId: "call_agent",
        id: "item_final",
        name: "spawn_agent",
        outputIndex: 2,
      },
    ])
    expect(parsed).not.toBeNull()
    if (!parsed) throw new Error("Expected a parsed Responses stream")
    expect(describeResponseOutput(parsed)).toMatchObject({
      kind: "tool-only",
      message: "The model returned 1 tool call and no assistant message.",
    })
    const exported = JSON.parse(
      buildResponseJson(undefined, parsed) ?? "{}",
    ) as {
      toolCalls: Array<{ name: string }>
    }
    expect(exported.toolCalls).toHaveLength(1)
    expect(exported.toolCalls[0].name).toBe("spawn_agent")
    const markdown = buildAssistantOutputMarkdown(parsed)
    expect(markdown).toContain("Name: spawn_agent")
    expect(markdown).toContain("Call ID: call_agent")
    expect(markdown?.match(/^### Tool call \d+$/gm)).toEqual([
      "### Tool call 1",
    ])
  })

  test("assembles a partial capture without an authoritative done event", () => {
    const parsed = parseResponsesBody(
      [addedEvent(), ...rotatingArgumentEvents().slice(0, 2)].join(""),
    )

    expect(parsed?.isPartial).toBe(true)
    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"message":"Inspect ',
        argumentsJson: null,
        callId: "call_agent",
        id: "item_added",
        name: "spawn_agent",
        outputIndex: 2,
      },
    ])
  })

  test.each([
    ["item done", itemDoneEvent(), "item_done"],
    ["terminal response", completedEvent(), "item_final"],
  ])(
    "adopts %s metadata when the capture starts with fragments",
    (_, ending, id) => {
      const parsed = parseResponsesBody(
        [...rotatingArgumentEvents(), ending].join(""),
      )

      expect(parsed?.toolCalls).toEqual([
        {
          arguments: '{"message":"Inspect parsing"}',
          argumentsJson: { message: "Inspect parsing" },
          callId: "call_agent",
          id,
          name: "spawn_agent",
          outputIndex: 2,
        },
      ])
    },
  )

  test("keeps interleaved argument fragments at distinct output indexes", () => {
    const raw = [
      addedEvent(),
      sse("response.output_item.added", {
        output_index: 3,
        item: {
          ...functionCall,
          id: "second_item",
          call_id: "call_second",
          name: "lookup",
          arguments: "",
        },
      }),
      rotatingArgumentEvents()[0],
      sse("response.function_call_arguments.delta", {
        output_index: 3,
        item_id: "second_fragment_0",
        delta: '{"id":',
      }),
      ...rotatingArgumentEvents().slice(1),
      sse("response.function_call_arguments.delta", {
        output_index: 3,
        item_id: "second_fragment_1",
        delta: "7}",
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls).toEqual([
      {
        arguments: '{"message":"Inspect parsing"}',
        argumentsJson: { message: "Inspect parsing" },
        callId: "call_agent",
        id: "item_added",
        name: "spawn_agent",
        outputIndex: 2,
      },
      {
        arguments: '{"id":7}',
        argumentsJson: { id: 7 },
        callId: "call_second",
        id: "second_item",
        name: "lookup",
        outputIndex: 3,
      },
    ])
  })

  test("does not treat a fallback frame position as an explicit output index", () => {
    const raw = [
      sse("response.function_call_arguments.delta", {
        item_id: "unindexed_fragment",
        delta: "unrelated",
      }),
      sse("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "indexed_fragment",
        delta: "{}",
      }),
    ].join("")
    const calls = parseResponsesBody(raw)?.toolCalls

    expect(calls).toHaveLength(2)
    expect(calls?.map((call) => call.arguments)).toEqual(["unrelated", "{}"])
  })

  test("matches stable item IDs when argument events omit output indexes", () => {
    const raw = [
      addedEvent(),
      sse("response.function_call_arguments.delta", {
        item_id: "item_added",
        delta: '{"message":"Inspect parsing"}',
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls).toEqual([
      {
        arguments: '{"message":"Inspect parsing"}',
        argumentsJson: { message: "Inspect parsing" },
        callId: "call_agent",
        id: "item_added",
        name: "spawn_agent",
        outputIndex: 2,
      },
    ])
  })
})
