import type { PreparedManagedWebTools, WebProtocol } from "./tool-context"
import type {
  ManagedWebDispatch,
  ManagedWebRequest,
  WebEvent,
} from "./tool-loop"
import type { FinishedStreamRound, StreamPosition } from "./tool-stream-events"
import type { ManagedWebUsage } from "./tool-usage"

import { finishDroidStreamRound } from "./droid-web-stream"
import { isRecord, webToolError } from "./tool-context"
import {
  checkWebContinuationLimit,
  MAX_MANAGED_WEB_ROUNDS,
} from "./tool-limits"
import { completeWebCalls, isWebStream } from "./tool-loop"
import {
  assertNoClientWebCalls,
  continuationPayload,
  isManagedChatCall,
  records,
  responseCalls,
  responseOutputText,
  sumUsage,
  withoutManagedCalls,
  withoutUnexecutedManagedCalls,
  type CompletedWebCall,
} from "./tool-output"
import { eventFor, placeEvents, remap } from "./tool-stream-events"
import { updateUsageSnapshot } from "./tool-usage-output"

// Implemented protocol adapters retain ordinary text streaming and hold tool-call
// events until their ownership is known.
export async function* streamManagedWebRequest(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  input: {
    first: AsyncIterable<WebEvent>
    observedUsage: ManagedWebUsage
    dispatch: ManagedWebDispatch
  },
): AsyncGenerator<WebEvent> {
  const { first, observedUsage, dispatch } = input
  let source = first
  const position: StreamPosition = {
    protocol: options.protocol,
    offset: 0,
    sequence: 0,
  }
  let usage: Record<string, unknown> | undefined
  const allOutput: Array<Record<string, unknown>> = []
  // Droid replays carriers, so its rounds may hand off to client tools.
  const carriers = prepared.context?.droid === true
  const finish = carriers ? finishDroidStreamRound : finishStreamRound
  for (let round = 0; round < MAX_MANAGED_WEB_ROUNDS; round++) {
    position.usage = usage
    position.output = allOutput
    const state = new RoundState(
      options.protocol,
      prepared.managed,
      prepared.context?.callerNames,
    )
    yield* consumeRound(options, state, {
      source,
      round,
      position,
      observedUsage,
      carriers,
    })
    if (state.failed || (state.transparent && round === 0)) return
    const response = state.finish()
    usage = sumUsage(usage, response.usage)
    const next = yield* finish(options, prepared, {
      state,
      response,
      index: round,
      position,
      usage,
      output: allOutput,
      observedUsage,
      dispatch,
    })
    if (!next) return
    source = next
  }
  throw webToolError(
    "web_tool_limit_exceeded",
    "Web tool continuation limit exceeded.",
  )
}

/** Answer a round's managed calls privately; return the continuation stream. */
async function* finishStreamRound(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  round: FinishedStreamRound<RoundState>,
): AsyncGenerator<WebEvent, AsyncIterable<WebEvent> | undefined> {
  const { state, response, position, output } = round
  const completed =
    state.canReturnWithoutExecution(round.index) ?
      []
    : await completeWebCalls(options, prepared, response)
  const visible = state.visibleResponse(response, completed)
  if (options.protocol === "responses") output.push(...records(visible.output))
  // Replay only genuine upstream items; helper output stays in private history.
  yield* placeEvents(state.pendingEvents(), position)
  position.offset += state.visibleSize(visible)
  if (completed.length === 0) {
    position.offset = 0
    yield* placeEvents(
      state.terminalEvents(visible, round.usage, output),
      position,
    )
    return undefined
  }
  checkWebContinuationLimit(round.index)
  const payload = continuationPayload(
    round.dispatch.processedPayload(),
    response,
    { completed, protocol: options.protocol },
  )
  round.observedUsage.nextRound()
  const next = await round.dispatch.send(payload)
  if (!isWebStream(next))
    throw webToolError(
      "web_tool_protocol_error",
      "Expected streaming tool continuation.",
    )
  return next
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
    carriers: boolean
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
    if (round > 0 && parsed && !input.carriers)
      state.assertPrivateContinuation(parsed)
    if (!parsed) {
      if (state.done) break
      if (event.data && event.data !== "[DONE]") yield event
      continue
    }
    if (state.failed) {
      if (state.transparent && round === 0) yield event
      else yield* failedRoundEvents(state, { event, parsed, position })
      return
    }
    if (repeatedStart(parsed, round, position)) continue
    if (state.transparent && round === 0) {
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
      { protocol: position.protocol },
    )
    for (const pending of state.pendingEvents()) {
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

function textValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

class RoundState {
  private response: Record<string, unknown> = {}
  private readonly blocks = new Map<number, Record<string, unknown>>()
  private readonly toolJson = new Map<number, string>()
  private readonly toolIndices = new Set<number>()
  private firstToolIndex = Infinity
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
  private visibleUsage?: Record<string, unknown>
  private terminalEnvelope: Record<string, unknown> = {}
  private trailingChat = false
  intercepted = false
  failed = false
  get done(): boolean {
    return this.terminal
  }
  get hasPendingCalls(): boolean {
    return this.tools.size > 0 || Number.isFinite(this.firstToolIndex)
  }
  get transparent(): boolean {
    return !this.intercepted && !this.hasPendingCalls
  }
  canReturnWithoutExecution(round: number): boolean {
    return round === 0 && !this.intercepted
  }
  assertPrivateContinuation(value: Record<string, unknown>): void {
    const response =
      isRecord(value.response) ? value.response : this.finishIfTerminal()
    if (!response) return
    assertNoClientWebCalls(
      withoutUnexecutedManagedCalls(response, this.managed, {
        protocol: this.protocol,
        callerNames: this.truncated ? this.callerNames : undefined,
      }),
      this.protocol,
      new Set(),
    )
  }
  private finishIfTerminal(): Record<string, unknown> | undefined {
    return this.done ? this.finish() : undefined
  }
  get truncated(): boolean {
    return this.protocol === "messages" ?
        this.response.stop_reason === "max_tokens"
      : this.protocol === "chat" && this.finishReason === "length"
  }
  private readonly protocol: WebProtocol
  private readonly managed: ReadonlyMap<string, unknown>
  private readonly callerNames: ReadonlySet<string>
  constructor(
    protocol: WebProtocol,
    managed: ReadonlyMap<string, unknown>,
    callerNames: ReadonlySet<string> = new Set(),
  ) {
    this.protocol = protocol
    this.managed = managed
    this.callerNames = callerNames
  }
  visibleResponse(
    response: Record<string, unknown>,
    completed: ReadonlyArray<CompletedWebCall>,
  ): Record<string, unknown> {
    if (this.truncated)
      return withoutUnexecutedManagedCalls(response, this.managed, {
        protocol: this.protocol,
        callerNames: this.callerNames,
      })
    return completed.length > 0 ?
        withoutManagedCalls(response, completed, this.protocol)
      : response
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
    this.visibleUsage = updateUsageSnapshot(
      this.visibleUsage,
      this.observedUsage,
    )
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
      if (value.content_block.type === "tool_use")
        this.firstToolIndex = Math.min(this.firstToolIndex, index)
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
      && responseCalls({ output: [value.item] }, "responses").length > 0
    )
      this.firstToolIndex = Math.min(
        this.firstToolIndex,
        Number(value.output_index),
      )
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
        && value.index >= this.firstToolIndex
      ) {
        this.heldMessageEvents.push(value)
        return true
      }
      return value.type === "message_delta" || value.type === "message_stop"
    }
    if (this.protocol === "responses") {
      const index = this.responseEventIndex(value)
      if (index !== undefined && index >= this.firstToolIndex) {
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
      // Truncation can cut off either an owned or client call. Retained client
      // deltas are replayed verbatim rather than parsing their partial JSON.
      if (!this.truncated) {
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
      }
      return {
        ...this.response,
        usage: this.visibleUsage,
        content: [...this.blocks.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, b]) => b),
      }
    }
    if (this.protocol === "responses")
      return { ...this.response, usage: this.visibleUsage }
    return {
      ...this.response,
      usage: this.visibleUsage,
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

  *pendingEvents(): Generator<WebEvent> {
    if (this.protocol === "messages") {
      yield* this.pendingMessages()
    } else if (this.protocol === "responses") {
      yield* this.pendingResponses()
    } else {
      const tools = [...this.tools.entries()]
        .filter(
          ([index, call]) =>
            !this.forwardedTools.has(index)
            && !isManagedChatCall(
              call,
              this.managed,
              this.truncated ? this.callerNames : undefined,
            ),
        )
        .map(([, call]) => call)
      const firstIndex = Math.max(-1, ...this.forwardedTools) + 1
      if (tools.length > 0)
        yield {
          data: JSON.stringify({
            ...this.response,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
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
  private *pendingMessages(): Generator<WebEvent> {
    for (const event of this.heldMessageEvents) {
      const index = Number(event.index)
      if (!this.toolIndices.has(index)) {
        const removed = [...this.toolIndices].filter(
          (owned) => owned < index,
        ).length
        yield eventFor(String(event.type), { ...event, index: index - removed })
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
  private *pendingResponses(): Generator<WebEvent> {
    for (const event of this.heldResponseEvents) {
      const index = this.responseEventIndex(event)
      if (index === undefined) continue
      if (this.toolIndices.has(index)) continue
      const removed = [...this.toolIndices].filter(
        (owned) => owned < index,
      ).length
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
