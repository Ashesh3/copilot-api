import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { WebProtocol } from "~/services/web/tool-context"
import type { WebResponse } from "~/services/web/tool-loop"

import { state } from "~/lib/state"
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages"
import { createChatCompletionsWithProcessedPayload } from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"
import { createRetryBudget } from "~/services/copilot/transport-retry"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream } from "~/services/web/tool-loop"
import { records } from "~/services/web/tool-output"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  models: state.models,
}
const bodies: Array<Record<string, unknown>> = []
const headers: Array<Headers> = []
const toolName = "_copilot_web_search"
const toolArguments = '{"query":"compatibility fixture"}'
const toolText = "REMOTE_SEARCH_EVIDENCE"
const model = "compatibility-fixture"
let searchCalls = 0

beforeEach(async () => {
  bodies.length = 0
  headers.length = 0
  searchCalls = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-compatibility-fixture"
  state.githubToken = "github-compatibility-fixture"
  state.isMultiToken = false
  state.models = undefined
  await seedProtocolDatabase()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  resetWebSearchSessionsForTest()
})

function sourcePayload(protocol: WebProtocol, stream: boolean) {
  const common = { model, stream, top_p: 0.9 }
  if (protocol === "messages")
    return {
      ...common,
      max_tokens: 256,
      messages: [{ role: "user", content: "Find the fixture." }],
      fallbacks: [{ model: "fallback-fixture" }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    }
  if (protocol === "responses")
    return {
      ...common,
      input: [{ role: "user", content: "Find the fixture." }],
      temperature: 0.7,
      service_tier: "priority",
    }
  return {
    ...common,
    temperature: 0.7,
    messages: [{ role: "user", content: "Find the fixture." }],
  }
}

function compatibilityError(protocol: WebProtocol): Response {
  return Response.json(
    protocol === "messages" ?
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "fallbacks: Extra inputs are not permitted",
        },
      }
    : {
        error: {
          code: "invalid_request_body",
          message:
            "Unsupported parameter: 'temperature' is not supported with this model.",
        },
      },
    { status: 400 },
  )
}

function completion(protocol: WebProtocol, managed: boolean) {
  if (protocol === "messages")
    return {
      id: "message-fixture",
      type: "message",
      role: "assistant",
      model,
      content:
        managed ?
          [
            {
              type: "tool_use",
              id: "web-call",
              name: toolName,
              input: JSON.parse(toolArguments) as unknown,
            },
          ]
        : [{ type: "text", text: "FINAL_ANSWER" }],
      stop_reason: managed ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    }
  if (protocol === "responses")
    return {
      id: "response-fixture",
      object: "response",
      model,
      status: "completed",
      output:
        managed ?
          [
            {
              type: "function_call",
              id: "web-item",
              call_id: "web-call",
              name: toolName,
              arguments: toolArguments,
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: "answer-item",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "FINAL_ANSWER", annotations: [] },
              ],
            },
          ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }
  return {
    id: "chat-fixture",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        finish_reason: managed ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: managed ? null : "FINAL_ANSWER",
          ...(managed ?
            {
              tool_calls: [
                {
                  id: "web-call",
                  type: "function",
                  function: { name: toolName, arguments: toolArguments },
                },
              ],
            }
          : {}),
        },
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }
}

function streamEvents(protocol: WebProtocol, managed: boolean) {
  const result = completion(protocol, managed)
  if (protocol === "responses")
    return [
      {
        type: "response.created",
        response: { id: result.id, status: "in_progress", output: [] },
      },
      ...records(result.output).flatMap((item, index) => [
        { type: "response.output_item.added", output_index: index, item },
        { type: "response.output_item.done", output_index: index, item },
      ]),
      { type: "response.completed", response: result },
    ]
  if (protocol === "messages")
    return [
      {
        type: "message_start",
        message: { ...result, content: [], stop_reason: null },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: records(result.content)[0],
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: result.stop_reason },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]
  const message = records(result.choices)[0].message as Record<string, unknown>
  return [
    {
      ...result,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            ...message,
            ...(managed ?
              {
                tool_calls: records(message.tool_calls).map((call) => ({
                  ...call,
                  index: 0,
                })),
              }
            : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...result,
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: {}, finish_reason: managed ? "tool_calls" : "stop" },
      ],
    },
    "[DONE]",
  ]
}

function installTransport(protocol: WebProtocol, stream: boolean) {
  const endpoint = {
    chat: "/chat/completions",
    messages: "/v1/messages",
    responses: "/responses",
  }[protocol]
  const rejected = protocol === "messages" ? "fallbacks" : "temperature"
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized request")
    const body = JSON.parse(init.body) as Record<string, unknown>
    const path = new URL(url instanceof Request ? url.url : url).pathname
    if (path === "/mcp/readonly") {
      if (body.method === "initialize")
        return Promise.resolve(
          Response.json(
            { jsonrpc: "2.0", id: body.id, result: {} },
            { headers: { "Mcp-Session-Id": "compatibility-session" } },
          ),
        )
      expect(body).toMatchObject({
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: { query: "compatibility fixture" },
        },
      })
      searchCalls++
      return Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: toolText }],
            isError: false,
          },
        }),
      )
    }
    expect(path).toBe(endpoint)
    bodies.push(body)
    headers.push(new Headers(init.headers))
    if (bodies.length > 3) throw new Error("Unexpected extra upstream attempt")
    if (Object.hasOwn(body, rejected))
      return Promise.resolve(compatibilityError(protocol))
    const managed = bodies.length === 2
    return Promise.resolve(
      stream ?
        new Response(
          `${streamEvents(protocol, managed)
            .map(
              (event) =>
                `data: ${typeof event === "string" ? event : JSON.stringify(event)}`,
            )
            .join("\n\n")}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json(completion(protocol, managed)),
    )
  }) as typeof fetch
}

async function readResult(response: WebResponse): Promise<unknown> {
  if (!isWebStream(response)) return response
  const output: Array<unknown> = []
  for await (const event of response)
    if (event.data && event.data !== "[DONE]")
      output.push(JSON.parse(event.data) as unknown)
  return output
}

for (const protocol of ["chat", "responses", "messages"] as const) {
  for (const stream of [false, true]) {
    test(`${protocol} preserves its successful compatibility payload through ${stream ? "streamed" : "buffered"} managed continuation`, async () => {
      installTransport(protocol, stream)
      const source = sourcePayload(protocol, stream)
      const original = structuredClone(source)
      const retryBudget = createRetryBudget({ extraSends: 1 })
      const routedAccountPin = { accountId: 0 }
      const options = { retryBudget, routedAccountPin }
      let processedPayload: ChatCompletionsPayload | undefined
      let failure: unknown
      const result = await runWithWebTools(source, async () => {
        let response: unknown
        if (protocol === "chat") {
          const completed = await createChatCompletionsWithProcessedPayload(
            source as unknown as ChatCompletionsPayload,
            options,
          )
          processedPayload = completed.processedPayload
          response = completed.response
        } else if (protocol === "responses") {
          response = await createResponses(source as ResponsesPayload, {
            ...options,
            initiator: "user",
            vision: false,
          })
        } else {
          response = await createAnthropicMessages(
            source as unknown as AnthropicMessagesPayload,
            options,
          )
        }
        return await readResult(response as WebResponse)
      }).catch((error: unknown) => {
        failure = error
      })

      if (bodies.length === 0 && failure instanceof Error) throw failure
      expect(bodies).toHaveLength(3)
      const rejected = protocol === "messages" ? "fallbacks" : "temperature"
      expect(bodies[0][rejected]).toEqual(
        protocol === "messages" ? [{ model: "fallback-fixture" }] : 0.7,
      )
      expect(bodies[1]).not.toHaveProperty(rejected)
      expect(bodies[2]).not.toHaveProperty(rejected)
      expect(failure).toBeUndefined()
      expect(searchCalls).toBe(1)
      expect(JSON.stringify(result)).toContain("FINAL_ANSWER")
      expect(JSON.stringify(result)).not.toContain(`"name":"${toolName}"`)
      expect(retryBudget).toEqual({
        compatibilityRetryUsed: true,
        remaining: 0,
      })
      expect(source).toEqual(original)
      expect(headers.map((header) => header.get("authorization"))).toEqual(
        Array.from({ length: 3 }, () => "Bearer copilot-compatibility-fixture"),
      )
      expect(bodies[2]).toMatchObject({ model, stream, top_p: 0.9 })
      const history = records(
        protocol === "responses" ? bodies[2].input : bodies[2].messages,
      )
      expect(history).toHaveLength(3)
      expect(history[0]).toMatchObject({
        role: "user",
        content: "Find the fixture.",
      })
      if (protocol === "responses") {
        expect(history[2]).toEqual({
          type: "function_call_output",
          call_id: "web-call",
          output: toolText,
        })
        expect(bodies[2]).toMatchObject({ store: false, tool_choice: "auto" })
        expect(bodies[2]).not.toHaveProperty("service_tier")
      } else if (protocol === "messages") {
        expect(history[2]).toEqual({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "web-call", content: toolText },
          ],
        })
        expect(bodies[2].tool_choice).toEqual({
          type: "auto",
          disable_parallel_tool_use: true,
        })
      } else {
        expect(history[2]).toMatchObject({
          role: "tool",
          tool_call_id: "web-call",
          content: toolText,
        })
        if (!stream)
          expect(processedPayload).toEqual(
            bodies[2] as unknown as ChatCompletionsPayload,
          )
      }
    })
  }
}
