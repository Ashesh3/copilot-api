/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import { expect, test } from "bun:test"

import { runWithWebTools } from "~/services/web/tool-context"
import { runManagedWebRequest } from "~/services/web/tool-loop"

const fetchResponse = (content: Array<Record<string, unknown>>) => ({
  id: "msg-1",
  type: "message",
  role: "assistant",
  model: "fixture",
  content,
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 3 },
})

test("executes owned tools and replays all thinking before final synthesis", async () => {
  const source = {
    model: "fixture",
    messages: [{ role: "user", content: "fetch example" }],
  }
  const requests: Array<Record<string, unknown>> = []
  const result = await runWithWebTools(source, () =>
    runManagedWebRequest({
      protocol: "messages",
      payload: source,
      send: async (payload) => {
        requests.push(payload)
        if (requests.length === 1)
          return fetchResponse([
            { type: "thinking", thinking: "reasoning", signature: "signed" },
            {
              type: "tool_use",
              id: "fetch-1",
              name: "_copilot_web_search",
              input: { query: "Open https://example.com" },
            },
          ])
        return {
          ...fetchResponse([{ type: "text", text: "Fetched title" }]),
          stop_reason: "end_turn",
        }
      },
      execute: async () => ({
        text: '{"title":"Example Domain","content":"page text"}',
        isError: false,
      }),
    }),
  )
  expect(requests).toHaveLength(2)
  expect(requests[1].messages).toMatchObject([
    { role: "user" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "signed" },
        { type: "tool_use", id: "fetch-1" },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "fetch-1" }],
    },
  ])
  expect(result).toMatchObject({
    content: [{ type: "text", text: "Fetched title" }],
  })
})

test("Messages rejects unexpected mixed calls before executing managed search", async () => {
  const source = {
    model: "fixture",
    messages: [],
  }
  let sends = 0
  let executions = 0
  const result = await runWithWebTools(source, () =>
    runManagedWebRequest({
      protocol: "messages",
      payload: source,
      send: async () => {
        sends++
        return fetchResponse([
          { type: "thinking", thinking: "", signature: "signed" },
          {
            type: "tool_use",
            id: "fetch-1",
            name: "_copilot_web_search",
            input: { query: "Open https://example.com" },
          },
          {
            type: "tool_use",
            id: "client-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ])
      },
      execute: async () => {
        executions++
        return { text: "PRIVATE_WEB_CONTENT", isError: false }
      },
    }),
  ).catch((error: unknown) => error)
  expect(sends).toBe(1)
  expect(executions).toBe(0)
  expect(result).toMatchObject({
    response: { status: 400 },
    clientBody: { error: { code: "unsupported_web_tool_combination" } },
  })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_WEB_CONTENT")
})

test.each([
  {
    type: "custom_tool_call",
    id: "shell1",
    call_id: "client",
    name: "shell",
    input: "pwd",
  },
  {
    type: "tool_search_call",
    id: "search1",
    call_id: "client",
    execution: "client",
    arguments: { query: "file" },
  },
  {
    type: "function_call",
    id: "fn1",
    call_id: "client",
    namespace: "client",
    name: "_copilot_web_search",
    arguments: "{}",
  },
])(
  "Responses rejects unexpected mixed client calls before any execution: %j",
  async (clientCall) => {
    let sends = 0
    let executions = 0
    const payload = { input: "open page" }
    const result = await runWithWebTools(payload, () =>
      runManagedWebRequest({
        protocol: "responses",
        payload,
        send: async () => {
          sends++
          return {
            id: "r1",
            output: [
              {
                type: "function_call",
                call_id: "web",
                name: "_copilot_web_search",
                arguments: '{"query":"Open https://example.com"}',
              },
              clientCall,
            ],
          }
        },
        execute: async () => {
          executions++
          return { text: "PRIVATE_PAGE", isError: false }
        },
      }),
    ).catch((error: unknown) => error)
    expect(sends).toBe(1)
    expect(executions).toBe(0)
    expect(result).toMatchObject({
      response: { status: 400 },
      clientBody: { error: { code: "unsupported_web_tool_combination" } },
    })
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PAGE")
  },
)

test("Responses retains reasoning and does not return owned function calls to clients", async () => {
  let sends = 0
  const source = { model: "fixture", input: "open page", stream: false }
  const result = await runWithWebTools(source, () =>
    runManagedWebRequest({
      protocol: "responses",
      payload: source,
      send: async (payload) => {
        sends++
        if (sends === 1)
          return {
            id: "r1",
            status: "completed",
            output: [
              { type: "reasoning", encrypted_content: "signed", summary: [] },
              {
                type: "function_call",
                call_id: "f1",
                name: "_copilot_web_search",
                arguments: '{"query":"Open https://example.com"}',
              },
            ],
          }
        expect(payload.input).toMatchObject([
          { role: "user", content: "open page" },
          { type: "reasoning", encrypted_content: "signed" },
          { type: "function_call", call_id: "f1" },
          { type: "function_call_output", call_id: "f1", output: "page" },
        ])
        return {
          id: "r2",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
        }
      },
      execute: async () => ({ text: "page", isError: false }),
    }),
  )
  expect(result).toMatchObject({ id: "r2", output: [{ type: "message" }] })
})
