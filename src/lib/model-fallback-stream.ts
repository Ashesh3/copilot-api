const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024

type Terminal = "chat-terminal" | "failure" | "success" | undefined

interface ObservationState {
  cancelled: boolean
  deferred: Array<Uint8Array>
  deferredBytes: number
  eligible: boolean
  sawChatChunk: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice()
  const joined = new Uint8Array(left.byteLength + right.byteLength)
  joined.set(left)
  joined.set(right, left.byteLength)
  return joined
}

function newlineLength(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] === 10) return 1
  if (bytes[offset] !== 13) return 0
  if (offset + 1 === bytes.byteLength) return 0
  return bytes[offset + 1] === 10 ? 2 : 1
}

function eventBoundary(bytes: Uint8Array): number | undefined {
  for (let index = 0; index < bytes.byteLength; index++) {
    const first = newlineLength(bytes, index)
    if (first === 0) continue
    const second = newlineLength(bytes, index + first)
    if (second > 0) return index + first + second
    index += first - 1
  }
  return undefined
}

function parseEvent(bytes: Uint8Array): { data?: string; event?: string } {
  // eslint-disable-next-line unicorn/text-encoding-identifier-case -- TypeScript's DOM Encoding type requires the WHATWG label.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const data: Array<string> = []
  let event: string | undefined
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (!line || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "event") event = value
  }
  return {
    ...(data.length > 0 ? { data: data.join("\n") } : {}),
    ...(event === undefined ? {} : { event }),
  }
}

function isChatChunk(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.choices) || value.choices.length === 0) return false
  return value.choices.every(
    (choice) =>
      isRecord(choice)
      && ["delta", "finish_reason", "message", "text"].some((key) =>
        Object.hasOwn(choice, key),
      ),
  )
}

function hasChatTerminal(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.choices)
    && value.choices.some(
      (choice) =>
        isRecord(choice)
        && choice.finish_reason !== null
        && choice.finish_reason !== undefined,
    )
  )
}

function isResponsesCompletion(value: Record<string, unknown>): boolean {
  return (
    value.type === "response.completed"
    && isRecord(value.response)
    && value.response.status === "completed"
  )
}

function failedEvent(
  event: ReturnType<typeof parseEvent>,
  value: Record<string, unknown>,
): boolean {
  return (
    event.event === "error"
    || event.event === "response.failed"
    || event.event === "response.incomplete"
    || value.type === "error"
    || value.type === "response.failed"
    || value.type === "response.incomplete"
    || (value.error !== null && value.error !== undefined)
  )
}

function classifyEvent(bytes: Uint8Array, state: ObservationState): Terminal {
  let event: ReturnType<typeof parseEvent>
  try {
    event = parseEvent(bytes)
  } catch {
    state.eligible = false
    return "failure"
  }
  const data = event.data?.trim()
  if (!data) {
    if (event.event !== "error") return undefined
    state.eligible = false
    return "failure"
  }
  if (data === "[DONE]") {
    if (state.sawChatChunk) return "success"
    state.eligible = false
    return "failure"
  }
  let value: unknown
  try {
    value = JSON.parse(data) as unknown
  } catch {
    state.eligible = false
    return "failure"
  }
  if (!isRecord(value)) return undefined
  if (failedEvent(event, value)) {
    state.eligible = false
    return "failure"
  }
  if (isResponsesCompletion(value) || value.type === "message_stop")
    return "success"
  if (isChatChunk(value)) {
    state.sawChatChunk = true
    if (hasChatTerminal(value)) return "chat-terminal"
  }
  return undefined
}

async function finishAtEof(
  controller: ReadableStreamDefaultController<Uint8Array>,
  stream: { pending: Uint8Array; state: ObservationState },
  onSuccess: () => Promise<void>,
): Promise<void> {
  const { pending, state } = stream
  const trailing = new TextDecoder().decode(pending).trim()
  if (
    !state.cancelled
    && state.eligible
    && state.deferred.length > 0
    && trailing.length === 0
  )
    await onSuccess()
  for (const frame of state.deferred) controller.enqueue(frame)
  if (pending.byteLength > 0) controller.enqueue(pending)
  controller.close()
}

/**
 * Forward an SSE response byte-for-byte while delaying durable fallback
 * acknowledgement until a successful protocol terminal is observed.
 */
// eslint-disable-next-line max-lines-per-function -- The wrapper owns one bounded stream state machine and its cleanup.
export function observeModelFallbackStream(
  response: Response,
  onSuccess: () => Promise<void>,
): Response {
  if (
    !response.body
    || !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/event-stream")
  )
    return response

  const reader = response.body.getReader()
  const observation = {
    pending: new Uint8Array() as Uint8Array,
    passthrough: false,
  }
  const state: ObservationState = {
    cancelled: false,
    deferred: [],
    deferredBytes: 0,
    eligible: true,
    sawChatChunk: false,
  }
  const body = new ReadableStream<Uint8Array>({
    // eslint-disable-next-line complexity -- Protocol terminals, bounded buffering, pass-through, and cancellation share one ordered pull.
    async pull(controller) {
      try {
        while (true) {
          const boundary = eventBoundary(observation.pending)
          if (boundary === undefined) {
            const next = await reader.read()
            if (next.done) {
              await finishAtEof(
                controller,
                { pending: observation.pending, state },
                onSuccess,
              )
              return
            }
            const chunk = next.value as Uint8Array
            if (observation.passthrough) {
              controller.enqueue(chunk)
              return
            }
            observation.pending = append(observation.pending, chunk)
            if (observation.pending.byteLength <= MAX_SSE_EVENT_BYTES) continue
            state.eligible = false
            observation.passthrough = true
            for (const frame of state.deferred) controller.enqueue(frame)
            state.deferred = []
            controller.enqueue(observation.pending)
            observation.pending = new Uint8Array()
            return
          }
          const frame = observation.pending.slice(0, boundary)
          observation.pending = observation.pending.slice(boundary)
          if (frame.byteLength > MAX_SSE_EVENT_BYTES) {
            state.eligible = false
            observation.passthrough = true
            for (const deferred of state.deferred) controller.enqueue(deferred)
            state.deferred = []
            controller.enqueue(frame)
            if (observation.pending.byteLength > 0)
              controller.enqueue(observation.pending)
            observation.pending = new Uint8Array()
            return
          }
          const terminal = classifyEvent(frame, state)
          if (terminal === "success" && state.eligible && !state.cancelled) {
            await onSuccess()
            for (const deferred of state.deferred) controller.enqueue(deferred)
            state.deferred = []
            state.deferredBytes = 0
            controller.enqueue(frame)
            if (observation.pending.byteLength > 0)
              controller.enqueue(observation.pending)
            observation.pending = new Uint8Array()
            observation.passthrough = true
            return
          }
          if (terminal === "failure") {
            for (const deferred of state.deferred) controller.enqueue(deferred)
            state.deferred = []
            state.deferredBytes = 0
            controller.enqueue(frame)
            if (observation.pending.byteLength > 0)
              controller.enqueue(observation.pending)
            observation.pending = new Uint8Array()
            observation.passthrough = true
            return
          }
          if (terminal === "chat-terminal" || state.deferred.length > 0) {
            state.deferred.push(frame)
            state.deferredBytes += frame.byteLength
            if (state.deferredBytes <= MAX_SSE_EVENT_BYTES) continue
            state.eligible = false
            observation.passthrough = true
            for (const deferred of state.deferred) controller.enqueue(deferred)
            state.deferred = []
            if (observation.pending.byteLength > 0)
              controller.enqueue(observation.pending)
            observation.pending = new Uint8Array()
            return
          }
          controller.enqueue(frame)
          return
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
    },
    cancel(reason) {
      state.cancelled = true
      return reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}
