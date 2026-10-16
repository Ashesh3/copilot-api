import type { PreparedManagedWebTools, WebProtocol } from "./tool-context"
import type { ManagedWebRequest, WebEvent } from "./tool-loop"
import type { ManagedWebUsage } from "./tool-usage"

import { isRecord, webToolError } from "./tool-context"
import { completeWebCalls, isWebStream } from "./tool-loop"
import {
  continuationPayload,
  records,
  responseOutputText,
  sumUsage,
  withoutManagedCalls,
  withoutUnexecutedManagedCalls,
} from "./tool-output"

// Implemented protocol adapters retain ordinary text streaming and hold tool-call
// events until their ownership is known.
export async function* streamManagedWebRequest(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  input: { first: AsyncIterable<WebEvent>; observedUsage: ManagedWebUsage },
): AsyncGenerator<WebEvent> {
  const { first, observedUsage } = input
  let payload = prepared.payload
  let source = first
  const position: StreamPosition = {
    protocol: options.protocol,
    offset: 0,
    sequence: 0,
  }
  let usage: Record<string, unknown> | undefined
  const allOutput: Array<Record<string, unknown>> = []
  for (let round = 0; round < 18; round++) {
    position.usage = usage
    position.output = allOutput
    const state = new RoundState(options.protocol, prepared.managed)
    yield* consumeRound(options, state, {
      source,
      round,
      position,
      observedUsage,
    })
    if (state.failed || (!state.intercepted && round === 0)) return
    const response = state.finish()
    usage = sumUsage(usage, response.usage)
    const { completed, mixed } = await completeWebCalls(
      options,
      prepared,
      response,
    )
    const visible =
      completed.length > 0 ?
        withoutManagedCalls(response, completed, options.protocol)
      : response
    const visibleOutput =
      options.protocol === "responses" ? records(visible.output) : []
    allOutput.push(...visibleOutput)
    // Client tool calls and local execution evidence were withheld as complete
    // blocks, so they can now be emitted without leaking gateway-only functions.
    for (const event of state.pendingEvents(visible, completed.length > 0)) {
      const parsed = JSON.parse(event.data ?? "{}") as Record<string, unknown>
      yield remap(event, parsed, position)
    }
    position.offset += state.visibleSize(visible)
    if (completed.length === 0 || mixed) {
      position.offset = 0
      for (const event of state.terminalEvents(visible, usage, allOutput)) {
        const parsed =
          event.data === "[DONE]" ?
            undefined
          : (JSON.parse(event.data ?? "{}") as Record<string, unknown>)
        yield parsed ? remap(event, parsed, position) : event
      }
      return
    }
    payload = continuationPayload(payload, response, {
      completed,
      protocol: options.protocol,
    })
    observedUsage.nextRound()
    const next = await options.send(payload, prepared.managed)
    if (!isWebStream(next))
      throw webToolError(
        "web_tool_protocol_error",
        "Expected streaming tool continuation.",
      )
    source = next
  }
  throw webToolError(
    "web_tool_limit_exceeded",
    "Web tool continuation limit exceeded.",
  )
}

interface StreamPosition {
  protocol: WebProtocol
  offset: number
  sequence: number
  id?: unknown
  usage?: Record<string, unknown>
  output?: Array<Record<string, unknown>>
}

function repeatedStart(
  value: Record<string, unknown>,
  round: number,
  position: StreamPosition,
): boolean {
  if (position.protocol === "chat") position.id ??= value.id
  if (value.type === "message_start") {
    if (round > 0) return true
    position.id = isRecord(value.message) ? value.message.id : undefined
  }
  if (
    value.type === "response.created"
    || value.type === "response.in_progress"
  ) {
    if (round > 0) return true
    position.id ??= isRecord(value.response) ? value.response.id : undefined
  }
  return false
}

// eslint-disable-next-line complexity -- Preserve transparent transport and explicit terminal handling for three protocols.
async function* consumeRound(
  options: ManagedWebRequest,
  state: RoundState,
  input: {
    source: AsyncIterable<WebEvent>
    round: number
    position: StreamPosition
    observedUsage: ManagedWebUsage
  },
): AsyncGenerator<WebEvent> {
  const { source, round, position } = input
  let transparentFinal = false
  for await (const event of source) {
    options.signal?.throwIfAborted()
    if (transparentFinal) {
      yield event
      continue
    }
    const parsed = state.accept(event)
    input.observedUsage.observe(state.observedUsage, state.intercepted)
    if (!parsed) {
      if (state.done) break
      if (event.data && event.data !== "[DONE]") yield event
      continue
    }
    if (state.failed) {
      if (!state.intercepted && round === 0) yield event
      else yield* failedRoundEvents(state, { event, parsed, position })
      return
    }
    if (repeatedStart(parsed, round, position)) continue
    if (!state.intercepted && round === 0) {
      state.markForwarded(parsed)
      if (typeof parsed.sequence_number === "number")
        position.sequence = parsed.sequence_number + 1
      yield event
      if (state.done) {
        if (options.protocol !== "chat") return
        transparentFinal = true
      }
      continue
    }
    if (!state.withhold(parsed)) yield remap(event, parsed, position)
    // Chat sends its usage-only chunk AFTER finish_reason. Do not close the
    // iterator until [DONE] or EOF; other dialects carry usage on their terminal.
    if (state.done && options.protocol !== "chat") break
  }
}

function* failedRoundEvents(
  state: RoundState,
  input: {
    event: WebEvent
    parsed: Record<string, unknown>
    position: StreamPosition
  },
): Generator<WebEvent> {
  const { event, parsed, position } = input
  const response = isRecord(parsed.response) ? parsed.response : undefined
  if (response) {
    const visible = withoutUnexecutedManagedCalls(
      response,
      state.managedTools,
      position.protocol,
    )
    for (const pending of state.pendingEvents(visible, false, true)) {
      yield remap(
        pending,
        JSON.parse(pending.data ?? "{}") as Record<string, unknown>,
        position,
      )
    }
    const output = [...(position.output ?? []), ...records(visible.output)]
    parsed.response = {
      ...visible,
      output,
      output_text: responseOutputText(output),
      usage: sumUsage(position.usage, response.usage),
    }
  }
  yield remap(event, parsed, position)
}

function remap(
  event: WebEvent,
  parsed: Record<string, unknown>,
  position: StreamPosition,
): WebEvent {
  const { offset, id, protocol } = position
  const output = { ...parsed }
  if (typeof output.index === "number") output.index += offset
  if (typeof output.output_index === "number") output.output_index += offset
  if (protocol === "responses") {
    output.sequence_number = position.sequence++
    if (isRecord(output.response) && id)
      output.response = { ...output.response, id }
  }
  if (protocol === "chat" && id) output.id = id
  return { ...event, data: JSON.stringify(output) }
}
function eventFor(type: string, body: Record<string, unknown>): WebEvent {
  return { event: type, data: JSON.stringify({ ...body, type }) }
}
function textValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

class RoundState {
  private response: Record<string, unknown> = {}
  private readonly blocks = new Map<number, Record<string, unknown>>()
  private readonly toolJson = new Map<number, string>()
  private readonly toolIndices = new Set<number>()
  private readonly outputIndices = new Map<string, number>()
  private readonly tools = new Map<number, Record<string, unknown>>()
  private readonly forwardedTools = new Set<number>()
  private readonly heldMessageEvents: Array<Record<string, unknown>> = []
  private readonly heldResponseEvents: Array<Record<string, unknown>> = []
  private content = ""
  private reasoning = ""
  private signature: unknown
  private encryptedContent: unknown
  private terminal = false
  private finishReason: unknown
  private usage: unknown
  private terminalEnvelope: Record<string, unknown> = {}
  private trailingChat = false
  intercepted = false
  failed = false
  get done(): boolean {
    return this.terminal
  }
  private readonly protocol: WebProtocol
  private readonly managed: ReadonlyMap<string, unknown>
  constructor(protocol: WebProtocol, managed: ReadonlyMap<string, unknown>) {
    this.protocol = protocol
    this.managed = managed
  }
  get managedTools(): ReadonlyMap<string, unknown> {
    return this.managed
  }
  get observedUsage(): unknown {
    if (this.protocol === "chat") return this.usage
    if (
      this.protocol === "responses"
      && (this.response.status === "failed"
        || this.terminalEnvelope.type === "response.failed")
    )
      return undefined
    return this.response.usage
  }

  accept(event: WebEvent): Record<string, unknown> | undefined {
    if (!event.data) return undefined
    if (event.data === "[DONE]") {
      if (this.protocol === "chat" && this.intercepted && !this.finishReason)
        throw webToolError(
          "web_tool_stream_incomplete",
          "Upstream stream ended without a final choice.",
        )
      return undefined
    }
    let value: unknown
    try {
      value = JSON.parse(event.data)
    } catch {
      return undefined
    }
    if (!isRecord(value)) return undefined
    this.failed =
      Boolean(value.error)
      || ["error", "response.failed", "response.incomplete"].includes(
        String(value.type),
      )
    if (this.protocol === "messages") this.acceptMessages(value)
    else if (this.protocol === "responses") this.acceptResponses(value)
    else this.acceptChat(value)
    return value
  }
  markForwarded(value: Record<string, unknown>): void {
    if (this.protocol !== "chat") return
    for (const choice of records(value.choices)) {
      if (!isRecord(choice.delta)) continue
      for (const tool of records(choice.delta.tool_calls))
        this.forwardedTools.add(Number(tool.index))
    }
  }
  // eslint-disable-next-line complexity -- Assemble the documented Anthropic content-block delta variants without altering their signatures.
  private acceptMessages(value: Record<string, unknown>): void {
    const index = Number(value.index ?? 0)
    if (value.type === "message_start" && isRecord(value.message))
      this.response = value.message
    if (value.type === "content_block_start" && isRecord(value.content_block)) {
      this.blocks.set(index, structuredClone(value.content_block))
      if (
        value.content_block.type === "tool_use"
        && this.managed.has(String(value.content_block.name))
      ) {
        this.toolIndices.add(index)
        this.intercepted = true
      }
    }
    if (value.type === "content_block_delta" && isRecord(value.delta)) {
      const block = this.blocks.get(index)
      if (block) {
        const delta = value.delta
        if (typeof delta.text === "string")
          block.text = textValue(block.text) + delta.text
        if (typeof delta.thinking === "string")
          block.thinking = textValue(block.thinking) + delta.thinking
        if (typeof delta.signature === "string")
          block.signature = textValue(block.signature) + delta.signature
        if (typeof delta.partial_json === "string")
          this.toolJson.set(
            index,
            (this.toolJson.get(index) ?? "") + delta.partial_json,
          )
      }
    }
    if (value.type === "message_delta") {
      if (isRecord(value.delta)) Object.assign(this.response, value.delta)
      this.response.usage = {
        ...(isRecord(this.response.usage) ? this.response.usage : {}),
        ...(isRecord(value.usage) ? value.usage : {}),
      }
    }
    if (value.type === "message_stop") this.terminal = true
  }
  private acceptResponses(value: Record<string, unknown>): void {
    if (
      value.type === "response.output_item.added"
      && isRecord(value.item)
      && typeof value.item.id === "string"
    )
      this.outputIndices.set(value.item.id, Number(value.output_index))
    if (
      value.type === "response.output_item.added"
      && isRecord(value.item)
      && value.item.type === "function_call"
      && !value.item.namespace
      && this.managed.has(String(value.item.name))
    ) {
      this.toolIndices.add(Number(value.output_index))
      this.intercepted = true
    }
    if (
      ["response.completed", "response.failed", "response.incomplete"].includes(
        String(value.type),
      )
      && isRecord(value.response)
    ) {
      this.terminalEnvelope = value
      this.response = value.response
      this.terminal = true
      this.failed ||= ["failed", "incomplete"].includes(
        String(this.response.status),
      )
      this.intercepted ||= records(this.response.output).some(
        (item) =>
          item.type === "function_call"
          && !item.namespace
          && this.managed.has(String(item.name)),
      )
    }
  }
  private acceptChat(value: Record<string, unknown>): void {
    this.trailingChat = this.terminal
    if (this.trailingChat) {
      if (records(value.choices).length === 0 && value.usage)
        this.usage = value.usage
      return
    }
    this.response = {
      ...this.response,
      id: value.id,
      model: value.model,
      created: value.created,
      object: "chat.completion",
    }
    if (value.usage) this.usage = value.usage
    for (const choice of records(value.choices)) {
      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason
        this.terminal = true
      }
      if (!isRecord(choice.delta)) continue
      const delta = choice.delta
      if (typeof delta.content === "string") this.content += delta.content
      if (typeof delta.reasoning_text === "string")
        this.reasoning += delta.reasoning_text
      if (delta.reasoning_opaque) this.signature = delta.reasoning_opaque
      if (typeof delta.encrypted_content === "string")
        this.encryptedContent = delta.encrypted_content
      this.acceptChatTools(records(delta.tool_calls))
    }
  }
  private acceptChatTools(calls: Array<Record<string, unknown>>): void {
    for (const tool of calls) {
      const index = Number(tool.index)
      const custom = tool.type === "custom" || isRecord(tool.custom)
      const current =
        this.tools.get(index)
        ?? (custom ?
          { id: "", type: "custom", custom: { name: "", input: "" } }
        : { id: "", type: "function", function: { name: "", arguments: "" } })
      if (tool.id) current.id = tool.id
      if (isRecord(tool.function) && isRecord(current.function)) {
        appendToolFields(current.function, tool.function, ["name", "arguments"])
      }
      if (isRecord(tool.custom) && isRecord(current.custom)) {
        appendToolFields(current.custom, tool.custom, ["name", "input"])
      }
      this.tools.set(index, current)
      if (current.type === "function" && isRecord(current.function)) {
        const name = textValue(current.function.name)
        if (
          [...this.managed.keys()].some((candidate) =>
            candidate.startsWith(name),
          )
        )
          this.intercepted = true
      }
    }
  }
  withhold(value: Record<string, unknown>): boolean {
    if (this.protocol === "messages") {
      if (
        typeof value.index === "number"
        && value.index >= Math.min(...this.toolIndices)
      ) {
        this.heldMessageEvents.push(value)
        return true
      }
      return value.type === "message_delta" || value.type === "message_stop"
    }
    if (this.protocol === "responses") {
      const index = this.responseEventIndex(value)
      if (index !== undefined && index >= Math.min(...this.toolIndices)) {
        this.heldResponseEvents.push(value)
        return true
      }
      return value.type === "response.completed"
    }
    // Preserve text/opaque reasoning even on a chunk carrying a tool delta.
    if (this.trailingChat) return true
    const choices = records(value.choices)
    value.choices = choices.map((choice) => {
      if (!isRecord(choice.delta)) return choice
      const delta = { ...choice.delta }
      const forwarded = records(delta.tool_calls).filter((tool) =>
        this.forwardedTools.has(Number(tool.index)),
      )
      if (forwarded.length > 0) delta.tool_calls = forwarded
      else delete delta.tool_calls
      return { ...choice, delta, finish_reason: null }
    })
    delete value.usage
    return (
      choices.length === 0
      || records(value.choices).every(
        (c) => isRecord(c.delta) && Object.keys(c.delta).length === 0,
      )
    )
  }
  finish(): Record<string, unknown> {
    if (!this.terminal)
      throw webToolError(
        "web_tool_stream_incomplete",
        "Upstream stream ended without a terminal event.",
      )
    if (this.protocol === "messages") {
      for (const [index, json] of this.toolJson) {
        const block = this.blocks.get(index)
        if (!block) throw new TypeError("Tool delta has no matching block")
        try {
          block.input = JSON.parse(json) as unknown
        } catch {
          throw webToolError(
            "web_tool_protocol_error",
            "Malformed tool arguments.",
          )
        }
      }
      return {
        ...this.response,
        content: [...this.blocks.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, b]) => b),
      }
    }
    if (this.protocol === "responses") return this.response
    return {
      ...this.response,
      usage: this.usage,
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: this.finishReason,
          message: {
            role: "assistant",
            content: this.content || null,
            ...(this.reasoning ? { reasoning_text: this.reasoning } : {}),
            ...(this.signature ? { reasoning_opaque: this.signature } : {}),
            ...(this.encryptedContent === undefined ?
              {}
            : { encrypted_content: this.encryptedContent }),
            ...(this.tools.size > 0 ?
              { tool_calls: [...this.tools.values()] }
            : {}),
          },
        },
      ],
    }
  }

  *pendingEvents(
    visible: Record<string, unknown>,
    completed: boolean,
    failed = false,
  ): Generator<WebEvent> {
    if (this.protocol === "messages") {
      const content = records(visible.content)
      for (const event of this.heldMessageEvents) {
        const index = Number(event.index)
        if (!this.toolIndices.has(index)) {
          yield eventFor(String(event.type), event)
        } else if (event.type === "content_block_start") {
          const block = content.at(index)
          if (!block) continue
          yield eventFor("content_block_start", { index, content_block: block })
        } else if (event.type === "content_block_stop") {
          yield eventFor("content_block_stop", { index })
        }
      }
    } else if (this.protocol === "responses") {
      yield* this.pendingResponses(visible, failed)
    } else {
      const choice = records(visible.choices).at(0)
      const message = isRecord(choice?.message) ? choice.message : {}
      const tools = [...this.tools.entries()]
        .filter(
          ([index, call]) =>
            !this.forwardedTools.has(index)
            && (!isRecord(call.function)
              || !this.managed.has(String(call.function.name))),
        )
        .map(([, call]) => call)
      const firstIndex = Math.max(-1, ...this.forwardedTools) + 1
      const evidence =
        completed ?
          textValue(message.content).slice(this.content.length).trimStart()
        : ""
      if (tools.length > 0 || evidence)
        yield {
          data: JSON.stringify({
            ...this.response,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  ...(evidence ? { content: "\n\n" + evidence } : {}),
                  ...(tools.length > 0 ?
                    {
                      tool_calls: tools.map((tool, index) => ({
                        ...tool,
                        index: firstIndex + index,
                      })),
                    }
                  : {}),
                },
                finish_reason: null,
              },
            ],
          }),
        }
    }
  }
  private responseEventIndex(
    event: Record<string, unknown>,
  ): number | undefined {
    if (typeof event.output_index === "number") return event.output_index
    return typeof event.item_id === "string" ?
        this.outputIndices.get(event.item_id)
      : undefined
  }
  private *pendingResponses(
    visible: Record<string, unknown>,
    failed: boolean,
  ): Generator<WebEvent> {
    const output = records(visible.output)
    for (const event of this.heldResponseEvents) {
      const index = this.responseEventIndex(event)
      if (index === undefined) continue
      if (this.toolIndices.has(index)) {
        if (!failed && event.type === "response.output_item.added") {
          const item = output.at(index)
          if (item) yield* replacementMessageEvents(item, index)
        }
        continue
      }
      const removed =
        failed ?
          [...this.toolIndices].filter((owned) => owned < index).length
        : 0
      yield eventFor(String(event.type), {
        ...event,
        ...(typeof event.output_index === "number" ?
          { output_index: index - removed }
        : {}),
      })
    }
  }
  visibleSize(visible: Record<string, unknown>): number {
    if (this.protocol === "messages") return records(visible.content).length
    if (this.protocol === "responses") return records(visible.output).length
    return 0
  }
  *terminalEvents(
    visible: Record<string, unknown>,
    usage: unknown,
    output: Array<Record<string, unknown>>,
  ): Generator<WebEvent> {
    if (this.protocol === "messages") {
      yield eventFor("message_delta", {
        delta: {
          stop_reason: visible.stop_reason,
          stop_sequence: visible.stop_sequence ?? null,
        },
        usage,
      })
      yield eventFor("message_stop", {})
    } else if (this.protocol === "responses")
      yield eventFor("response.completed", {
        ...this.terminalEnvelope,
        response: {
          ...visible,
          output,
          usage,
          output_text: responseOutputText(output),
        },
      })
    else {
      const choice = records(visible.choices).at(0)
      yield {
        data: JSON.stringify({
          ...this.response,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: choice?.finish_reason ?? "stop",
            },
          ],
        }),
      }
      if (usage)
        yield {
          data: JSON.stringify({
            ...this.response,
            object: "chat.completion.chunk",
            choices: [],
            usage,
          }),
        }
      yield { data: "[DONE]" }
    }
  }
}

function appendToolFields(
  current: Record<string, unknown>,
  delta: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): void {
  for (const field of fields)
    if (typeof delta[field] === "string")
      current[field] = textValue(current[field]) + delta[field]
}

function* replacementMessageEvents(
  item: Record<string, unknown>,
  index: number,
): Generator<WebEvent> {
  yield eventFor("response.output_item.added", {
    output_index: index,
    item: { ...item, status: "in_progress", content: [] },
  })
  for (const [contentIndex, part] of records(item.content).entries()) {
    const address = {
      output_index: index,
      item_id: item.id,
      content_index: contentIndex,
    }
    yield eventFor("response.content_part.added", {
      ...address,
      part: { ...part, text: "" },
    })
    yield eventFor("response.output_text.delta", {
      ...address,
      delta: part.text,
    })
    yield eventFor("response.output_text.done", { ...address, text: part.text })
    yield eventFor("response.content_part.done", { ...address, part })
  }
  yield eventFor("response.output_item.done", { output_index: index, item })
}
