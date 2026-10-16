import type { WebProtocol } from "./tool-context"
import type { ManagedToolResult, WebToolCall } from "./tool-executor"

import { isRecord } from "./tool-context"

export interface CompletedWebCall {
  call: WebToolCall
  result: ManagedToolResult
}
const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item: unknown) => isRecord(item)) : []
export { records }

/** Legacy explicit search adapters must also return unfulfilled client calls. */
export function mixedWebSearchResponse(
  response: Record<string, unknown>,
  protocol: WebProtocol,
  results: ReadonlyArray<{ id: string; text: string }>,
): Record<string, unknown> | undefined {
  const completed = results.map(({ id, text }) => ({
    call: { id, name: "web_search", input: {} },
    result: { text, isError: /^Web search (?:failed|error):/.test(text) },
  }))
  const ids = new Set(results.map((result) => result.id))
  if (
    !responseCalls(response, protocol).some(
      (call) => call.clientOwned || !ids.has(call.id),
    )
  )
    return undefined
  return withoutManagedCalls(response, completed, protocol)
}

export function responseCalls(
  response: Record<string, unknown>,
  protocol: WebProtocol,
): Array<WebToolCall> {
  if (protocol === "messages")
    return records(response.content)
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: String(b.id),
        name: String(b.name),
        input: b.input,
      }))
  if (protocol === "responses")
    return records(response.output)
      .filter(
        (b) =>
          b.type === "function_call"
          || b.type === "custom_tool_call"
          || (b.type === "tool_search_call" && b.execution === "client"),
      )
      .map((b) => ({
        id: String(b.call_id),
        name: String(b.name),
        input: b.arguments,
        clientOwned: b.type !== "function_call" || Boolean(b.namespace),
      }))
  const choice = records(response.choices).at(0)
  const message = choice && isRecord(choice.message) ? choice.message : {}
  return records(message.tool_calls).map((call) => {
    if (call.type === "custom" || isRecord(call.custom)) {
      const custom = isRecord(call.custom) ? call.custom : {}
      return {
        id: String(call.id),
        name: String(custom.name),
        input: custom.input,
        clientOwned: true,
      }
    }
    const fn = isRecord(call.function) ? call.function : {}
    return { id: String(call.id), name: String(fn.name), input: fn.arguments }
  })
}

/** Terminal failures can contain unfinished tool arguments; never run or expose owned calls. */
export function withoutUnexecutedManagedCalls(
  response: Record<string, unknown>,
  managed: ReadonlyMap<string, unknown>,
  protocol: WebProtocol,
): Record<string, unknown> {
  if (protocol !== "responses") return response
  const output = records(response.output).filter(
    (item) =>
      item.type !== "function_call"
      || Boolean(item.namespace)
      || !managed.has(String(item.name)),
  )
  return {
    ...response,
    output,
    ...(response.output_text === undefined ?
      {}
    : { output_text: responseOutputText(output) }),
  }
}

export function isUnsuccessfulResponses(
  response: Record<string, unknown>,
  protocol: WebProtocol,
): boolean {
  return (
    protocol === "responses"
    && (response.status === "failed" || response.status === "incomplete")
  )
}

export function continuationPayload(
  payload: Record<string, unknown>,
  response: Record<string, unknown>,
  options: {
    completed: ReadonlyArray<CompletedWebCall>
    protocol: WebProtocol
  },
): Record<string, unknown> {
  const { completed, protocol } = options
  const next = {
    ...payload,
    tool_choice:
      protocol === "messages" ?
        {
          type: "auto",
          ...((
            isRecord(payload.tool_choice)
            && typeof payload.tool_choice.disable_parallel_tool_use
              === "boolean"
          ) ?
            {
              disable_parallel_tool_use:
                payload.tool_choice.disable_parallel_tool_use,
            }
          : {}),
        }
      : "auto",
  }
  if (protocol === "messages")
    return {
      ...next,
      messages: [
        ...records(payload.messages),
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: completed.map(({ call, result }) => ({
            type: "tool_result",
            tool_use_id: call.id,
            content: result.text,
            ...(result.isError ? { is_error: true } : {}),
          })),
        },
      ],
    }
  if (protocol === "responses")
    return {
      ...next,
      input: [
        ...(typeof payload.input === "string" ?
          [{ role: "user", content: payload.input }]
        : records(payload.input)),
        ...records(response.output),
        ...completed.map(({ call, result }) => ({
          type: "function_call_output",
          call_id: call.id,
          output: result.text,
        })),
      ],
    }
  const choice = records(response.choices).at(0)
  return {
    ...next,
    messages: [
      ...records(payload.messages),
      choice?.message,
      ...completed.map(({ call, result }) => ({
        role: "tool",
        tool_call_id: call.id,
        content: result.text,
      })),
    ],
  }
}

export function completedWebText(
  completed: ReadonlyArray<CompletedWebCall>,
): string {
  return completed
    .map(
      ({ call, result }) =>
        `[Web tool ${call.name}${result.isError ? " failed" : " result"}]\n${result.text}\n[End web tool result]`,
    )
    .join("\n\n")
}

export function withoutManagedCalls(
  response: Record<string, unknown>,
  completed: ReadonlyArray<CompletedWebCall>,
  protocol: WebProtocol,
): Record<string, unknown> {
  const ids = new Set(completed.map((c) => c.call.id))
  const evidence = completedWebText(completed)
  if (protocol === "messages")
    return {
      ...response,
      content: records(response.content).flatMap((block) => {
        if (block.type !== "tool_use" || !ids.has(String(block.id)))
          return [block]
        const found = completed.find((c) => c.call.id === block.id)
        if (!found) throw new TypeError("Missing completed tool result")
        return [{ type: "text", text: completedWebText([found]) }]
      }),
    }
  if (protocol === "responses") {
    const output = records(response.output).flatMap((item) => {
      if (item.type !== "function_call" || !ids.has(String(item.call_id)))
        return [item]
      const found = completed.find((c) => c.call.id === item.call_id)
      if (!found) throw new TypeError("Missing completed tool result")
      return [
        {
          type: "message",
          id: `web_result_${String(item.call_id)}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: completedWebText([found]),
              annotations: [],
            },
          ],
        },
      ]
    })
    return { ...response, output, output_text: responseOutputText(output) }
  }
  return {
    ...response,
    choices: records(response.choices).map((choice) => {
      if (!isRecord(choice.message)) return choice
      const message = choice.message
      return {
        ...choice,
        message: {
          ...message,
          content: [message.content, evidence].filter(Boolean).join("\n\n"),
          tool_calls: records(message.tool_calls).filter(
            (call) => !ids.has(String(call.id)),
          ),
        },
      }
    }),
  }
}

export function responseOutputText(
  output: Array<Record<string, unknown>>,
): string {
  return output
    .flatMap((item) =>
      item.type === "message" ?
        records(item.content).map((part) =>
          typeof part.text === "string" ? part.text : "",
        )
      : [],
    )
    .join("")
}

export function sumUsage(
  first: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(next)) return isRecord(first) ? first : undefined
  const merged = isRecord(first) ? { ...first } : {}
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number")
      merged[key] = (typeof merged[key] === "number" ? merged[key] : 0) + value
    else if (isRecord(value)) merged[key] = sumUsage(merged[key], value)
    else merged[key] = value
  }
  return merged
}
