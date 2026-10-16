/* eslint-disable @typescript-eslint/require-await -- Bounded deterministic upstream fixtures. */
import { expect, test } from "bun:test"

import type { ObservedRequestUsage } from "~/lib/request-usage"
import type { WebProtocol } from "~/services/web/tool-context"
import type { WebEvent } from "~/services/web/tool-loop"

import { runWithRequestUsageObserver } from "~/lib/request-usage"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

const web = {
  type: "function_call",
  id: "web-item",
  call_id: "web",
  name: "_copilot_web_search",
  arguments: '{"query":"news"}',
}
function result(
  protocol: WebProtocol,
  final: boolean,
): Record<string, unknown> {
  const usage =
    protocol === "chat" ?
      { prompt_tokens: 2, completion_tokens: 3 }
    : { input_tokens: 2, output_tokens: 3 }
  if (protocol === "messages")
    return {
      id: "root",
      content:
        final ?
          [{ type: "text", text: "answer" }]
        : [
            {
              type: "tool_use",
              id: "web",
              name: web.name,
              input: { query: "news" },
            },
          ],
      stop_reason: final ? "end_turn" : "tool_use",
      usage,
    }
  if (protocol === "chat")
    return {
      id: "root",
      choices: [
        {
          index: 0,
          finish_reason: final ? "stop" : "tool_calls",
          message: {
            role: "assistant",
            content: final ? "answer" : null,
            ...(final ?
              {}
            : {
                tool_calls: [
                  {
                    id: "web",
                    type: "function",
                    function: { name: web.name, arguments: web.arguments },
                  },
                ],
              }),
          },
        },
      ],
      usage,
    }
  return {
    id: "root",
    status: "completed",
    output:
      final ?
        [
          {
            type: "message",
            id: "answer",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ]
      : [web],
    usage,
  }
}

async function* streamResult(
  protocol: WebProtocol,
  final: boolean,
): AsyncGenerator<WebEvent> {
  const response = result(protocol, final)
  if (protocol === "messages") {
    yield emit({
      type: "message_start",
      message: { id: "root", usage: { input_tokens: 2, output_tokens: 0 } },
    })
    yield emit({
      type: "content_block_start",
      index: 0,
      content_block: (response.content as Array<Record<string, unknown>>)[0],
    })
    yield emit({ type: "content_block_stop", index: 0 })
    yield emit({
      type: "message_delta",
      delta: { stop_reason: response.stop_reason },
      usage: { output_tokens: 3 },
    })
    yield emit({ type: "message_stop" })
  } else if (protocol === "chat") {
    const choice = (response.choices as Array<Record<string, unknown>>)[0]
    const message = choice.message as Record<string, unknown>
    yield emit({
      id: "root",
      choices: [
        {
          index: 0,
          delta: {
            ...message,
            ...(final ?
              {}
            : {
                tool_calls: [
                  {
                    ...(
                      message.tool_calls as Array<Record<string, unknown>>
                    )[0],
                    index: 0,
                  },
                ],
              }),
          },
          finish_reason: choice.finish_reason,
        },
      ],
    })
    yield emit({ id: "root", choices: [], usage: response.usage })
    yield { data: "[DONE]" }
  } else {
    yield emit({ type: "response.created", response: { id: "root" } })
    const item = (response.output as Array<Record<string, unknown>>)[0]
    yield emit({ type: "response.output_item.added", output_index: 0, item })
    yield emit({ type: "response.output_item.done", output_index: 0, item })
    yield emit({ type: "response.completed", response })
  }
}

const emit = (value: Record<string, unknown>): WebEvent => ({
  data: JSON.stringify(value),
})

for (const protocol of ["messages", "chat", "responses"] as const)
  for (const stream of [false, true])
    test.each([false, true])(
      `${protocol} ${stream ? "streamed" : "buffered"} stops at the last inspectable round (final=%s)`,
      async (finalOnLast) => {
        let sends = 0
        const checkpoints: Array<ObservedRequestUsage> = []
        const payload = {
          model: "fixture",
          input: "open",
          messages: [],
          stream,
        }
        const outcome = await runWithRequestUsageObserver(
          (usage) => checkpoints.push(usage),
          () =>
            runWithWebTools(payload, async () => {
              const response = await runManagedWebRequest({
                protocol,
                payload,
                send: async () => {
                  const final = ++sends === 18 && finalOnLast
                  return stream ?
                      streamResult(protocol, final)
                    : result(protocol, final)
                },
                execute: async () => ({
                  text: "max_uses_exceeded",
                  isError: true,
                }),
              })
              if (!isWebStream(response)) return response
              const events: Array<WebEvent> = []
              for await (const event of response) events.push(event)
              return events
            }),
        ).catch((error: unknown) => error)
        expect(sends).toBe(18)
        expect(checkpoints.at(-1)).toMatchObject({
          inputTokens: 36,
          outputTokens: 54,
        })
        if (finalOnLast) {
          expect(outcome).not.toBeInstanceOf(Error)
          expect(JSON.stringify(outcome)).toContain("answer")
        } else {
          expect(outcome).toBeInstanceOf(Error)
          expect(String(outcome)).toContain("continuation limit exceeded")
        }
      },
    )
