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
