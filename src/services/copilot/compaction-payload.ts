import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { HTTPError } from "~/lib/error"

export const COMPACTION_PAYLOAD_MAX_BYTES = 30 * 1024 * 1024

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata"
const TOOL_OUTPUT_TYPES = new Set([
  "custom_tool_call_output",
  "function_call_output",
])
const MINIMUM_RETAINED_EDGE_BYTES = 512

export interface CompactionPayloadFitResult<T> {
  payload: T
  originalBytes: number
  finalBytes: number
  omittedBinaryBlocks: number
  truncatedToolOutputBytes: number
  reduced: boolean
}

interface ReductionCounts {
  omittedBinaryBlocks: number
}

interface TextSlot {
  originalText: string
  originalBytes: number
  setText: (text: string) => void
}

interface TruncatedText {
  text: string
  omittedBytes: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isUnknownArray = (value: unknown): value is Array<unknown> =>
  Array.isArray(value)

const parseRecord = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return value
  if (typeof value !== "string") return null

  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isResponsesCompactionRequest(
  payload: ResponsesPayload,
): boolean {
  const clientMetadata = parseRecord(payload.client_metadata)
  if (!clientMetadata) return false

  const turnMetadata = parseRecord(clientMetadata[CODEX_TURN_METADATA_KEY])
  return turnMetadata?.request_kind === "compaction"
}

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8")

const isInlineData = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("data:")

const omissionNote = (kind: "file" | "image"): Record<string, string> => ({
  type: "input_text",
  text: `[inline ${kind} bytes omitted during compaction]`,
})

const elideInlineAttachments = (
  value: unknown,
  counts: ReductionCounts,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => elideInlineAttachments(entry, counts))
  }
  if (!isRecord(value)) return value

  if (value.type === "input_image" && isInlineData(value.image_url)) {
    counts.omittedBinaryBlocks += 1
    return omissionNote("image")
  }
  if (value.type === "input_file" && typeof value.file_data === "string") {
    counts.omittedBinaryBlocks += 1
    return omissionNote("file")
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      elideInlineAttachments(entry, counts),
    ]),
  )
}

const addTextSlot = (
  originalText: string,
  setText: (text: string) => void,
  slots: Array<TextSlot>,
): void => {
  slots.push({
    originalText,
    originalBytes: Buffer.byteLength(originalText, "utf8"),
    setText,
  })
}

const collectOutputTextSlots = (
  output: unknown,
  setOutput: (value: unknown) => void,
  slots: Array<TextSlot>,
): void => {
  if (typeof output === "string") {
    addTextSlot(output, setOutput, slots)
    return
  }
  if (!isUnknownArray(output)) return

  for (let index = 0; index < output.length; index += 1) {
    const entry = output[index]
    if (typeof entry === "string") {
      addTextSlot(
        entry,
        (text) => {
          output[index] = text
        },
        slots,
      )
      continue
    }
    if (!isRecord(entry) || typeof entry.text !== "string") continue

    addTextSlot(
      entry.text,
      (text) => {
        entry.text = text
      },
      slots,
    )
  }
}

const collectToolOutputSlots = (
  value: unknown,
  slots: Array<TextSlot>,
): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collectToolOutputSlots(entry, slots)
    return
  }
  if (!isRecord(value)) return

  if (typeof value.type === "string" && TOOL_OUTPUT_TYPES.has(value.type)) {
    collectOutputTextSlots(
      value.output,
      (output) => {
        value.output = output
      },
      slots,
    )
    return
  }

  for (const entry of Object.values(value)) {
    collectToolOutputSlots(entry, slots)
  }
}

const decodePrefixAtLeast = (buffer: Buffer, minimumBytes: number): string => {
  const decoder = new TextDecoder("utf8", { fatal: true })
  let end = Math.min(buffer.length, minimumBytes)

  while (end <= buffer.length) {
    try {
      return decoder.decode(buffer.subarray(0, end))
    } catch {
      end += 1
    }
  }
  return buffer.toString("utf8")
}

const decodeSuffixAtLeast = (buffer: Buffer, minimumBytes: number): string => {
  const decoder = new TextDecoder("utf8", { fatal: true })
  let start = Math.max(0, buffer.length - minimumBytes)

  while (start >= 0) {
    try {
      return decoder.decode(buffer.subarray(start))
    } catch {
      start -= 1
    }
  }
  return buffer.toString("utf8")
}

const truncateText = (text: string, retainedBytes: number): TruncatedText => {
  const buffer = Buffer.from(text, "utf8")
  if (retainedBytes >= buffer.length) {
    return { text, omittedBytes: 0 }
  }

  const prefixTarget = Math.ceil(retainedBytes / 2)
  const suffixTarget = Math.floor(retainedBytes / 2)
  const prefix = decodePrefixAtLeast(buffer, prefixTarget)
  const suffix = decodeSuffixAtLeast(buffer, suffixTarget)
  const actualRetainedBytes =
    Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8")

  if (actualRetainedBytes >= buffer.length) {
    return { text, omittedBytes: 0 }
  }

  const omittedBytes = buffer.length - actualRetainedBytes
  return {
    text:
      prefix
      + `\n[${omittedBytes} UTF-8 bytes omitted during compaction]\n`
      + suffix,
    omittedBytes,
  }
}

const createPayloadTooLargeError = (bytes: number, maxBytes: number) =>
  new HTTPError(
    "Compaction payload exceeds the safe upstream budget because preserved conversation content is too large",
    Response.json(
      {
        error: {
          code: "compaction_payload_too_large",
          message:
            "Preserved conversation content exceeds the safe compaction payload budget",
          max_bytes: maxBytes,
          payload_bytes: bytes,
        },
      },
      { status: 413 },
    ),
  )

export function fitResponsesCompactionPayload<
  T extends Record<string, unknown>,
>(
  payload: T,
  maxBytes = COMPACTION_PAYLOAD_MAX_BYTES,
): CompactionPayloadFitResult<T> {
  const originalBytes = serializedBytes(payload)
  if (originalBytes <= maxBytes) {
    return {
      payload,
      originalBytes,
      finalBytes: originalBytes,
      omittedBinaryBlocks: 0,
      truncatedToolOutputBytes: 0,
      reduced: false,
    }
  }

  const reducedPayload = structuredClone(payload)
  const counts: ReductionCounts = { omittedBinaryBlocks: 0 }
  if ("input" in reducedPayload) {
    reducedPayload.input = elideInlineAttachments(reducedPayload.input, counts)
  }

  let currentBytes = serializedBytes(reducedPayload)
  let truncatedToolOutputBytes = 0
  if (currentBytes > maxBytes) {
    const slots: Array<TextSlot> = []
    collectToolOutputSlots(reducedPayload.input, slots)
    slots.sort((left, right) => right.originalBytes - left.originalBytes)

    for (const slot of slots) {
      if (currentBytes <= maxBytes) break
      if (slot.originalBytes <= MINIMUM_RETAINED_EDGE_BYTES * 2) continue

      const originalSerializedBytes = serializedBytes(slot.originalText)
      const minimumRetainedBytes = MINIMUM_RETAINED_EDGE_BYTES * 2
      const minimumCandidate = truncateText(
        slot.originalText,
        minimumRetainedBytes,
      )
      const minimumSerializedBytes = serializedBytes(minimumCandidate.text)
      if (minimumSerializedBytes >= originalSerializedBytes) continue

      const minimumPayloadBytes =
        currentBytes - originalSerializedBytes + minimumSerializedBytes

      if (minimumPayloadBytes > maxBytes) {
        slot.setText(minimumCandidate.text)
        currentBytes = minimumPayloadBytes
        truncatedToolOutputBytes += minimumCandidate.omittedBytes
        continue
      }

      let low = minimumRetainedBytes
      let high = slot.originalBytes - 1
      let best = minimumCandidate
      while (low <= high) {
        const retainedBytes = Math.floor((low + high) / 2)
        const candidate = truncateText(slot.originalText, retainedBytes)
        const candidatePayloadBytes =
          currentBytes
          - originalSerializedBytes
          + serializedBytes(candidate.text)

        if (candidatePayloadBytes <= maxBytes) {
          best = candidate
          low = retainedBytes + 1
        } else {
          high = retainedBytes - 1
        }
      }

      slot.setText(best.text)
      currentBytes =
        currentBytes - originalSerializedBytes + serializedBytes(best.text)
      truncatedToolOutputBytes += best.omittedBytes
    }
  }

  const finalBytes = serializedBytes(reducedPayload)
  if (finalBytes > maxBytes) {
    throw createPayloadTooLargeError(finalBytes, maxBytes)
  }

  return {
    payload: reducedPayload,
    originalBytes,
    finalBytes,
    omittedBinaryBlocks: counts.omittedBinaryBlocks,
    truncatedToolOutputBytes,
    reduced: true,
  }
}
