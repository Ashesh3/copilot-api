import { sharesAnthropicReasoningModel } from "./messages-reasoning-provenance"

/**
 * A Responses turn served by Chat Completions keeps the model's Chat reasoning
 * state (`reasoning_opaque`, `encrypted_content`) in its reasoning item's
 * `encrypted_content`, bound to the upstream model that produced it. Clients
 * replay `encrypted_content` but drop item IDs they cannot replay, so no
 * state is ever kept in an item ID.
 */
export const CHAT_REASONING_ENVELOPE_PREFIX = "capi_chat_v1:"
const MAX_ENVELOPE_LENGTH = 1024 * 1024

export interface ChatReasoningState {
  readonly reasoning_opaque?: string
  readonly encrypted_content?: string
}

export interface ChatReasoningEnvelope extends ChatReasoningState {
  /** The upstream Chat model that produced the reasoning. */
  readonly model: string
}

/** Chat assistant-message fields that return reasoning to its model. */
export interface ChatReasoningMessageFields extends ChatReasoningState {
  readonly reasoning_text?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Provider provenance only: the provider still decrypts and verifies its own
 * state. Without state the envelope records only which model reasoned, so
 * that model's own reasoning is not replayed to it as conversation text.
 */
export function encodeChatReasoningEnvelope(
  model: string,
  state: ChatReasoningState,
): string | undefined {
  const envelope = {
    model,
    ...(state.reasoning_opaque ?
      { reasoning_opaque: state.reasoning_opaque }
    : {}),
    ...(state.encrypted_content ?
      { encrypted_content: state.encrypted_content }
    : {}),
  }
  const encoded =
    CHAT_REASONING_ENVELOPE_PREFIX
    + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")
  // An envelope too large to read back would only cost bytes on every turn.
  return encoded.length <= MAX_ENVELOPE_LENGTH ? encoded : undefined
}

export function isChatReasoningEnvelope(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.startsWith(CHAT_REASONING_ENVELOPE_PREFIX)
  )
}

function readOptionalState(value: unknown): string | undefined | false {
  if (value === undefined) return undefined
  return typeof value === "string" && value.length > 0 ? value : false
}

export function readChatReasoningEnvelope(
  value: unknown,
): ChatReasoningEnvelope | undefined {
  if (
    typeof value !== "string"
    || value.length > MAX_ENVELOPE_LENGTH
    || !value.startsWith(CHAT_REASONING_ENVELOPE_PREFIX)
  ) {
    return undefined
  }
  const encoded = value.slice(CHAT_REASONING_ENVELOPE_PREFIX.length)
  if (!encoded || !/^[\w-]+$/.test(encoded)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.model !== "string" || !parsed.model) {
    return undefined
  }
  const opaque = readOptionalState(parsed.reasoning_opaque)
  const encrypted = readOptionalState(parsed.encrypted_content)
  if (opaque === false || encrypted === false) return undefined
  return {
    model: parsed.model,
    ...(opaque ? { reasoning_opaque: opaque } : {}),
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  }
}

/**
 * Whether reasoning produced by one upstream model is the consumer's own.
 * Other IDs are compared as given; one Claude model's IDs share reasoning.
 */
export function sharesChatReasoningModel(
  producer: string,
  consumer: string,
): boolean {
  return sharesAnthropicReasoningModel(producer, consumer)
}

/**
 * The message fields that return an envelope's state with the reasoning
 * summary as its text, or undefined when the envelope holds no state.
 */
export function chatReasoningMessageFields(
  envelope: ChatReasoningEnvelope,
  summary: unknown,
): ChatReasoningMessageFields | undefined {
  if (!envelope.reasoning_opaque && !envelope.encrypted_content)
    return undefined
  const text =
    Array.isArray(summary) ?
      summary
        .flatMap((entry) =>
          isRecord(entry) && typeof entry.text === "string" ? [entry.text] : [],
        )
        .join("")
    : ""
  return {
    ...(text ? { reasoning_text: text } : {}),
    ...(envelope.reasoning_opaque ?
      { reasoning_opaque: envelope.reasoning_opaque }
    : {}),
    ...(envelope.encrypted_content ?
      { encrypted_content: envelope.encrypted_content }
    : {}),
  }
}
