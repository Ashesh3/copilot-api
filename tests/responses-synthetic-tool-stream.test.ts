import { describe, expect, test } from "bun:test"

import type {
  ResponseOutputItem,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import { emitResponsesResultAsStream } from "~/routes/messages/web-search-helpers"

interface EmittedFrame {
  type: string
  sequence_number: number
  item?: Record<string, unknown>
  item_id?: string
  output_index?: number
  delta?: string
  arguments?: string
  input?: string
  part?: unknown
  response?: ResponsesResult
}

function resultWith(output: Array<ResponseOutputItem>): ResponsesResult {
  return {
    id: "resp_tools",
    object: "response",
    created_at: 1,
    model: "claude-current",
    output,
    output_text: "",
    status: "completed",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}

async function collectFrames(
  result: ResponsesResult,
): Promise<Array<EmittedFrame>> {
  const frames: Array<EmittedFrame> = []
  await emitResponsesResultAsStream(
    {
      writeSSE: ({ data }) => {
        frames.push(JSON.parse(data) as EmittedFrame)
        return Promise.resolve()
      },
    },
    result,
  )
  return frames
}

function textParts(value: unknown): Array<{ text?: unknown }> {
  return Array.isArray(value) ? (value as Array<{ text?: unknown }>) : []
}

function itemText(item: Record<string, unknown>): string {
  return [...textParts(item.content), ...textParts(item.summary)]
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
}

describe("synthetic Responses text streams", () => {
  test("streams message text and reasoning summaries once", async () => {
    const reasoning: ResponseOutputItem = {
      id: "rs_think",
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "Checking the file." },
        { type: "summary_text", text: "Comparing totals." },
      ],
      encrypted_content: "opaque-state",
    }
    const message: ResponseOutputItem = {
      id: "msg_update",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [
        { type: "output_text", text: "Reading the config.", annotations: [] },
      ],
    }
    const frames = await collectFrames(resultWith([reasoning, message]))

    const summaryPart = [
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]
    expect(frames.map((frame) => frame.type)).toEqual([
      "response.created",
      "response.output_item.added",
      ...summaryPart,
      ...summaryPart,
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(frames.map((frame) => frame.sequence_number)).toEqual(
      frames.map((_, index) => index),
    )
    expect(
      frames
        .filter((frame) => frame.type.startsWith("response.content_part."))
        .map((frame) => frame.part),
    ).toEqual([
      { type: "output_text", text: "", annotations: [] },
      { type: "output_text", text: "Reading the config.", annotations: [] },
    ])

    // Clients render the started item, then append every delta to it.
    const rendered = new Map<string, string>()
    for (const frame of frames) {
      if (frame.type === "response.output_item.added" && frame.item) {
        rendered.set(String(frame.item.id), itemText(frame.item))
      } else if (frame.type.endsWith(".delta") && frame.item_id) {
        const previous = rendered.get(frame.item_id) ?? ""
        rendered.set(frame.item_id, previous + (frame.delta ?? ""))
      }
    }
    expect(rendered.get("rs_think")).toBe("Checking the file.Comparing totals.")
    expect(rendered.get("msg_update")).toBe("Reading the config.")

    const added = frames.filter(
      (frame) => frame.type === "response.output_item.added",
    )
    expect(added.map((frame) => frame.item)).toEqual([
      { ...reasoning, summary: [], status: "in_progress" },
      { ...message, content: [], status: "in_progress" },
    ])
    const done = frames.filter(
      (frame) => frame.type === "response.output_item.done",
    )
    expect(done.map((frame) => frame.item)).toEqual([
      { ...reasoning },
      { ...message },
    ])
    expect(frames.at(-1)?.response?.output).toEqual([reasoning, message])
  })
})

describe("synthetic Responses tool streams", () => {
  test("streams namespaced function arguments once before completing the call", async () => {
    const call: ResponseOutputItem = {
      id: "fc_read",
      type: "function_call",
      call_id: "call_read",
      namespace: "files",
      name: "read",
      arguments: '{"path":"sample.txt"}',
      status: "completed",
    }
    const result = resultWith([call])
    const original = structuredClone(result)
    const frames = await collectFrames(result)

    expect(frames.map((frame) => frame.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(frames[1]?.item).toEqual({
      ...call,
      arguments: "",
      status: "in_progress",
    })
    expect(frames[2]).toMatchObject({
      item_id: "fc_read",
      output_index: 0,
      delta: '{"path":"sample.txt"}',
    })
    expect(frames[3]?.arguments).toBe('{"path":"sample.txt"}')
    expect(frames[4]?.item).toEqual({ ...call })
    expect(frames.at(-1)?.response?.output).toEqual([call])
    expect(frames.map((frame) => frame.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    expect(result).toEqual(original)
  })

  test("streams custom raw input while preserving its namespace and call identity", async () => {
    const input = 'const answer = "hello";\ntext(answer);\n'
    const call: ResponseOutputItem = {
      id: "ct_exec",
      type: "custom_tool_call",
      call_id: "call_exec",
      namespace: "functions",
      name: "exec",
      input,
      status: "completed",
    }
    const frames = await collectFrames(resultWith([call]))

    expect(frames.map((frame) => frame.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(frames[1]?.item).toEqual({
      ...call,
      input: "",
      status: "in_progress",
    })
    expect(frames[2]).toMatchObject({
      item_id: "ct_exec",
      output_index: 0,
      delta: input,
    })
    expect(frames[3]).toMatchObject({
      item_id: "ct_exec",
      output_index: 0,
      input,
    })
    expect(frames[4]?.item).toEqual({ ...call })
    expect(frames.at(-1)?.response?.output).toEqual([call])
  })

  test("keeps client tool search arguments as an object in its item lifecycle", async () => {
    const call: ResponseOutputItem = {
      id: "ts_discover",
      type: "tool_search_call",
      call_id: "call_discover",
      execution: "client",
      arguments: { query: "find tools", limit: 2 },
      status: "completed",
    }
    const frames = await collectFrames(resultWith([call]))

    expect(frames.map((frame) => frame.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ])
    expect(frames[1]?.item).toEqual({ ...call, status: "in_progress" })
    expect(frames[2]?.item).toEqual({ ...call })
    expect(frames.at(-1)?.response?.output).toEqual([call])
  })

  test("does not emit completion after the transport rejects a custom input delta", async () => {
    const frames: Array<string> = []
    const disconnected = new Error("Client disconnected")
    const pending = emitResponsesResultAsStream(
      {
        writeSSE: ({ event }) => {
          frames.push(event ?? "")
          return event === "response.custom_tool_call_input.delta" ?
              Promise.reject(disconnected)
            : Promise.resolve()
        },
      },
      resultWith([
        {
          id: "ct_abort",
          type: "custom_tool_call",
          call_id: "call_abort",
          name: "exec",
          input: "text(1)",
          status: "completed",
        },
      ]),
    )

    const outcome: unknown = await pending.catch((error: unknown) => error)
    expect(outcome).toBe(disconnected)
    expect(frames).toEqual([
      "response.created",
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
    ])
  })
})
