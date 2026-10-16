import { expect, test } from "bun:test"

import type { WebProtocol } from "~/services/web/tool-context"

import { runWithWebTools } from "~/services/web/tool-context"
import { runManagedWebRequest } from "~/services/web/tool-loop"

function toolResponse(protocol: WebProtocol, name?: string) {
  if (protocol === "messages")
    return {
      id: "msg_required",
      type: "message",
      role: "assistant",
      model: "fixture",
      content:
        name ?
          [{ type: "tool_use", id: "call_required", name, input: {} }]
        : [{ type: "text", text: "Hello" }],
      stop_reason: name ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  if (protocol === "responses")
    return {
      id: "resp_required",
      object: "response",
      status: "completed",
      output:
        name ?
          [
            {
              id: "fc_required",
              type: "function_call",
              status: "completed",
              call_id: "call_required",
              name,
              arguments: "{}",
            },
          ]
        : [
            {
              id: "msg_required",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Hello", annotations: [] },
              ],
            },
          ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
  return {
    id: "chatcmpl_required",
    object: "chat.completion",
    created: 1,
    model: "fixture",
    choices: [
      {
        index: 0,
        finish_reason: name ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: name ? null : "Hello",
          ...(name ?
            {
              tool_calls: [
                {
                  id: "call_required",
                  type: "function",
                  function: { name, arguments: "{}" },
                },
              ],
            }
          : {}),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

test.each<WebProtocol>(["chat", "responses", "messages"])(
  "%s returns the required caller tool before any managed continuation",
  async (protocol) => {
    let callerTool: Record<string, unknown> = {
      type: "function",
      name: "get_weather",
      parameters: { type: "object" },
    }
    if (protocol === "messages")
      callerTool = { name: "get_weather", input_schema: { type: "object" } }
    else if (protocol === "chat")
      callerTool = {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      }
    const source = {
      model: "fixture",
      ...(protocol === "responses" ?
        { input: "Hello, how are you?" }
      : { messages: [{ role: "user", content: "Hello, how are you?" }] }),
      tools: [callerTool],
      tool_choice: protocol === "messages" ? { type: "any" } : "required",
    }
    const requests: Array<Record<string, unknown>> = []
    let executions = 0
    const result = await runWithWebTools(source, () =>
      runManagedWebRequest({
        protocol,
        payload: source,
        send: (payload, managed) => {
          requests.push(payload)
          // A conforming provider may choose any offered tool under required/any.
          if (requests.length === 1)
            return Promise.resolve(
              toolResponse(
                protocol,
                managed.keys().next().value ?? "get_weather",
              ),
            )
          return Promise.resolve(toolResponse(protocol))
        },
        execute: () => {
          executions++
          return Promise.resolve({ text: "Web result", isError: false })
        },
      }),
    )

    expect(result).toEqual(toolResponse(protocol, "get_weather"))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(source)
    expect(executions).toBe(0)
  },
)

test("Responses returns required unnamed client tool search without a managed continuation", async () => {
  const source = {
    model: "fixture",
    input: "Find a deferred tool",
    tools: [
      {
        type: "tool_search",
        execution: "client",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    tool_choice: "required",
  }
  const clientResponse = {
    id: "resp_required_search",
    object: "response",
    status: "completed",
    output: [
      {
        type: "tool_search_call",
        id: "search_required",
        call_id: "call_search_required",
        execution: "client",
        status: "completed",
        arguments: { query: "weather" },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  const requests: Array<Record<string, unknown>> = []
  let executions = 0
  const result = await runWithWebTools(source, () =>
    runManagedWebRequest({
      protocol: "responses",
      payload: source,
      send: (payload, managed) => {
        requests.push(payload)
        const managedName = managed.keys().next().value
        if (requests.length > 1)
          return Promise.resolve(toolResponse("responses"))
        return Promise.resolve(
          managedName ? toolResponse("responses", managedName) : clientResponse,
        )
      },
      execute: () => {
        executions++
        return Promise.resolve({ text: "Web result", isError: false })
      },
    }),
  )

  expect(result).toEqual(clientResponse)
  expect(requests).toEqual([source])
  expect(executions).toBe(0)
})
