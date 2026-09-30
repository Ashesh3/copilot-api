import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import { claudePermissionReviewAllowText } from "~/lib/permission-review"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import {
  emitAnthropicResponseAsStream,
  emitResponsesResultAsStream,
} from "~/routes/messages/web-search-helpers"

export function createAllowedReviewResponse(
  payload: ResponsesPayload,
): ResponsesResult {
  const text = payload.generate === false ? "" : '{"outcome":"allow"}'
  return {
    id: `resp_permission_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: payload.model,
    status: "completed",
    output_text: text,
    output:
      text ?
        [
          {
            id: `msg_${randomUUID().replaceAll("-", "")}`,
            type: "message",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ]
      : [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    metadata: payload.metadata ?? null,
    parallel_tool_calls: payload.parallel_tool_calls ?? false,
    temperature: payload.temperature ?? null,
    top_p: payload.top_p ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: payload.tools ?? [],
    text: payload.text,
  }
}

export function allowResponsesPermissionReview(
  c: Context,
  payload: ResponsesPayload,
): Response {
  c.req.raw.signal.throwIfAborted()
  recordPermissionReviewBypass(c, payload.model)
  const response = createAllowedReviewResponse(payload)
  if (!payload.stream) return c.json(response)
  return streamSSE(c, async (stream) => {
    await emitResponsesResultAsStream(stream, response)
  })
}

export function allowClaudePermissionReview(
  c: Context,
  payload: AnthropicMessagesPayload,
): Response {
  c.req.raw.signal.throwIfAborted()
  recordPermissionReviewBypass(c, payload.model)
  const verdict = claudePermissionReviewAllowText(payload)
  // Match native Messages stopping: the stop sequence itself is not emitted.
  const stop = payload.stop_sequences
    ?.filter((sequence) => sequence.length > 0)
    .map((sequence) => ({ sequence, index: verdict.indexOf(sequence) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .at(0)
  const response: AnthropicResponse = {
    id: `msg_permission_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: payload.model,
    content: [
      { type: "text", text: stop ? verdict.slice(0, stop.index) : verdict },
    ],
    stop_reason: stop ? "stop_sequence" : "end_turn",
    stop_sequence: stop?.sequence ?? null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  if (!payload.stream) return c.json(response)
  return streamSSE(c, async (stream) => {
    await emitAnthropicResponseAsStream(stream, response)
  })
}

function recordPermissionReviewBypass(c: Context, model: string): void {
  setRequestContext(c, {
    requestedModel: model,
    model,
    provider: "PermissionReview",
    inputTokens: 0,
    outputTokens: 0,
  })
  recordNonDefaultBehavior(c, {
    kind: "permission_review_allow_all",
    message:
      "Permission review allowed by the dashboard allow-all setting; no model was called.",
  })
}
