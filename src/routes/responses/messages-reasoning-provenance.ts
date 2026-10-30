import type {
  AnthropicRedactedThinkingBlock,
  AnthropicThinkingBlock,
} from "~/routes/messages/anthropic-types"

export const ANTHROPIC_REASONING_ENVELOPE_PREFIX = "capi_anthropic_v1:"
const MAX_ENVELOPE_LENGTH = 1024 * 1024
const CLAUDE_VARIANT_SUFFIX = /-(?:fast|1m|\d{8})$/u

type ReasoningBlock = AnthropicThinkingBlock | AnthropicRedactedThinkingBlock

export interface AnthropicReasoningEnvelope {
  readonly blocks: Array<ReasoningBlock>
  /** The thinking text is progress-update narration the client was shown. */
  readonly progressUpdates: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The Anthropic model behind a model ID. Thinking is bound to the model that
 * produced it, but one Claude model has several IDs: Anthropic's dashed
 * version, a dated snapshot, and the fast-mode and 1M-context variants all
 * run the same model, so each can verify the others' thinking. Other IDs are
 * compared as given.
 */
export function anthropicReasoningModelIdentity(model: string): string {
  let identity = model.trim().toLowerCase()
  if (!identity.startsWith("claude-")) return model
  while (CLAUDE_VARIANT_SUFFIX.test(identity)) {
    identity = identity.replace(CLAUDE_VARIANT_SUFFIX, "")
  }
  return identity.replaceAll(/(?<!\d)(\d)-(\d)(?!\d)/gu, "$1.$2")
}

/** Whether thinking produced by one model can be replayed to another. */
export function sharesAnthropicReasoningModel(
  producer: string,
  consumer: string,
): boolean {
  return (
    producer === consumer
    || anthropicReasoningModelIdentity(producer)
      === anthropicReasoningModelIdentity(consumer)
  )
}

function readBlock(value: unknown): ReasoningBlock | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.type === "thinking"
    && typeof value.thinking === "string"
    && typeof value.signature === "string"
    && value.signature.length > 0
  ) {
    return {
      type: "thinking",
      thinking: value.thinking,
      signature: value.signature,
    }
  }
  if (
    value.type === "redacted_thinking"
    && typeof value.data === "string"
    && value.data.length > 0
  ) {
    return { type: "redacted_thinking", data: value.data }
  }
  return undefined
}

/** Provider provenance only: Anthropic remains responsible for signature verification. */
export function encodeAnthropicReasoningEnvelope(
  model: string,
  blocks: ReadonlyArray<ReasoningBlock>,
  options?: { readonly progressUpdates?: boolean },
): string {
  const envelope = {
    model,
    blocks,
    ...(options?.progressUpdates ? { display: "updates" } : {}),
  }
  return (
    ANTHROPIC_REASONING_ENVELOPE_PREFIX
    + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")
  )
}

export function decodeAnthropicReasoningEnvelope(
  value: unknown,
  model?: string,
): Array<ReasoningBlock> | undefined {
  return readAnthropicReasoningEnvelope(value, model)?.blocks
}

export function readAnthropicReasoningEnvelope(
  value: unknown,
  model?: string,
): AnthropicReasoningEnvelope | undefined {
  if (
    typeof value !== "string"
    || value.length > MAX_ENVELOPE_LENGTH
    || !value.startsWith(ANTHROPIC_REASONING_ENVELOPE_PREFIX)
  ) {
    return undefined
  }
  const encoded = value.slice(ANTHROPIC_REASONING_ENVELOPE_PREFIX.length)
  if (!encoded || !/^[\w-]+$/.test(encoded)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed)
    || typeof parsed.model !== "string"
    || !parsed.model
    || (model !== undefined
      && !sharesAnthropicReasoningModel(parsed.model, model))
    || !Array.isArray(parsed.blocks)
    || parsed.blocks.length === 0
  ) {
    return undefined
  }
  const blocks: Array<ReasoningBlock> = []
  for (const raw of parsed.blocks) {
    const block = readBlock(raw)
    if (!block) return undefined
    blocks.push(block)
  }
  return { blocks, progressUpdates: parsed.display === "updates" }
}
