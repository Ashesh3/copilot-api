import type { ContextOverflow } from "./context-overflow"

/**
 * Codex memory extraction sends one stored conversation (a rollout) per
 * request. Codex sizes the rollout at four bytes per token, which JSON-heavy
 * rollouts exceed, so Copilot can refuse the request as over the model's
 * prompt limit. Codex's own answer to an oversized rollout is to keep its
 * start and end; the gateway removes more of the middle the same way.
 */

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata"
// Codex frames the rollout in its extraction prompt with these lines.
const ROLLOUT_START =
  "rendered conversation (pre-rendered from rollout `.jsonl`; filtered response items):\n"
const ROLLOUT_END = "\n\nIMPORTANT:\n"
// Codex splits long extraction evidence into messages of at most this size.
const EVIDENCE_CHUNK_BYTES = 8900
// Token counts follow text length only roughly, so aim under the limit.
const LIMIT_MARGIN = 0.9
// Without Copilot's counts, each resend drops this share of the rollout.
const UNCOUNTED_TRIM_SHARE = 0.25

interface TextSlot {
  readonly itemIndex: number
  readonly onlyContent: boolean
  readonly text: string
  readonly set: (text: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function isCodexMemoryRequest(
  payload: Record<string, unknown>,
): boolean {
  const clientMetadata = parseRecord(payload.client_metadata)
  const turn = parseRecord(clientMetadata?.[CODEX_TURN_METADATA_KEY])
  return turn?.request_kind === "memory"
}

function userTextSlots(input: Array<unknown>): Array<TextSlot> {
  const slots: Array<TextSlot> = []
  for (const [itemIndex, item] of input.entries()) {
    if (!isRecord(item) || item.role !== "user") continue
    if (item.type !== undefined && item.type !== "message") continue
    const { content } = item
    if (typeof content === "string") {
      slots.push({
        itemIndex,
        onlyContent: true,
        text: content,
        set: (text) => {
          item.content = text
        },
      })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isRecord(part) || typeof part.text !== "string") continue
      slots.push({
        itemIndex,
        onlyContent: content.length === 1,
        text: part.text,
        set: (text) => {
          part.text = text
        },
      })
    }
  }
  return slots
}

interface RolloutLocation {
  /** The slots holding the prompt, in order. */
  readonly span: Array<TextSlot>
  readonly text: string
  /** Where the rollout starts and ends in `text`. */
  readonly start: number
  readonly end: number
}

function rolloutBounds(
  text: string,
): { start: number; end: number } | undefined {
  const marker = text.indexOf(ROLLOUT_START)
  if (marker === -1) return undefined
  const start = marker + ROLLOUT_START.length
  const end = text.lastIndexOf(ROLLOUT_END)
  return end >= start ? { start, end } : undefined
}

/**
 * The prompt is one text, or a run of single-text messages when Codex splits
 * long evidence, possibly mid-line.
 */
function locateRollout(slots: Array<TextSlot>): RolloutLocation | undefined {
  const first = slots.findIndex((slot) => slot.text.includes(ROLLOUT_START))
  if (first === -1) return undefined
  const single = rolloutBounds(slots[first].text)
  if (single)
    return { span: [slots[first]], text: slots[first].text, ...single }
  if (!slots[first].onlyContent) return undefined
  let next = first + 1
  while (
    next < slots.length
    && slots[next].onlyContent
    && slots[next].itemIndex === slots[next - 1].itemIndex + 1
  ) {
    next += 1
  }
  const span = slots.slice(first, next)
  const text = span.map((slot) => slot.text).join("")
  const bounds = rolloutBounds(text)
  return bounds ? { span, text, ...bounds } : undefined
}

function deepTextLength(value: unknown): number {
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, entry) => total + deepTextLength(entry),
      0,
    )
  }
  if (!isRecord(value)) return 0
  return Object.values(value).reduce<number>(
    (total, entry) => total + deepTextLength(entry),
    0,
  )
}

function promptLength(payload: Record<string, unknown>): number {
  const instructions =
    typeof payload.instructions === "string" ? payload.instructions.length : 0
  const tools =
    payload.tools === undefined ? 0 : JSON.stringify(payload.tools).length
  return deepTextLength(payload.input) + instructions + tools
}

function charsToRemove(
  overflow: ContextOverflow,
  rolloutLength: number,
  totalLength: number,
): number {
  const { limit, promptTokens } = overflow
  if (promptTokens !== undefined && limit !== undefined && promptTokens > 0) {
    const keep = Math.min(1, (limit * LIMIT_MARGIN) / promptTokens)
    return Math.ceil(totalLength * (1 - keep))
  }
  return Math.ceil(rolloutLength * UNCOUNTED_TRIM_SHARE)
}

/** Whether cutting `text` at `index` would split a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  return index > 0 && (text.codePointAt(index - 1) ?? 0) > 0xff_ff
}

/** Keep the start and end of `text`, dropping `remove` characters between. */
function removeMiddle(text: string, remove: number): string {
  const kept = text.length - remove
  let headEnd = Math.floor(kept / 2)
  if (splitsPair(text, headEnd)) headEnd -= 1
  let tailStart = text.length - (kept - headEnd)
  if (splitsPair(text, tailStart)) tailStart += 1
  return `${text.slice(0, headEnd)}…${tailStart - headEnd} chars truncated…${text.slice(tailStart)}`
}

function splitByBytes(text: string, maxBytes: number): Array<string> {
  const chunks: Array<string> = []
  let chunk = ""
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > maxBytes && chunk) {
      chunks.push(chunk)
      chunk = ""
      bytes = 0
    }
    chunk += character
    bytes += size
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

/**
 * Remove enough of the middle of a Codex memory rollout to fit the limit
 * Copilot reported. Mutates `payload`; returns the characters removed, or 0
 * when the request is not a memory extraction or trimming cannot help.
 */
export function trimCodexMemoryRollout(
  payload: Record<string, unknown>,
  overflow: ContextOverflow,
): number {
  if (!isCodexMemoryRequest(payload) || !Array.isArray(payload.input)) return 0
  const input = payload.input as Array<unknown>
  const location = locateRollout(userTextSlots(input))
  if (!location) return 0
  const { end, span, start } = location
  const rollout = location.text.slice(start, end)
  const remove = charsToRemove(overflow, rollout.length, promptLength(payload))
  if (remove <= 0 || remove >= rollout.length) return 0

  const text =
    location.text.slice(0, start)
    + removeMiddle(rollout, remove)
    + location.text.slice(end)
  if (span.length === 1) {
    span[0].set(text)
    return remove
  }
  const chunks = splitByBytes(text, EVIDENCE_CHUNK_BYTES)
  if (chunks.length > span.length) return 0
  for (const [index, chunk] of chunks.entries()) span[index].set(chunk)
  input.splice(span[0].itemIndex + chunks.length, span.length - chunks.length)
  return remove
}
