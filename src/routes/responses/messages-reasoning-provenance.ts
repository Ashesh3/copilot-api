import type {
  AnthropicRedactedThinkingBlock,
  AnthropicThinkingBlock,
} from "~/routes/messages/anthropic-types"

export const ANTHROPIC_REASONING_ENVELOPE_PREFIX = "capi_anthropic_v1:"
const MAX_ENVELOPE_LENGTH = 1024 * 1024

type ReasoningBlock = AnthropicThinkingBlock | AnthropicRedactedThinkingBlock

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
): string {
  return (
    ANTHROPIC_REASONING_ENVELOPE_PREFIX
    + Buffer.from(JSON.stringify({ model, blocks }), "utf8").toString(
      "base64url",
    )
  )
}

export function decodeAnthropicReasoningEnvelope(
  value: unknown,
  model?: string,
): Array<ReasoningBlock> | undefined {
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
    || (model !== undefined && parsed.model !== model)
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
  return blocks
}
