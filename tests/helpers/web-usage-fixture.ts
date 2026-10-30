import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getUsageResponse, resetUsageForTest } from "~/lib/usage-tracker"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import { PROTOCOL_GATEWAY_KEY, seedProtocolDatabase } from "./protocol-database"

/**
 * A two-round gateway search: the first upstream round calls the search tool
 * the request declares, and the second answers. Round 2's prompt holds round
 * 1, so its input is the conversation's size.
 */

export type JsonRecord = Record<string, unknown>

export const ROUND_USAGE: Record<string, ReadonlyArray<JsonRecord>> = {
  "/v1/messages": [
    {
      input_tokens: 2_000,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 8_000,
      output_tokens: 300,
    },
    {
      input_tokens: 1_000,
      cache_read_input_tokens: 98_000,
      cache_creation_input_tokens: 5_000,
      output_tokens: 50,
    },
  ],
  "/chat/completions": [
    {
      prompt_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 90_000 },
      completion_tokens: 300,
      total_tokens: 100_300,
    },
    {
      prompt_tokens: 104_000,
      prompt_tokens_details: { cached_tokens: 100_000 },
      completion_tokens: 50,
      total_tokens: 104_050,
    },
  ],
  "/responses": [
    {
      input_tokens: 100_000,
      input_tokens_details: { cached_tokens: 90_000 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 100_300,
    },
    {
      input_tokens: 104_000,
      input_tokens_details: { cached_tokens: 100_000 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 104_050,
    },
  ],
}

/** Every round's tokens, as request accounting must record them. */
export const ALL_ROUNDS = {
  total_input_tokens: 204_000,
  total_output_tokens: 350,
  total_requests: 1,
}

export const fixture = {
  /** Upstream inference request bodies, in order. */
  upstream: [] as Array<JsonRecord>,
  /** The model answers in the first round instead of searching. */
  answerFirst: false,
  /** How the final Responses round ends. */
  finalStatus: "completed" as "completed" | "incomplete",
}

const originalFetch = globalThis.fetch
const originalState = { ...state }

/** A model the fixture serves on one upstream endpoint. */
export function fixtureModel(
  id: string,
  endpoint: string,
  extra: Partial<Model> = {},
): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "1",
    vendor: "test",
    supported_endpoints: [endpoint],
    capabilities: {
      family: "test",
      object: "model_capabilities",
      supports: { tool_calls: true },
      limits: { max_output_tokens: 4096 },
      tokenizer: "o200k_base",
      type: "chat",
    },
    ...extra,
  }
}

/** The search tool the request declares: the gateway's or hosted search's. */
function searchToolName(body: JsonRecord): string {
  const tools =
    Array.isArray(body.tools) ? (body.tools as Array<JsonRecord>) : []
  const names = tools.map((tool) =>
    String(((tool.function ?? tool) as JsonRecord).name),
  )
  const name = names.find(
    (candidate) =>
      candidate === "web_search" || candidate.startsWith("_copilot_web_"),
  )
  if (!name) throw new Error(`No search tool among ${names.join(", ")}`)
  return name
}

function eventStream(events: Array<JsonRecord>, named: boolean): Response {
  const frames = events.map(
    (event) =>
      `${named ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
  )
  return new Response(`${frames.join("")}${named ? "" : "data: [DONE]\n\n"}`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function messagesReply(body: JsonRecord, round: number): Response {
  const search = round === 0 && !fixture.answerFirst
  const usage = ROUND_USAGE["/v1/messages"][round]
  const content: Array<JsonRecord> =
    search ?
      [
        {
          type: "tool_use",
          id: "toolu_usage",
          name: searchToolName(body),
          input: { query: "release notes" },
        },
      ]
    : [{ type: "text", text: "Version 2 shipped." }]
  const message = {
    id: `msg_usage_${round}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: search ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  }
  if (body.stream !== true) return Response.json(message)
  const { output_tokens: output, ...input } = usage
  return eventStream(
    [
      {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, usage: input },
      },
      ...content.flatMap((block, index) => [
        {
          type: "content_block_start",
          index,
          content_block:
            block.type === "tool_use" ?
              { ...block, input: {} }
            : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta:
            block.type === "tool_use" ?
              {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              }
            : { type: "text_delta", text: block.text },
        },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: output },
      },
      { type: "message_stop" },
    ],
    true,
  )
}

function chatReply(body: JsonRecord, round: number): Response {
  const search = round === 0 && !fixture.answerFirst
  const usage = ROUND_USAGE["/chat/completions"][round]
  const call = {
    id: "call_usage",
    type: "function",
    function: {
      name: searchToolName(body),
      arguments: '{"query":"release notes"}',
    },
  }
  const chunk = (fields: JsonRecord) => ({
    id: `chat_usage_${round}`,
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    ...fields,
  })
  const finish = search ? "tool_calls" : "stop"
  if (body.stream !== true)
    return Response.json({
      ...chunk({ object: "chat.completion" }),
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: finish,
          message:
            search ?
              { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: "Version 2 shipped." },
        },
      ],
      usage,
    })
  const delta =
    search ?
      { role: "assistant", tool_calls: [{ index: 0, ...call }] }
    : { role: "assistant", content: "Version 2 shipped." }
  return eventStream(
    [
      chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }),
      chunk({ choices: [], usage }),
    ],
    false,
  )
}

function responsesReply(body: JsonRecord, round: number): Response {
  const search = round === 0 && !fixture.answerFirst
  const status = search ? "completed" : fixture.finalStatus
  const output: Array<JsonRecord> =
    search ?
      [
        {
          type: "function_call",
          id: "fc_usage",
          status: "completed",
          call_id: "call_usage",
          name: searchToolName(body),
          arguments: '{"query":"release notes"}',
        },
      ]
    : [
        {
          type: "message",
          id: "msg_usage",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Version 2 shipped.",
              annotations: [],
            },
          ],
        },
      ]
  const response = {
    id: `resp_usage_${round}`,
    object: "response",
    created_at: 1,
    status,
    model: body.model,
    output,
    ...(status === "incomplete" ?
      { incomplete_details: { reason: "max_output_tokens" } }
    : {}),
    usage: ROUND_USAGE["/responses"][round],
  }
  if (body.stream !== true) return Response.json(response)
  return eventStream(
    [
      {
        type: "response.created",
        sequence_number: 0,
        response: { ...response, status: "in_progress", output: [] },
      },
      ...output.flatMap((item, index) => [
        {
          type: "response.output_item.added",
          sequence_number: 1 + index * 2,
          output_index: index,
          item,
        },
        {
          type: "response.output_item.done",
          sequence_number: 2 + index * 2,
          output_index: index,
          item,
        },
      ]),
      { type: `response.${status}`, sequence_number: 9, response },
    ],
    true,
  )
}

function reply(path: string, body: JsonRecord): Response {
  if (path === "/mcp/readonly") {
    if (body.method === "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result: {} },
        { headers: { "Mcp-Session-Id": "usage-search" } },
      )
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: "Release notes" }] },
    })
  }
  const round = fixture.upstream.push(body) - 1
  if (round > 1) throw new Error("Unexpected upstream round")
  if (path === "/v1/messages") return messagesReply(body, round)
  if (path === "/responses") return responsesReply(body, round)
  return chatReply(body, round)
}

/** Serve these models from the fixture, with empty usage totals. */
export async function installWebUsageFixture(
  models: Array<Model>,
): Promise<void> {
  fixture.upstream.length = 0
  fixture.answerFirst = false
  fixture.finalStatus = "completed"
  resetUsageForTest()
  resetWebSearchSessionsForTest()
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  state.accountType = "individual"
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.copilotToken = "fixture-copilot"
  state.githubToken = "fixture-github"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = { object: "list", data: models }
  await seedProtocolDatabase()
  globalThis.fetch = Object.assign(
    (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(url instanceof Request ? url.url : String(url))
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as JsonRecord
      return Promise.resolve(reply(target.pathname, body))
    },
    { preconnect: originalFetch.preconnect },
  )
}

export function restoreWebUsageFixture(): void {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
}

/** The dashboard's lifetime totals. */
export async function recordedTotals(): Promise<JsonRecord> {
  return (await getUsageResponse()).lifetime as JsonRecord
}
