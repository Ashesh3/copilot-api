import { createHash } from "node:crypto"

/**
 * Copilot rejects Claude thinking that another model signed ("Invalid
 * signature in thinking block"), as happens when a conversation switches
 * Claude models. Signatures are also scoped to the provider deployment that
 * served them, which Copilot keeps per caller, so thinking can be rejected
 * after a pool moves a conversation to another account. Factory Droid keeps
 * signed thinking across such moves. The gateway records which model and
 * account produced each signature it relays, so recovery rewrites only the
 * blocks from another source, as readable text, and keeps the rest signed.
 * Records hold only digests, stay in memory and are bounded; unrecorded
 * blocks count as unverified.
 */
const MAX_RECORDED_SIGNATURES = 50_000
const MAX_REJECTED_PAIRS = 256

/** Where a signed thinking block came from. */
export interface ThinkingSource {
  model: string
  /** The pooled account that answered, when known. */
  account?: number
}

const producers = new Map<string, ThinkingSource>()
const rejectedPairs = new Set<string>()

type Block = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fingerprint(signature: string): string {
  return createHash("sha256").update(signature).digest("base64url")
}

function blockSignature(block: Block): string | undefined {
  let value: unknown
  if (block.type === "thinking") value = block.signature
  else if (block.type === "redacted_thinking") value = block.data
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function rememberProducer(signature: string, source: ThinkingSource): void {
  const key = fingerprint(signature)
  producers.delete(key)
  producers.set(key, { model: source.model, account: source.account })
  if (producers.size <= MAX_RECORDED_SIGNATURES) return
  const oldest = producers.keys().next()
  if (!oldest.done) producers.delete(oldest.value)
}

function producerOf(block: Block): ThinkingSource | undefined {
  const signature = blockSignature(block)
  return signature === undefined ? undefined : (
      producers.get(fingerprint(signature))
    )
}

function isOwnThinking(
  producer: ThinkingSource,
  model: unknown,
  account: number | undefined,
): boolean {
  return (
    producer.model === model
    && (producer.account === undefined
      || account === undefined
      || producer.account === account)
  )
}

function pairKey(producer: string, model: string): string {
  return JSON.stringify([producer, model])
}

/** Record the signed thinking of a buffered Messages response. */
export function recordResponseThinking(
  response: unknown,
  source: ThinkingSource,
): void {
  if (!isRecord(response) || !Array.isArray(response.content)) return
  for (const block of response.content) {
    if (!isRecord(block)) continue
    const signature = blockSignature(block)
    if (signature !== undefined) rememberProducer(signature, source)
  }
}

interface StreamChunk {
  event?: string
  data?: string
}

function parseEvent(data: string): Block | undefined {
  try {
    const parsed: unknown = JSON.parse(data)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// Parse only the few events that can carry a signature; text deltas pass by.
function isRelevantEvent(
  event: string | undefined,
  data: string,
  pending: number,
): boolean {
  switch (event) {
    case "content_block_start": {
      return data.includes("thinking")
    }
    case "content_block_delta": {
      return data.includes("signature_delta")
    }
    case "content_block_stop": {
      return pending > 0
    }
    case undefined: {
      return /signature|thinking|content_block_stop/.test(data)
    }
    default: {
      return false
    }
  }
}

function startBlock(
  parsed: Block,
  signatures: Map<number, string>,
  source: ThinkingSource,
): void {
  const block = parsed.content_block
  if (typeof parsed.index !== "number" || !isRecord(block)) return
  if (block.type === "thinking") {
    signatures.set(
      parsed.index,
      typeof block.signature === "string" ? block.signature : "",
    )
    return
  }
  const signature = blockSignature(block)
  if (signature !== undefined) rememberProducer(signature, source)
}

/** Observe an upstream Messages event stream and record its signed thinking. */
export function createThinkingStreamRecorder(
  source: ThinkingSource,
): (chunk: StreamChunk) => void {
  const signatures = new Map<number, string>()
  const finish = (index: number) => {
    const signature = signatures.get(index)
    signatures.delete(index)
    if (signature) rememberProducer(signature, source)
  }
  return (chunk) => {
    const data = chunk.data
    if (!data || !isRelevantEvent(chunk.event, data, signatures.size)) return
    const parsed = parseEvent(data)
    if (!parsed) return
    const index = typeof parsed.index === "number" ? parsed.index : undefined
    const delta = isRecord(parsed.delta) ? parsed.delta : undefined
    if (parsed.type === "content_block_start") {
      startBlock(parsed, signatures, source)
    } else if (
      index !== undefined
      && delta?.type === "signature_delta"
      && typeof delta.signature === "string"
      && signatures.has(index)
    ) {
      signatures.set(index, `${signatures.get(index)}${delta.signature}`)
    } else if (parsed.type === "content_block_stop" && index !== undefined) {
      finish(index)
    }
  }
}

function readableThinking(block: Block): Array<Block> {
  if (block.type !== "thinking" || typeof block.thinking !== "string") return []
  const text = block.thinking.trim()
  if (!text) return []
  // The same form Droid uses when it downgrades thinking it cannot replay.
  const readable: Block = {
    type: "text",
    text: `<thinking>\n${text}\n</thinking>`,
  }
  // A cache breakpoint on the block stays where the client placed it.
  if (isRecord(block.cache_control))
    readable.cache_control = block.cache_control
  return [readable]
}

function rewriteThinking(
  body: Record<string, unknown>,
  shouldRewrite: (block: Block) => boolean,
): boolean {
  if (!Array.isArray(body.messages)) return false
  let changed = false
  const emptied = new Set<unknown>()
  for (const message of body.messages) {
    if (
      !isRecord(message)
      || message.role !== "assistant"
      || !Array.isArray(message.content)
    )
      continue
    let rewritten = false
    const content: Array<unknown> = []
    for (const block of message.content as Array<unknown>) {
      if (isRecord(block) && shouldRewrite(block)) {
        rewritten = true
        content.push(...readableThinking(block))
      } else {
        content.push(block)
      }
    }
    if (!rewritten) continue
    changed = true
    message.content = content
    if (content.length === 0) emptied.add(message)
  }
  if (emptied.size > 0) {
    body.messages = body.messages.filter((message) => !emptied.has(message))
  }
  return changed
}

function isUnverified(
  block: Block,
  model: unknown,
  account: number | undefined,
): boolean {
  if (block.type !== "thinking" && block.type !== "redacted_thinking")
    return false
  const producer = producerOf(block)
  const own = producer !== undefined && isOwnThinking(producer, model, account)
  // Redacted thinking has no readable form, so only known foreign blocks go.
  if (block.type === "redacted_thinking") return producer !== undefined && !own
  return !own
}

/**
 * Retry normalization for a rejected thinking signature: rewrite as text the
 * thinking another model or account produced, keeping the blocks this model
 * signed on the answering account. When every block came from that source,
 * as after Copilot moved the caller to another deployment, rewrite all
 * readable thinking instead.
 */
export function rewriteRejectedThinking(
  body: Record<string, unknown>,
  account?: number,
): boolean {
  const model = body.model
  if (rewriteThinking(body, (block) => isUnverified(block, model, account)))
    return true
  return rewriteThinking(body, (block) => block.type === "thinking")
}

/** Other models whose recorded thinking a request replays. */
export function foreignThinkingProducers(
  body: Record<string, unknown>,
): Set<string> {
  const found = new Set<string>()
  if (!Array.isArray(body.messages)) return found
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<unknown>) {
      if (!isRecord(block)) continue
      const producer = producerOf(block)?.model
      if (producer !== undefined && producer !== body.model) found.add(producer)
    }
  }
  return found
}

/** Remember that `model` rejected thinking produced by these models. */
export function rememberRejectedThinkingProducers(
  rejected: Iterable<string>,
  model: string,
): void {
  for (const producer of rejected) {
    const key = pairKey(producer, model)
    rejectedPairs.delete(key)
    rejectedPairs.add(key)
    if (rejectedPairs.size > MAX_REJECTED_PAIRS) {
      const oldest = rejectedPairs.values().next()
      if (!oldest.done) rejectedPairs.delete(oldest.value)
    }
  }
}

/**
 * Before sending, rewrite thinking from models this model already rejected, so
 * a conversation does not fail once on every later turn.
 */
export function rewriteLearnedForeignThinking(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (rejectedPairs.size === 0 || typeof body.model !== "string") return body
  const model = body.model
  const isRejected = (producer: string | undefined) =>
    producer !== undefined && rejectedPairs.has(pairKey(producer, model))
  const foreign = [...foreignThinkingProducers(body)]
  if (!foreign.some((producer) => isRejected(producer))) return body
  const rewritten = structuredClone(body)
  rewriteThinking(rewritten, (block) => isRejected(producerOf(block)?.model))
  return rewritten
}

export function resetThinkingProvenanceForTest(): void {
  producers.clear()
  rejectedPairs.clear()
}
