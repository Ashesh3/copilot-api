import {
  runWithMessagesFallbackScope,
  startClientFallbackCapture,
  type FallbackCaptureIdentity,
} from "~/lib/llm-debug-client-fallback"

export type LlmDebugFallbackObservation =
  | {
      kind: "requested"
      sourceModel: string
      targetModels: Array<string> | "default"
    }
  | { kind: "upstream"; fromModel: string; targetModel: string }
  | {
      kind: "client"
      fromModel: string
      targetModel: string
      previousLogId: string
      reason: "refusal"
      evidence: "inferred"
    }

const MAX_OBSERVED_MODELS = 16
// Bound optional badge metadata without rejecting or changing the request.
const MAX_OBSERVED_MODEL_NAME_LENGTH = 512

export function runWithMessagesFallbackObservation<T>(
  options: { request: Request; payload: unknown },
  callback: () => T,
): T {
  return runWithMessagesFallbackScope(
    {
      ...options,
      requested: requestedMessagesFallback(options.payload),
    },
    callback,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function modelName(value: unknown): string | undefined {
  return (
      typeof value === "string"
        && value.trim().length > 0
        && value.length <= MAX_OBSERVED_MODEL_NAME_LENGTH
    ) ?
      value
    : undefined
}

function parseRecord(
  value: string | null,
): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function requestedMessagesFallback(
  payload: unknown,
): LlmDebugFallbackObservation | undefined {
  if (!isRecord(payload)) return undefined
  const sourceModel = modelName(payload.model)
  if (!sourceModel) return undefined
  if (payload.fallbacks === "default") {
    return { kind: "requested", sourceModel, targetModels: "default" }
  }
  if (
    !Array.isArray(payload.fallbacks)
    || payload.fallbacks.length === 0
    || payload.fallbacks.length > MAX_OBSERVED_MODELS
  )
    return undefined
  const targetModels: Array<string> = []
  for (const entry of payload.fallbacks) {
    const model = isRecord(entry) ? modelName(entry.model) : undefined
    if (!model) return undefined
    targetModels.push(model)
  }
  return { kind: "requested", sourceModel, targetModels }
}

export function startLlmDebugFallbackCapture(
  input: FallbackCaptureIdentity & { path: string; body: string | null },
): Array<LlmDebugFallbackObservation> {
  const scoped = startClientFallbackCapture(input)
  if (scoped) return scoped
  if (input.path !== "/v1/messages") return []
  const observation = requestedMessagesFallback(parseRecord(input.body))
  return observation ? [observation] : []
}

function upstreamFallback(
  block: unknown,
): LlmDebugFallbackObservation | undefined {
  if (
    !isRecord(block)
    || block.type !== "fallback"
    || !isRecord(block.from)
    || !isRecord(block.to)
  )
    return undefined
  const fromModel = modelName(block.from.model)
  const targetModel = modelName(block.to.model)
  return fromModel && targetModel ?
      { kind: "upstream", fromModel, targetModel }
    : undefined
}

function appendUpstreamFallbacks(
  observations: Array<LlmDebugFallbackObservation>,
  content: unknown,
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (observations.length >= MAX_OBSERVED_MODELS) return
    const observation = upstreamFallback(block)
    if (
      observation
      && !observations.some(
        (entry) => JSON.stringify(entry) === JSON.stringify(observation),
      )
    )
      observations.push(observation)
  }
}

export function nativeMessagesFallbackEvidence(options: {
  body: string | null
  contentType: string
}): { observations: Array<LlmDebugFallbackObservation>; refused: boolean } {
  const observations: Array<LlmDebugFallbackObservation> = []
  if (!options.contentType.includes("text/event-stream")) {
    const message = parseRecord(options.body)
    if (message?.type !== "message") return { observations, refused: false }
    appendUpstreamFallbacks(observations, message.content)
    return { observations, refused: message.stop_reason === "refusal" }
  }
  return nativeMessagesStreamEvidence(options.body ?? "", observations)
}

function nativeMessagesStreamEvidence(
  body: string,
  observations: Array<LlmDebugFallbackObservation>,
): { observations: Array<LlmDebugFallbackObservation>; refused: boolean } {
  let started = false
  let stopped = false
  let failed = false
  let stopReason: unknown
  for (const event of nativeStreamEvents(body)) {
    if (event.type === "message_start" && isRecord(event.message)) {
      started = true
      appendUpstreamFallbacks(observations, event.message.content)
      stopReason = event.message.stop_reason
    }
    if (started && event.type === "content_block_start") {
      appendUpstreamFallbacks(observations, [event.content_block])
    }
    if (event.type === "message_delta" && isRecord(event.delta)) {
      stopReason = event.delta.stop_reason ?? stopReason
    }
    if (event.type === "message_stop") stopped = true
    if (event.type === "error") failed = true
  }
  return {
    observations,
    refused: started && stopped && !failed && stopReason === "refusal",
  }
}

function* nativeStreamEvents(body: string): Generator<Record<string, unknown>> {
  const boundary = /\r?\n\r?\n/gu
  let offset = 0
  for (const match of body.matchAll(boundary)) {
    const frame = body.slice(offset, match.index)
    offset = match.index + match[0].length
    const data = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    const event = parseRecord(data)
    if (event) yield event
  }
}
