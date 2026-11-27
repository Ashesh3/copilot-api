/* eslint-disable complexity, max-lines, max-lines-per-function, no-nested-ternary, @typescript-eslint/no-unsafe-assignment */
import type {
  AssistantDiffOp,
  CanonicalItem,
  CanonicalItemKind,
  CanonicalProtocol,
  CanonicalView,
  InterceptPhase,
} from "./types"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function detectProtocol(
  path: string,
  parsed: unknown,
): CanonicalProtocol {
  if (path.includes("/v1/messages")) return "anthropic_messages"
  if (path.includes("/responses")) return "responses"
  if (path.includes("/chat/completions")) return "chat_completions"

  if (isRecord(parsed)) {
    if (Array.isArray(parsed.messages)) {
      if ("system" in parsed || parsed.type === "message") {
        return "anthropic_messages"
      }
      return "chat_completions"
    }
    if (
      "input" in parsed
      || "output" in parsed
      || parsed.object === "response"
    ) {
      return "responses"
    }
    if (Array.isArray(parsed.choices)) {
      return "chat_completions"
    }
    if (parsed.type === "message" && Array.isArray(parsed.content)) {
      return "anthropic_messages"
    }
    return "generic_json"
  }
  return "raw_text"
}

export function isSseBody(body: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().includes("text/event-stream")) return true
  const trimmed = body.trimStart()
  return trimmed.startsWith("data:") || trimmed.startsWith("event:")
}

interface ParsedSseEvent {
  event?: string
  data: string
}

export function parseSseEvents(body: string): Array<ParsedSseEvent> {
  const events: Array<ParsedSseEvent> = []
  const normalized = body.replaceAll("\r\n", "\n")
  const blocks = normalized.split("\n\n")
  for (const block of blocks) {
    if (!block.trim()) continue
    let eventName: string | undefined
    const dataLines: Array<string> = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length > 0 || eventName) {
      events.push({
        ...(eventName ? { event: eventName } : {}),
        data: dataLines.join("\n"),
      })
    }
  }
  return events
}

function extractTextFromContent(content: unknown): {
  text: string
  opaque: boolean
} {
  if (typeof content === "string") {
    return { text: content, opaque: false }
  }
  if (content === null || content === undefined) {
    return { text: "", opaque: false }
  }
  if (!Array.isArray(content)) {
    return { text: JSON.stringify(content, null, 2), opaque: true }
  }
  const parts: Array<string> = []
  let opaque = false
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part)
    } else if (isRecord(part)) {
      if (
        (part.type === "text"
          || part.type === "input_text"
          || part.type === "output_text")
        && typeof part.text === "string"
      ) {
        parts.push(part.text)
      } else {
        opaque = true
        parts.push(`[${asString(part.type) ?? "part"}]`)
      }
    }
  }
  return { text: parts.join("\n"), opaque }
}

function roleToKind(role: string | undefined): CanonicalItemKind {
  switch (role) {
    case "system": {
      return "system"
    }
    case "developer": {
      return "developer"
    }
    case "user": {
      return "user"
    }
    case "assistant": {
      return "assistant"
    }
    case "tool": {
      return "tool_result"
    }
    default: {
      return "other"
    }
  }
}

function parseChatCompletionsRequest(parsed: JsonRecord): CanonicalView {
  const items: Array<CanonicalItem> = []
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []

  for (const [i, msg] of messages.entries()) {
    if (!isRecord(msg)) continue
    const role = asString(msg.role) ?? "user"
    const kind = roleToKind(role)
    const { text, opaque } = extractTextFromContent(msg.content)

    if (role === "tool") {
      items.push({
        id: `msg-${i}`,
        kind: "tool_result",
        role: "tool",
        label: `Tool Result${asString(msg.name) ? ` (${asString(msg.name)})` : ""}`,
        content: text,
        toolName: asString(msg.name),
        toolCallId: asString(msg.tool_call_id),
        opaque,
      })
      continue
    }

    if (text || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      items.push({
        id: `msg-${i}`,
        kind,
        role,
        label: role.charAt(0).toUpperCase() + role.slice(1),
        content: text,
        opaque,
      })
    }

    if (Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j]
        if (!isRecord(tc)) continue
        const fn = isRecord(tc.function) ? tc.function : {}
        const name = asString(fn.name) ?? "tool"
        const args = asString(fn.arguments) ?? "{}"
        items.push({
          id: `msg-${i}-tc-${j}`,
          kind: "tool_call",
          role: "assistant",
          label: `Tool Call: ${name}`,
          content: args,
          toolName: name,
          toolCallId: asString(tc.id),
          toolArguments: args,
        })
      }
    }
  }

  return {
    protocol: "chat_completions",
    phase: "request",
    model: asString(parsed.model),
    stream: asBoolean(parsed.stream),
    items,
    editable: true,
  }
}

function parseAnthropicRequest(parsed: JsonRecord): CanonicalView {
  const items: Array<CanonicalItem> = []

  if (typeof parsed.system === "string") {
    items.push({
      id: "sys-0",
      kind: "system",
      role: "system",
      label: "System Prompt",
      content: parsed.system,
    })
  } else if (Array.isArray(parsed.system)) {
    for (let i = 0; i < parsed.system.length; i++) {
      const block = parsed.system[i]
      if (isRecord(block) && typeof block.text === "string") {
        items.push({
          id: `sys-${i}`,
          kind: "system",
          role: "system",
          label: `System #${i + 1}`,
          content: block.text,
        })
      }
    }
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  for (const [i, msg] of messages.entries()) {
    if (!isRecord(msg)) continue
    const role = asString(msg.role) ?? "user"

    if (typeof msg.content === "string") {
      items.push({
        id: `msg-${i}`,
        kind: roleToKind(role),
        role,
        label: role.charAt(0).toUpperCase() + role.slice(1),
        content: msg.content,
      })
      continue
    }

    if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]
        if (!isRecord(block)) continue
        const blockType = asString(block.type)
        if (blockType === "text" && typeof block.text === "string") {
          items.push({
            id: `msg-${i}-blk-${j}`,
            kind: roleToKind(role),
            role,
            label: role.charAt(0).toUpperCase() + role.slice(1),
            content: block.text,
          })
        } else if (
          blockType === "thinking"
          && typeof block.thinking === "string"
        ) {
          items.push({
            id: `msg-${i}-blk-${j}`,
            kind: "thinking",
            role,
            label: "Thinking",
            content: block.thinking,
          })
        } else if (blockType === "tool_use") {
          const name = asString(block.name) ?? "tool"
          const args = JSON.stringify(block.input ?? {}, null, 2)
          items.push({
            id: `msg-${i}-blk-${j}`,
            kind: "tool_call",
            role: "assistant",
            label: `Tool Call: ${name}`,
            content: args,
            toolName: name,
            toolCallId: asString(block.id),
            toolArguments: args,
          })
        } else if (blockType === "tool_result") {
          const { text, opaque } = extractTextFromContent(block.content)
          items.push({
            id: `msg-${i}-blk-${j}`,
            kind: "tool_result",
            role: "user",
            label: "Tool Result",
            content: text,
            toolCallId: asString(block.tool_use_id),
            opaque,
          })
        } else {
          items.push({
            id: `msg-${i}-blk-${j}`,
            kind: "other",
            role,
            label: `Block: ${blockType ?? "unknown"}`,
            content: JSON.stringify(block, null, 2),
            opaque: true,
          })
        }
      }
    }
  }

  return {
    protocol: "anthropic_messages",
    phase: "request",
    model: asString(parsed.model),
    stream: asBoolean(parsed.stream),
    items,
    editable: true,
  }
}

function parseResponsesRequest(parsed: JsonRecord): CanonicalView {
  const items: Array<CanonicalItem> = []

  if (typeof parsed.instructions === "string") {
    items.push({
      id: "sys-0",
      kind: "system",
      role: "system",
      label: "Instructions",
      content: parsed.instructions,
    })
  }

  if (typeof parsed.input === "string") {
    items.push({
      id: "in-0",
      kind: "user",
      role: "user",
      label: "User Input",
      content: parsed.input,
    })
  } else if (Array.isArray(parsed.input)) {
    for (let i = 0; i < parsed.input.length; i++) {
      const entry = parsed.input[i]
      if (!isRecord(entry)) continue
      const type = asString(entry.type)
      switch (type) {
        case "function_call": {
          const name = asString(entry.name) ?? "tool"
          const args = asString(entry.arguments) ?? "{}"
          items.push({
            id: `in-${i}`,
            kind: "tool_call",
            role: "assistant",
            label: `Tool Call: ${name}`,
            content: args,
            toolName: name,
            toolCallId: asString(entry.call_id) ?? asString(entry.id),
            toolArguments: args,
          })

          break
        }
        case "function_call_output": {
          const output =
            typeof entry.output === "string" ?
              entry.output
            : JSON.stringify(entry.output ?? "")
          items.push({
            id: `in-${i}`,
            kind: "tool_result",
            role: "tool",
            label: "Tool Result",
            content: output,
            toolCallId: asString(entry.call_id),
          })

          break
        }
        case "reasoning": {
          const summary =
            Array.isArray(entry.summary) ?
              entry.summary
                .map((s) => (isRecord(s) ? (asString(s.text) ?? "") : ""))
                .filter(Boolean)
                .join("\n")
            : ""
          items.push({
            id: `in-${i}`,
            kind: "thinking",
            role: "assistant",
            label: "Reasoning",
            content: summary,
            opaque: true,
          })

          break
        }
        default: {
          const role = asString(entry.role) ?? "user"
          const { text, opaque } = extractTextFromContent(entry.content)
          items.push({
            id: `in-${i}`,
            kind: roleToKind(role),
            role,
            label: role.charAt(0).toUpperCase() + role.slice(1),
            content: text,
            opaque,
          })
        }
      }
    }
  }

  return {
    protocol: "responses",
    phase: "request",
    model: asString(parsed.model),
    stream: asBoolean(parsed.stream),
    items,
    editable: true,
  }
}

function parseChatCompletionsResponseJson(parsed: JsonRecord): CanonicalView {
  const items: Array<CanonicalItem> = []
  const choices = Array.isArray(parsed.choices) ? parsed.choices : []
  let stopReason: string | undefined

  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i]
    if (!isRecord(choice)) continue
    stopReason ??= asString(choice.finish_reason)
    const msg = isRecord(choice.message) ? choice.message : {}
    const reasoning =
      asString(msg.reasoning_content) ?? asString(msg.reasoning_text)
    if (reasoning) {
      items.push({
        id: `out-${i}-think`,
        kind: "thinking",
        role: "assistant",
        label: "Thinking",
        content: reasoning,
      })
    }
    const { text } = extractTextFromContent(msg.content)
    if (text || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      items.push({
        id: `out-${i}`,
        kind: "assistant",
        role: "assistant",
        label: choices.length > 1 ? `Assistant #${i + 1}` : "Assistant",
        content: text,
      })
    }
    if (Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j]
        if (!isRecord(tc)) continue
        const fn = isRecord(tc.function) ? tc.function : {}
        const name = asString(fn.name) ?? "tool"
        const args = asString(fn.arguments) ?? "{}"
        items.push({
          id: `out-${i}-tc-${j}`,
          kind: "tool_call",
          role: "assistant",
          label: `Tool Call: ${name}`,
          content: args,
          toolName: name,
          toolCallId: asString(tc.id),
          toolArguments: args,
        })
      }
    }
  }

  return {
    protocol: "chat_completions",
    phase: "response",
    model: asString(parsed.model),
    stream: false,
    stopReason,
    items,
    editable: true,
  }
}

function parseChatCompletionsResponseSse(body: string): CanonicalView {
  const events = parseSseEvents(body)
  let model: string | undefined
  let stopReason: string | undefined
  let text = ""
  let reasoning = ""
  const toolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()

  for (const ev of events) {
    if (ev.data === "[DONE]") continue
    try {
      const parsed: unknown = JSON.parse(ev.data)
      if (!isRecord(parsed)) continue
      model ??= asString(parsed.model)
      const choices = Array.isArray(parsed.choices) ? parsed.choices : []
      const first = choices[0]
      if (!isRecord(first)) continue
      if (asString(first.finish_reason)) {
        stopReason = asString(first.finish_reason)
      }
      const delta = isRecord(first.delta) ? first.delta : {}
      if (typeof delta.content === "string") text += delta.content
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content
      } else if (typeof delta.reasoning_text === "string") {
        reasoning += delta.reasoning_text
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!isRecord(tc)) continue
          const idx = typeof tc.index === "number" ? tc.index : 0
          const existing = toolCalls.get(idx) ?? {
            id: asString(tc.id) ?? `call_${idx}`,
            name: "",
            arguments: "",
          }
          const tcId = asString(tc.id)
          if (tcId) existing.id = tcId
          const fn = isRecord(tc.function) ? tc.function : {}
          const fnName = asString(fn.name)
          if (fnName) existing.name += fnName
          const fnArgs = asString(fn.arguments)
          if (fnArgs) existing.arguments += fnArgs
          toolCalls.set(idx, existing)
        }
      }
    } catch {
      // ignore non-JSON SSE chunks
    }
  }

  const items: Array<CanonicalItem> = []
  if (reasoning) {
    items.push({
      id: "out-0-think",
      kind: "thinking",
      role: "assistant",
      label: "Thinking",
      content: reasoning,
    })
  }
  if (text || toolCalls.size === 0) {
    items.push({
      id: "out-0",
      kind: "assistant",
      role: "assistant",
      label: "Assistant",
      content: text,
    })
  }
  for (const [idx, tc] of [...toolCalls.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    items.push({
      id: `out-0-tc-${idx}`,
      kind: "tool_call",
      role: "assistant",
      label: `Tool Call: ${tc.name || "tool"}`,
      content: tc.arguments,
      toolName: tc.name || "tool",
      toolCallId: tc.id,
      toolArguments: tc.arguments,
    })
  }

  return {
    protocol: "chat_completions",
    phase: "response",
    model,
    stream: true,
    stopReason,
    items,
    editable: true,
    note: "Buffered SSE stream — structured edits re-synthesize clean SSE events on Forward.",
  }
}

function parseAnthropicResponseJson(parsed: JsonRecord): CanonicalView {
  const items: Array<CanonicalItem> = []
  const content = Array.isArray(parsed.content) ? parsed.content : []
  for (const [i, block] of content.entries()) {
    if (!isRecord(block)) continue
    const blockType = asString(block.type)
    if (blockType === "text" && typeof block.text === "string") {
      items.push({
        id: `out-${i}`,
        kind: "assistant",
        role: "assistant",
        label: "Assistant",
        content: block.text,
      })
    } else if (blockType === "thinking" && typeof block.thinking === "string") {
      items.push({
        id: `out-${i}`,
        kind: "thinking",
        role: "assistant",
        label: "Thinking",
        content: block.thinking,
      })
    } else if (blockType === "tool_use") {
      const name = asString(block.name) ?? "tool"
      const args = JSON.stringify(block.input ?? {}, null, 2)
      items.push({
        id: `out-${i}`,
        kind: "tool_call",
        role: "assistant",
        label: `Tool Call: ${name}`,
        content: args,
        toolName: name,
        toolCallId: asString(block.id),
        toolArguments: args,
      })
    }
  }

  return {
    protocol: "anthropic_messages",
    phase: "response",
    model: asString(parsed.model),
    stream: false,
    stopReason: asString(parsed.stop_reason),
    items,
    editable: true,
  }
}

function parseAnthropicResponseSse(body: string): CanonicalView {
  const events = parseSseEvents(body)
  let model: string | undefined
  let stopReason: string | undefined
  const blocks = new Map<
    number,
    { type: string; text: string; name?: string; id?: string }
  >()

  for (const ev of events) {
    try {
      const parsed: unknown = JSON.parse(ev.data)
      if (!isRecord(parsed)) continue
      const evType = asString(parsed.type) ?? ev.event
      if (evType === "message_start" && isRecord(parsed.message)) {
        model = asString(parsed.message.model)
      } else if (evType === "message_delta" && isRecord(parsed.delta)) {
        stopReason = asString(parsed.delta.stop_reason) ?? stopReason
      } else if (
        evType === "content_block_start"
        && typeof parsed.index === "number"
        && isRecord(parsed.content_block)
      ) {
        const cb = parsed.content_block
        blocks.set(parsed.index, {
          type: asString(cb.type) ?? "text",
          text: asString(cb.text) ?? asString(cb.thinking) ?? "",
          name: asString(cb.name),
          id: asString(cb.id),
        })
      } else if (
        evType === "content_block_delta"
        && typeof parsed.index === "number"
        && isRecord(parsed.delta)
      ) {
        const existing = blocks.get(parsed.index)
        if (!existing) continue
        const delta = parsed.delta
        if (typeof delta.text === "string") existing.text += delta.text
        if (typeof delta.thinking === "string") existing.text += delta.thinking
        if (typeof delta.partial_json === "string") {
          existing.text += delta.partial_json
        }
      }
    } catch {
      // ignore non-JSON
    }
  }

  const items: Array<CanonicalItem> = []
  for (const [idx, blk] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (blk.type === "thinking") {
      items.push({
        id: `out-${idx}`,
        kind: "thinking",
        role: "assistant",
        label: "Thinking",
        content: blk.text,
      })
    } else if (blk.type === "tool_use") {
      items.push({
        id: `out-${idx}`,
        kind: "tool_call",
        role: "assistant",
        label: `Tool Call: ${blk.name ?? "tool"}`,
        content: blk.text || "{}",
        toolName: blk.name ?? "tool",
        toolCallId: blk.id,
        toolArguments: blk.text || "{}",
      })
    } else {
      items.push({
        id: `out-${idx}`,
        kind: "assistant",
        role: "assistant",
        label: "Assistant",
        content: blk.text,
      })
    }
  }

  return {
    protocol: "anthropic_messages",
    phase: "response",
    model,
    stream: true,
    stopReason,
    items,
    editable: true,
    note: "Buffered Anthropic SSE stream — structured edits re-synthesize clean SSE events on Forward.",
  }
}

function parseResponsesOutputArray(
  output: ReadonlyArray<unknown>,
): Array<CanonicalItem> {
  const items: Array<CanonicalItem> = []
  for (const [i, entry] of output.entries()) {
    if (!isRecord(entry)) continue
    const type = asString(entry.type)
    switch (type) {
      case "message": {
        const { text } = extractTextFromContent(entry.content)
        items.push({
          id: `out-${i}`,
          kind: "assistant",
          role: "assistant",
          label: "Assistant",
          content: text,
        })

        break
      }
      case "function_call": {
        const name = asString(entry.name) ?? "tool"
        const args = asString(entry.arguments) ?? "{}"
        items.push({
          id: `out-${i}`,
          kind: "tool_call",
          role: "assistant",
          label: `Tool Call: ${name}`,
          content: args,
          toolName: name,
          toolCallId: asString(entry.call_id) ?? asString(entry.id),
          toolArguments: args,
        })

        break
      }
      case "reasoning": {
        const summary =
          Array.isArray(entry.summary) ?
            entry.summary
              .map((s) => (isRecord(s) ? (asString(s.text) ?? "") : ""))
              .filter(Boolean)
              .join("\n")
          : ""
        items.push({
          id: `out-${i}`,
          kind: "thinking",
          role: "assistant",
          label: "Reasoning",
          content: summary,
        })

        break
      }
      // No default
    }
  }
  return items
}

function parseResponsesResponseJson(parsed: JsonRecord): CanonicalView {
  const output = Array.isArray(parsed.output) ? parsed.output : []
  return {
    protocol: "responses",
    phase: "response",
    model: asString(parsed.model),
    stream: false,
    stopReason: asString(parsed.status),
    items: parseResponsesOutputArray(output),
    editable: true,
  }
}

function parseResponsesResponseSse(body: string): CanonicalView {
  const events = parseSseEvents(body)
  let finalResponse: JsonRecord | undefined
  let model: string | undefined
  let text = ""

  for (const ev of events) {
    try {
      const parsed: unknown = JSON.parse(ev.data)
      if (!isRecord(parsed)) continue
      const evType = asString(parsed.type) ?? ev.event
      if (
        (evType === "response.completed" || evType === "response.done")
        && isRecord(parsed.response)
      ) {
        finalResponse = parsed.response
      } else if (evType === "response.created" && isRecord(parsed.response)) {
        model ??= asString(parsed.response.model)
      } else if (
        evType === "response.output_text.delta"
        && typeof parsed.delta === "string"
      ) {
        text += parsed.delta
      }
    } catch {
      // ignore non-JSON
    }
  }

  if (finalResponse) {
    const view = parseResponsesResponseJson(finalResponse)
    return {
      ...view,
      stream: true,
      note: "Buffered Responses SSE stream — structured edits re-synthesize clean SSE events on Forward.",
    }
  }

  return {
    protocol: "responses",
    phase: "response",
    model,
    stream: true,
    items:
      text ?
        [
          {
            id: "out-0",
            kind: "assistant",
            role: "assistant",
            label: "Assistant",
            content: text,
          },
        ]
      : [],
    editable: true,
    note: "Buffered Responses SSE stream — structured edits re-synthesize clean SSE events on Forward.",
  }
}

export function parseCanonicalView(options: {
  path: string
  phase: InterceptPhase
  body: string
  contentType?: string
}): CanonicalView {
  const { path, phase, body, contentType } = options

  if (phase === "response" && isSseBody(body, contentType)) {
    const protocol = detectProtocol(path, null)
    if (protocol === "anthropic_messages") {
      return parseAnthropicResponseSse(body)
    }
    if (protocol === "responses") {
      return parseResponsesResponseSse(body)
    }
    return parseChatCompletionsResponseSse(body)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      protocol: "raw_text",
      phase,
      items: [
        {
          id: "raw-0",
          kind: "other",
          label: "Raw Body",
          content: body,
        },
      ],
      editable: false,
      note: "Non-JSON payload — edit directly in Raw Editor.",
    }
  }

  const protocol = detectProtocol(path, parsed)
  if (!isRecord(parsed)) {
    return {
      protocol: "generic_json",
      phase,
      items: [
        {
          id: "json-0",
          kind: "other",
          label: "JSON Body",
          content: JSON.stringify(parsed, null, 2),
        },
      ],
      editable: false,
    }
  }

  if (phase === "request") {
    if (protocol === "chat_completions") {
      return parseChatCompletionsRequest(parsed)
    }
    if (protocol === "anthropic_messages") {
      return parseAnthropicRequest(parsed)
    }
    if (protocol === "responses") {
      return parseResponsesRequest(parsed)
    }
  } else {
    if (protocol === "chat_completions") {
      return parseChatCompletionsResponseJson(parsed)
    }
    if (protocol === "anthropic_messages") {
      return parseAnthropicResponseJson(parsed)
    }
    if (protocol === "responses") {
      return parseResponsesResponseJson(parsed)
    }
  }

  return {
    protocol: "generic_json",
    phase,
    model: asString(parsed.model),
    items: [
      {
        id: "json-0",
        kind: "other",
        label: "JSON Payload",
        content: JSON.stringify(parsed, null, 2),
      },
    ],
    editable: false,
  }
}

export function applyCanonicalDiffOps(
  items: ReadonlyArray<CanonicalItem>,
  operations: ReadonlyArray<AssistantDiffOp>,
): Array<CanonicalItem> {
  let next = items.map((item) => ({ ...item }))
  let insertCounter = 0

  for (const op of operations) {
    switch (op.op) {
      case "replace": {
        const idx = next.findIndex((item) => item.id === op.id)
        if (idx === -1) continue
        const current = next[idx]
        const updated: CanonicalItem = {
          ...current,
          ...(op.content !== undefined ? { content: op.content } : {}),
          ...(op.toolName !== undefined ? { toolName: op.toolName } : {}),
          ...(op.toolArguments !== undefined ?
            {
              toolArguments: op.toolArguments,
              content: op.content ?? op.toolArguments,
            }
          : {}),
        }
        if (updated.kind === "tool_call" && updated.toolName) {
          updated.label = `Tool Call: ${updated.toolName}`
        }
        next[idx] = updated

        break
      }
      case "delete": {
        next = next.filter((item) => item.id !== op.id)

        break
      }
      case "insert_after": {
        insertCounter += 1
        const newItem: CanonicalItem = {
          id: `ins-${insertCounter}`,
          kind: op.kind,
          role:
            op.kind === "tool_call" || op.kind === "thinking" ? "assistant"
            : op.kind === "tool_result" ? "tool"
            : op.kind,
          label:
            op.kind === "tool_call" ? `Tool Call: ${op.toolName ?? "tool"}`
            : op.kind === "tool_result" ? "Tool Result"
            : op.kind.charAt(0).toUpperCase() + op.kind.slice(1),
          content: op.toolArguments ?? op.content,
          ...(op.toolName ? { toolName: op.toolName } : {}),
          ...(op.toolCallId ? { toolCallId: op.toolCallId } : {}),
          ...(op.toolArguments ? { toolArguments: op.toolArguments } : {}),
        }
        if (op.afterId === null) {
          next.unshift(newItem)
        } else {
          const idx = next.findIndex((item) => item.id === op.afterId)
          if (idx === -1) {
            next.push(newItem)
          } else {
            next.splice(idx + 1, 0, newItem)
          }
        }

        break
      }
      // No default
    }
  }

  return next
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function serializeChatCompletionsRequest(
  base: JsonRecord,
  items: ReadonlyArray<CanonicalItem>,
): string {
  const messages: Array<JsonRecord> = []
  for (const item of items) {
    if (item.kind === "tool_call") {
      const tc = {
        id: item.toolCallId ?? `call_${messages.length}`,
        type: "function",
        function: {
          name: item.toolName ?? "tool",
          arguments: item.toolArguments ?? item.content,
        },
      }
      const prev = messages.at(-1)
      if (prev && prev.role === "assistant") {
        const existing = Array.isArray(prev.tool_calls) ? prev.tool_calls : []
        prev.tool_calls = [...existing, tc]
      } else {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [tc],
        })
      }
    } else if (item.kind === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: item.toolCallId ?? "call_0",
        ...(item.toolName ? { name: item.toolName } : {}),
        content: item.content,
      })
    } else {
      const role =
        item.role
        ?? (item.kind === "system" ? "system"
        : item.kind === "developer" ? "developer"
        : item.kind === "assistant" ? "assistant"
        : "user")
      messages.push({
        role,
        content: item.content,
      })
    }
  }
  return JSON.stringify({ ...base, messages }, null, 2)
}

function serializeAnthropicRequest(
  base: JsonRecord,
  items: ReadonlyArray<CanonicalItem>,
): string {
  const systemBlocks: Array<JsonRecord> = []
  const messages: Array<JsonRecord> = []

  const pushBlock = (role: "user" | "assistant", block: JsonRecord) => {
    const prev = messages.at(-1)
    if (prev && prev.role === role && Array.isArray(prev.content)) {
      prev.content.push(block)
    } else {
      messages.push({ role, content: [block] })
    }
  }

  for (const item of items) {
    switch (item.kind) {
      case "system":
      case "developer": {
        systemBlocks.push({ type: "text", text: item.content })

        break
      }
      case "thinking": {
        pushBlock("assistant", { type: "thinking", thinking: item.content })

        break
      }
      case "tool_call": {
        pushBlock("assistant", {
          type: "tool_use",
          id: item.toolCallId ?? `toolu_${messages.length}`,
          name: item.toolName ?? "tool",
          input: safeJsonParse(item.toolArguments ?? item.content),
        })

        break
      }
      case "tool_result": {
        pushBlock("user", {
          type: "tool_result",
          tool_use_id: item.toolCallId ?? "toolu_0",
          content: item.content,
        })

        break
      }
      default: {
        const role: "user" | "assistant" =
          item.kind === "assistant" || item.role === "assistant" ?
            "assistant"
          : "user"
        pushBlock(role, { type: "text", text: item.content })
      }
    }
  }

  const next: JsonRecord = { ...base, messages }
  if (systemBlocks.length > 0) {
    next.system =
      typeof base.system === "string" && systemBlocks.length === 1 ?
        systemBlocks[0].text
      : systemBlocks
  } else if ("system" in next) {
    Reflect.deleteProperty(next, "system")
  }
  return JSON.stringify(next, null, 2)
}

function serializeResponsesRequest(
  base: JsonRecord,
  items: ReadonlyArray<CanonicalItem>,
): string {
  const instructionsParts: Array<string> = []
  const input: Array<JsonRecord> = []

  for (const item of items) {
    switch (item.kind) {
      case "system": {
        instructionsParts.push(item.content)

        break
      }
      case "tool_call": {
        input.push({
          type: "function_call",
          call_id: item.toolCallId ?? `call_${input.length}`,
          name: item.toolName ?? "tool",
          arguments: item.toolArguments ?? item.content,
        })

        break
      }
      case "tool_result": {
        input.push({
          type: "function_call_output",
          call_id: item.toolCallId ?? "call_0",
          output: item.content,
        })

        break
      }
      default: {
        const role =
          item.role
          ?? (item.kind === "developer" ? "developer"
          : item.kind === "assistant" ? "assistant"
          : "user")
        input.push({
          type: "message",
          role,
          content: [
            {
              type: role === "assistant" ? "output_text" : "input_text",
              text: item.content,
            },
          ],
        })
      }
    }
  }

  const next: JsonRecord = { ...base, input }
  if (instructionsParts.length > 0) {
    next.instructions = instructionsParts.join("\n\n")
  } else if ("instructions" in next) {
    Reflect.deleteProperty(next, "instructions")
  }
  return JSON.stringify(next, null, 2)
}

function serializeChatCompletionsResponseSse(
  items: ReadonlyArray<CanonicalItem>,
  meta: { model?: string; stopReason?: string },
): string {
  const id = `chatcmpl-intercept-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = meta.model ?? "gpt-4o"
  const chunks: Array<string> = []

  const pushChunk = (delta: JsonRecord, finishReason: string | null = null) => {
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    )
  }

  pushChunk({ role: "assistant" })

  let hasToolCalls = false
  let tcIndex = 0
  for (const item of items) {
    if (item.kind === "thinking" && item.content) {
      pushChunk({ reasoning_content: item.content })
    } else if (item.kind === "tool_call") {
      hasToolCalls = true
      pushChunk({
        tool_calls: [
          {
            index: tcIndex,
            id: item.toolCallId ?? `call_intercept_${tcIndex}`,
            type: "function",
            function: {
              name: item.toolName ?? "tool",
              arguments: item.toolArguments ?? item.content,
            },
          },
        ],
      })
      tcIndex += 1
    } else if (item.content) {
      pushChunk({ content: item.content })
    }
  }

  const finish = meta.stopReason ?? (hasToolCalls ? "tool_calls" : "stop")
  pushChunk({}, finish)
  chunks.push("data: [DONE]\n\n")
  return chunks.join("")
}

function serializeAnthropicResponseSse(
  items: ReadonlyArray<CanonicalItem>,
  meta: { model?: string; stopReason?: string },
): string {
  const id = `msg_intercept_${Date.now()}`
  const model = meta.model ?? "claude-sonnet-4"
  const chunks: Array<string> = []

  const pushEvent = (event: string, data: JsonRecord) => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  pushEvent("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  let hasToolUse = false
  for (const [index, item] of items.entries()) {
    if (item.kind === "thinking") {
      pushEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      })
      pushEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: item.content },
      })
      pushEvent("content_block_stop", { type: "content_block_stop", index })
    } else if (item.kind === "tool_call") {
      hasToolUse = true
      pushEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: item.toolCallId ?? `toolu_intercept_${index}`,
          name: item.toolName ?? "tool",
          input: {},
        },
      })
      pushEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: item.toolArguments ?? item.content,
        },
      })
      pushEvent("content_block_stop", { type: "content_block_stop", index })
    } else {
      pushEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      })
      pushEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: item.content },
      })
      pushEvent("content_block_stop", { type: "content_block_stop", index })
    }
  }

  pushEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: meta.stopReason ?? (hasToolUse ? "tool_use" : "end_turn"),
      stop_sequence: null,
    },
    usage: { output_tokens: 0 },
  })
  pushEvent("message_stop", { type: "message_stop" })
  return chunks.join("")
}

function serializeResponsesResponseSse(
  items: ReadonlyArray<CanonicalItem>,
  meta: { model?: string; stopReason?: string },
): string {
  const responseId = `resp_intercept_${Date.now()}`
  const model = meta.model ?? "gpt-5"
  const output: Array<JsonRecord> = []
  const chunks: Array<string> = []

  const pushEvent = (event: string, data: JsonRecord) => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  pushEvent("response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      model,
      output: [],
    },
  })

  for (const [index, item] of items.entries()) {
    if (item.kind === "tool_call") {
      const callId = item.toolCallId ?? `call_intercept_${index}`
      const fnItem: JsonRecord = {
        id: `fc_intercept_${index}`,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: item.toolName ?? "tool",
        arguments: item.toolArguments ?? item.content,
      }
      output.push(fnItem)
      pushEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: index,
        item: { ...fnItem, status: "in_progress", arguments: "" },
      })
      pushEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: fnItem.id,
        output_index: index,
        delta: item.toolArguments ?? item.content,
      })
      pushEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item: fnItem,
      })
    } else if (item.kind === "thinking") {
      const reasonItem: JsonRecord = {
        id: `rs_intercept_${index}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: item.content }],
      }
      output.push(reasonItem)
      pushEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item: reasonItem,
      })
    } else {
      const msgItem: JsonRecord = {
        id: `msg_intercept_${index}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: item.content, annotations: [] }],
      }
      output.push(msgItem)
      pushEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: index,
        item: { ...msgItem, status: "in_progress", content: [] },
      })
      pushEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: msgItem.id,
        output_index: index,
        content_index: 0,
        delta: item.content,
      })
      pushEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: msgItem.id,
        output_index: index,
        content_index: 0,
        text: item.content,
      })
      pushEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item: msgItem,
      })
    }
  }

  pushEvent("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: meta.stopReason ?? "completed",
      model,
      output,
    },
  })

  return chunks.join("")
}

export function serializeCanonicalItemsToBody(options: {
  originalBody: string
  canonical: CanonicalView
  items: ReadonlyArray<CanonicalItem>
  contentType?: string
}): string {
  const { originalBody, canonical, items, contentType } = options

  if (canonical.phase === "response" && isSseBody(originalBody, contentType)) {
    if (canonical.protocol === "anthropic_messages") {
      return serializeAnthropicResponseSse(items, {
        model: canonical.model,
        stopReason: canonical.stopReason,
      })
    }
    if (canonical.protocol === "responses") {
      return serializeResponsesResponseSse(items, {
        model: canonical.model,
        stopReason: canonical.stopReason,
      })
    }
    return serializeChatCompletionsResponseSse(items, {
      model: canonical.model,
      stopReason: canonical.stopReason,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(originalBody)
  } catch {
    return originalBody
  }
  if (!isRecord(parsed)) return originalBody

  if (canonical.phase === "request") {
    if (canonical.protocol === "chat_completions") {
      return serializeChatCompletionsRequest(parsed, items)
    }
    if (canonical.protocol === "anthropic_messages") {
      return serializeAnthropicRequest(parsed, items)
    }
    if (canonical.protocol === "responses") {
      return serializeResponsesRequest(parsed, items)
    }
    return originalBody
  }

  // Non-streaming JSON responses
  if (canonical.protocol === "chat_completions") {
    const textParts: Array<string> = []
    const thinkingParts: Array<string> = []
    const toolCalls: Array<JsonRecord> = []
    for (const item of items) {
      if (item.kind === "thinking") thinkingParts.push(item.content)
      else if (item.kind === "tool_call") {
        toolCalls.push({
          id: item.toolCallId ?? `call_${toolCalls.length}`,
          type: "function",
          function: {
            name: item.toolName ?? "tool",
            arguments: item.toolArguments ?? item.content,
          },
        })
      } else {
        textParts.push(item.content)
      }
    }
    const existingChoices = Array.isArray(parsed.choices) ? parsed.choices : []
    const firstChoice = isRecord(existingChoices[0]) ? existingChoices[0] : {}
    const existingMsg = isRecord(firstChoice.message) ? firstChoice.message : {}
    const nextMsg: JsonRecord = {
      ...existingMsg,
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
    }
    if (thinkingParts.length > 0) {
      nextMsg.reasoning_content = thinkingParts.join("\n")
    }
    if (toolCalls.length > 0) {
      nextMsg.tool_calls = toolCalls
    } else if ("tool_calls" in nextMsg) {
      Reflect.deleteProperty(nextMsg, "tool_calls")
    }
    return JSON.stringify(
      {
        ...parsed,
        choices: [{ ...firstChoice, index: 0, message: nextMsg }],
      },
      null,
      2,
    )
  }

  if (canonical.protocol === "anthropic_messages") {
    const content: Array<JsonRecord> = items.map((item, idx) => {
      if (item.kind === "thinking") {
        return { type: "thinking", thinking: item.content }
      }
      if (item.kind === "tool_call") {
        return {
          type: "tool_use",
          id: item.toolCallId ?? `toolu_${idx}`,
          name: item.toolName ?? "tool",
          input: safeJsonParse(item.toolArguments ?? item.content),
        }
      }
      return { type: "text", text: item.content }
    })
    return JSON.stringify({ ...parsed, content }, null, 2)
  }

  if (canonical.protocol === "responses") {
    const output: Array<JsonRecord> = items.map((item, idx) => {
      if (item.kind === "tool_call") {
        return {
          id: `fc_${idx}`,
          type: "function_call",
          status: "completed",
          call_id: item.toolCallId ?? `call_${idx}`,
          name: item.toolName ?? "tool",
          arguments: item.toolArguments ?? item.content,
        }
      }
      if (item.kind === "thinking") {
        return {
          id: `rs_${idx}`,
          type: "reasoning",
          summary: [{ type: "summary_text", text: item.content }],
        }
      }
      return {
        id: `msg_${idx}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: item.content, annotations: [] }],
      }
    })
    return JSON.stringify({ ...parsed, output }, null, 2)
  }

  return originalBody
}

export function extractModelFromBody(body: string): string | undefined {
  if (!body) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && typeof parsed.model === "string") {
      return parsed.model
    }
  } catch {
    // Fallback for SSE: look for "model":"..."
    const match = /"model"\s*:\s*"([^"]+)"/.exec(body)
    if (match) return match[1]
  }
  return undefined
}
