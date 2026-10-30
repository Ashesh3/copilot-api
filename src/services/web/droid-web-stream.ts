import { randomUUID } from "node:crypto"

import type { DroidWebCarrier } from "./droid-web-protocol"
import type { PreparedManagedWebTools, WebProtocol } from "./tool-context"
import type { ManagedToolResult, WebToolCall } from "./tool-executor"
import type {
  ManagedWebDispatch,
  ManagedWebRequest,
  WebEvent,
  WebResponse,
} from "./tool-loop"
import type { CompletedWebCall } from "./tool-output"
import type { FinishedStreamRound, StreamPosition } from "./tool-stream-events"
import type { ManagedWebUsage } from "./tool-usage"

import {
  droidCarrierReasoning,
  droidCarrierThinking,
  droidNarrationMessage,
  encodeDroidWebCarrier,
  DROID_WEB_CARRIER_LABEL,
} from "./droid-web-protocol"
import { droidCallNarration, droidResultNarration } from "./droid-web-tools"
import { droidReportedUsage } from "./droid-web-usage"
import { webToolError } from "./tool-context"
import { executeManagedWebCall } from "./tool-executor"
import {
  checkWebContinuationLimit,
  MAX_MANAGED_WEB_ROUNDS,
} from "./tool-limits"
import {
  continuationPayload,
  isUnsuccessfulWebResponse,
  records,
  responseCalls,
  responseOutputText,
  sumUsage,
  withoutManagedCalls,
  withoutUnexecutedManagedCalls,
} from "./tool-output"
import { eventFor, placeEvents, remap } from "./tool-stream-events"

type JsonRecord = Record<string, unknown>
type CarrierProtocol = Exclude<WebProtocol, "chat">

const isStream = (value: WebResponse): value is AsyncIterable<WebEvent> =>
  Symbol.asyncIterator in value

function carrierProtocol(protocol: WebProtocol): CarrierProtocol {
  if (protocol === "chat")
    throw new TypeError("Droid web carriers need Responses or Messages")
  return protocol
}

/**
 * Whether the gateway answers Droid's own web tools in this request. Droid's
 * tool-less calls get the usual gateway search and the usual loop instead.
 */
export function usesDroidCarriers(prepared: PreparedManagedWebTools): boolean {
  return [...prepared.managed.values()].some((tool) => tool.droid !== undefined)
}

/** The calls in a finished round that the gateway answers for Droid. */
function ownedDroidCalls(
  response: JsonRecord,
  prepared: PreparedManagedWebTools,
  protocol: WebProtocol,
): Array<WebToolCall> {
  return responseCalls(response, protocol).filter(
    (call) =>
      !call.clientOwned && prepared.managed.get(call.name)?.droid !== undefined,
  )
}

function withoutOwned(
  response: JsonRecord,
  calls: ReadonlyArray<WebToolCall>,
  protocol: WebProtocol,
): JsonRecord {
  const stubs = calls.map((call) => ({
    call,
    result: { text: "", isError: false },
  }))
  return withoutManagedCalls(response, stubs, protocol)
}

async function runDroidCall(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  call: WebToolCall,
): Promise<ManagedToolResult> {
  const tool = prepared.managed.get(call.name)
  if (!tool || !prepared.context)
    throw new TypeError("Managed tool context is missing")
  options.signal?.throwIfAborted()
  const result = await (options.execute ?? executeManagedWebCall)(call, tool, {
    context: prepared.context,
    signal: options.signal,
  })
  options.signal?.throwIfAborted()
  return result
}

function carrierOf(
  completed: ReadonlyArray<CompletedWebCall>,
  narration: string,
): DroidWebCarrier {
  return {
    calls: completed.map(({ call }) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    results: completed.map(({ call, result }) => ({
      id: call.id,
      text: result.text,
      isError: result.isError,
    })),
    narration,
  }
}

/**
 * Builds the two items Droid sees for one gateway-run round: visible
 * narration text at local index 0, then the carrier at local index 1.
 */
class DroidRoundOutput {
  private narration = ""
  private readonly suffix = randomUUID().replaceAll("-", "")
  private readonly protocol: CarrierProtocol
  constructor(protocol: CarrierProtocol) {
    this.protocol = protocol
  }
  private get messageId(): string {
    return `msg_capi_droid_${this.suffix}`
  }
  private get reasoningId(): string {
    return `rs_capi_droid_${this.suffix}`
  }
  get text(): string {
    return this.narration
  }
  start(): Array<JsonRecord> {
    if (this.protocol === "messages")
      return [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ]
    const message = droidNarrationMessage(this.messageId, "")
    return [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: this.messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    ]
  }
  append(piece: string): Array<JsonRecord> {
    this.narration += piece
    if (this.protocol === "messages")
      return [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: piece },
        },
      ]
    return [
      {
        type: "response.output_text.delta",
        item_id: this.messageId,
        output_index: 0,
        content_index: 0,
        delta: piece,
        logprobs: [],
      },
    ]
  }
  items(carrier: DroidWebCarrier): Array<JsonRecord> {
    if (this.protocol === "messages")
      return [
        { type: "text", text: this.narration },
        droidCarrierThinking(carrier),
      ]
    return [
      droidNarrationMessage(this.messageId, this.narration),
      droidCarrierReasoning(this.reasoningId, carrier),
    ]
  }
  finish(carrier: DroidWebCarrier): Array<JsonRecord> {
    if (this.protocol === "messages")
      return [
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: DROID_WEB_CARRIER_LABEL },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "signature_delta",
            signature: encodeDroidWebCarrier(carrier),
          },
        },
        { type: "content_block_stop", index: 1 },
      ]
    const [message, reasoning] = this.items(carrier)
    const part = { type: "output_text", text: this.narration, annotations: [] }
    const textPosition = {
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
    }
    return [
      {
        type: "response.output_text.done",
        ...textPosition,
        text: this.narration,
        logprobs: [],
      },
      { type: "response.content_part.done", ...textPosition, part },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: this.reasoningId, summary: [] },
      },
      { type: "response.output_item.done", output_index: 1, item: reasoning },
    ]
  }
}

function* place(
  bodies: ReadonlyArray<JsonRecord>,
  position: StreamPosition,
): Generator<WebEvent> {
  for (const body of bodies)
    yield remap(eventFor(String(body.type), body), body, position)
}

/** Run a round's Droid calls while streaming their narration, then the carrier. */
async function* streamDroidCalls(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  input: { calls: ReadonlyArray<WebToolCall>; position: StreamPosition },
): AsyncGenerator<
  WebEvent,
  { completed: Array<CompletedWebCall>; items: Array<JsonRecord> }
> {
  const output = new DroidRoundOutput(carrierProtocol(options.protocol))
  const completed: Array<CompletedWebCall> = []
  yield* place(output.start(), input.position)
  for (const call of input.calls) {
    const kind = prepared.managed.get(call.name)?.droid ?? "search"
    const lead = completed.length > 0 ? "\n\n" : ""
    yield* place(
      output.append(`${lead}${droidCallNarration(call, kind)}`),
      input.position,
    )
    const result = await runDroidCall(options, prepared, call)
    completed.push({ call, result })
    yield* place(
      output.append(droidResultNarration(kind, result)),
      input.position,
    )
  }
  const carrier = carrierOf(completed, output.text)
  yield* place(output.finish(carrier), input.position)
  return { completed, items: output.items(carrier) }
}

/** The parts of a finished stream round that carrier mode drives. */
export interface DroidStreamRoundState {
  readonly truncated: boolean
  canReturnWithoutExecution: (round: number) => boolean
  visibleResponse: (
    response: JsonRecord,
    completed: ReadonlyArray<CompletedWebCall>,
  ) => JsonRecord
  pendingEvents: () => Iterable<WebEvent>
  visibleSize: (visible: JsonRecord) => number
  terminalEvents: (
    visible: JsonRecord,
    usage: unknown,
    output: Array<JsonRecord>,
  ) => Iterable<WebEvent>
}

/**
 * Finish one streamed round for Droid. Droid's own web calls run here with
 * visible narration and a replay carrier; any client calls of the same round
 * go back to Droid, because the carrier keeps the hidden results replayable.
 * Returns the next upstream stream, or nothing once the response is complete.
 */
export async function* finishDroidStreamRound(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  round: FinishedStreamRound<DroidStreamRoundState>,
): AsyncGenerator<WebEvent, AsyncIterable<WebEvent> | undefined> {
  const { state, response, position, output } = round
  const protocol = options.protocol
  const calls =
    state.canReturnWithoutExecution(round.index) || state.truncated ?
      []
    : ownedDroidCalls(response, prepared, protocol)
  const visible =
    calls.length > 0 ?
      withoutOwned(response, calls, protocol)
    : state.visibleResponse(response, [])
  if (protocol === "responses") output.push(...records(visible.output))
  yield* placeEvents(state.pendingEvents(), position)
  position.offset += state.visibleSize(visible)
  let completed: Array<CompletedWebCall> = []
  if (calls.length > 0) {
    const ran = yield* streamDroidCalls(options, prepared, { calls, position })
    completed = ran.completed
    if (protocol === "responses") output.push(...ran.items)
    position.offset += ran.items.length
  }
  if (calls.length === 0 || responseCalls(visible, protocol).length > 0) {
    position.offset = 0
    yield* placeEvents(
      state.terminalEvents(
        visible,
        droidReportedUsage(response.usage, round.usage, protocol),
        output,
      ),
      position,
    )
    return undefined
  }
  checkWebContinuationLimit(round.index)
  const payload = continuationPayload(
    round.dispatch.processedPayload(),
    response,
    { completed, protocol },
  )
  round.observedUsage.nextRound()
  const next = await round.dispatch.send(payload)
  if (!isStream(next))
    throw webToolError(
      "web_tool_protocol_error",
      "Expected streaming tool continuation.",
    )
  return next
}

async function runBufferedDroidCalls(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  calls: ReadonlyArray<WebToolCall>,
): Promise<{ completed: Array<CompletedWebCall>; items: Array<JsonRecord> }> {
  const output = new DroidRoundOutput(carrierProtocol(options.protocol))
  const completed: Array<CompletedWebCall> = []
  for (const call of calls) {
    const kind = prepared.managed.get(call.name)?.droid ?? "search"
    const result = await runDroidCall(options, prepared, call)
    const lead = completed.length > 0 ? "\n\n" : ""
    output.append(
      `${lead}${droidCallNarration(call, kind)}${droidResultNarration(kind, result)}`,
    )
    completed.push({ call, result })
  }
  return {
    completed,
    items: output.items(carrierOf(completed, output.text)),
  }
}

function mergedResponse(
  visible: JsonRecord,
  shown: Array<JsonRecord>,
  input: { usage: JsonRecord | undefined; protocol: WebProtocol },
): JsonRecord {
  const usage = input.usage ? { usage: input.usage } : {}
  if (input.protocol === "messages")
    return { ...visible, content: shown, ...usage }
  return {
    ...visible,
    output: shown,
    output_text: responseOutputText(shown),
    ...usage,
  }
}

/** The buffered counterpart of finishDroidStreamRound, for whole responses. */
export async function completeDroidBufferedRequest(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  input: {
    first: JsonRecord
    dispatch: ManagedWebDispatch
    observedUsage: ManagedWebUsage
  },
): Promise<WebResponse> {
  const protocol = options.protocol
  const field = protocol === "messages" ? "content" : "output"
  const shown: Array<JsonRecord> = []
  let response = input.first
  let usage: JsonRecord | undefined
  for (let round = 0; round < MAX_MANAGED_WEB_ROUNDS; round++) {
    const unsuccessful = isUnsuccessfulWebResponse(response, protocol)
    const calls =
      unsuccessful ? [] : ownedDroidCalls(response, prepared, protocol)
    // Like streaming, a round the gateway did not touch passes unchanged.
    if (round === 0 && calls.length === 0 && !unsuccessful) return response
    input.observedUsage.observe(
      protocol === "responses" && response.status === "failed" ?
        undefined
      : response.usage,
      calls.length > 0,
    )
    options.signal?.throwIfAborted()
    usage = sumUsage(usage, response.usage)
    // Droid sizes its context by the reported input; accounting keeps totals.
    const reported = droidReportedUsage(response.usage, usage, protocol)
    const visible =
      calls.length > 0 ?
        withoutOwned(response, calls, protocol)
      : withoutUnexecutedManagedCalls(response, prepared.managed, { protocol })
    shown.push(...records(visible[field]))
    if (calls.length === 0)
      return mergedResponse(visible, shown, { usage: reported, protocol })
    const ran = await runBufferedDroidCalls(options, prepared, calls)
    shown.push(...ran.items)
    options.onRound?.({ response, completed: ran.completed })
    if (responseCalls(visible, protocol).length > 0)
      return mergedResponse(visible, shown, { usage: reported, protocol })
    checkWebContinuationLimit(round)
    const payload = continuationPayload(
      input.dispatch.processedPayload(),
      response,
      { completed: ran.completed, protocol },
    )
    input.observedUsage.nextRound()
    const next = await input.dispatch.send(payload)
    if (isStream(next))
      throw webToolError(
        "web_tool_protocol_error",
        "Unexpected streaming tool continuation.",
      )
    response = next
  }
  throw webToolError(
    "web_tool_limit_exceeded",
    "Web tool continuation limit exceeded.",
  )
}
