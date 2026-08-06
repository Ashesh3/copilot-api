import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { isDataUri, isLikelyBase64 } from "~/lib/attachments"
import { LocalHTTPError } from "~/lib/error"

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
  hasLoneSurrogate: boolean
  originalText: string
  originalBytes: number
  setText: (text: string) => void
}

interface TruncatedText {
  text: string
  omittedBytes: number
}

interface CompactionPayloadStrategy {
  collectToolOutputSlots: (
    payload: Record<string, unknown>,
    slots: Array<TextSlot>,
  ) => void
  elideInlineAttachments: (
    payload: Record<string, unknown>,
    counts: ReductionCounts,
  ) => void
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

  if (
    (value.type === "input_image" || value.type === "computer_screenshot")
    && isInlineData(value.image_url)
  ) {
    counts.omittedBinaryBlocks += 1
    return omissionNote("image")
  }
  if (
    value.type === "input_file"
    && typeof value.file_data === "string"
    && (isDataUri(value.file_data) || isLikelyBase64(value.file_data))
  ) {
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
    hasLoneSurrogate: containsLoneSurrogate(originalText),
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

const elideChatContentPart = (
  value: unknown,
  counts: ReductionCounts,
): unknown => {
  if (!isRecord(value)) return value

  if (
    value.type === "image_url"
    && isRecord(value.image_url)
    && isInlineData(value.image_url.url)
  ) {
    counts.omittedBinaryBlocks += 1
    return { type: "text", text: omissionNote("image").text }
  }
  if (
    value.type === "file"
    && isRecord(value.file)
    && typeof value.file.file_data === "string"
  ) {
    counts.omittedBinaryBlocks += 1
    return { type: "text", text: omissionNote("file").text }
  }

  return value
}

const elideChatAttachments = (
  payload: Record<string, unknown>,
  counts: ReductionCounts,
): void => {
  if (!Array.isArray(payload.messages)) return

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    message.content = message.content.map((part) =>
      elideChatContentPart(part, counts),
    )
  }
}

const collectChatToolOutputSlots = (
  payload: Record<string, unknown>,
  slots: Array<TextSlot>,
): void => {
  if (!Array.isArray(payload.messages)) return

  for (const message of payload.messages) {
    if (!isRecord(message)) continue
    const isToolMessage = message.role === "tool"
    const isCompactionToolResult =
      message.role === "user"
      && typeof message.content === "string"
      && (message.content.startsWith("[Custom tool result ")
        || message.content.startsWith("[Tool result "))
    if (!isToolMessage && !isCompactionToolResult) continue
    collectOutputTextSlots(
      message.content,
      (content) => {
        message.content = content
      },
      slots,
    )
  }
}

const containsLoneSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const current = text.codePointAt(index) ?? 0
    if (current < 0xd800 || current > 0xdfff) {
      if (current > 0xffff) index += 1
      continue
    }
    return true
  }
  return false
}

const sourcePrefixAtLeast = (text: string, minimumBytes: number): string => {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle), "utf8") < minimumBytes) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  let end = low
  if ((text.codePointAt(Math.max(0, end - 1)) ?? 0) > 0xffff) end += 1
  return text.slice(0, end)
}

const sourceSuffixAtLeast = (text: string, minimumBytes: number): string => {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(middle), "utf8") >= minimumBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  let start = low
  if ((text.codePointAt(Math.max(0, start - 1)) ?? 0) > 0xffff) start -= 1
  return text.slice(start)
}

const decodePrefixAtLeast = (buffer: Buffer, minimumBytes: number): string => {
  const decoder = new TextDecoder(undefined, { fatal: true })
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
  const decoder = new TextDecoder(undefined, { fatal: true })
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

const truncateText = (
  text: string,
  retainedBytes: number,
  hasLoneSurrogate: boolean,
): TruncatedText => {
  const buffer = Buffer.from(text, "utf8")
  if (retainedBytes >= buffer.length) {
    return { text, omittedBytes: 0 }
  }

  const prefixTarget = Math.ceil(retainedBytes / 2)
  const suffixTarget = Math.floor(retainedBytes / 2)
  const prefix =
    hasLoneSurrogate ?
      sourcePrefixAtLeast(text, prefixTarget)
    : decodePrefixAtLeast(buffer, prefixTarget)
  const suffix =
    hasLoneSurrogate ?
      sourceSuffixAtLeast(text, suffixTarget)
    : decodeSuffixAtLeast(buffer, suffixTarget)
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

const createPayloadTooLargeError = (bytes: number, maxBytes: number) => {
  const clientBody = {
    error: {
      code: "compaction_payload_too_large",
      message:
        "Preserved conversation content exceeds the safe compaction payload budget",
      type: "error",
      max_bytes: maxBytes,
      payload_bytes: bytes,
    },
  }
  return new LocalHTTPError(
    "Compaction payload exceeds the safe upstream budget because preserved conversation content is too large",
    Response.json(clientBody, { status: 413 }),
    clientBody,
  )
}

const fitCompactionPayload = <T extends object>(
  payload: T,
  maxBytes: number,
  strategy: CompactionPayloadStrategy,
): CompactionPayloadFitResult<T> => {
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
  const reducedRecord = reducedPayload as Record<string, unknown>
  const counts: ReductionCounts = { omittedBinaryBlocks: 0 }
  strategy.elideInlineAttachments(reducedRecord, counts)

  let currentBytes = serializedBytes(reducedPayload)
  let truncatedToolOutputBytes = 0
  if (currentBytes > maxBytes) {
    const slots: Array<TextSlot> = []
    strategy.collectToolOutputSlots(reducedRecord, slots)
    slots.sort((left, right) => right.originalBytes - left.originalBytes)

    for (const slot of slots) {
      if (currentBytes <= maxBytes) break
      if (slot.originalBytes <= MINIMUM_RETAINED_EDGE_BYTES * 2) continue

      const originalSerializedBytes = serializedBytes(slot.originalText)
      const minimumRetainedBytes = MINIMUM_RETAINED_EDGE_BYTES * 2
      const minimumCandidate = truncateText(
        slot.originalText,
        minimumRetainedBytes,
        slot.hasLoneSurrogate,
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
        const candidate = truncateText(
          slot.originalText,
          retainedBytes,
          slot.hasLoneSurrogate,
        )
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

export function fitResponsesCompactionPayload<T extends object>(
  payload: T,
  maxBytes = COMPACTION_PAYLOAD_MAX_BYTES,
): CompactionPayloadFitResult<T> {
  return fitCompactionPayload(payload, maxBytes, {
    elideInlineAttachments(record, counts) {
      if ("input" in record) {
        record.input = elideInlineAttachments(record.input, counts)
      }
    },
    collectToolOutputSlots(record, slots) {
      collectToolOutputSlots(record.input, slots)
    },
  })
}

export function fitChatCompletionsCompactionPayload<T extends object>(
  payload: T,
  maxBytes = COMPACTION_PAYLOAD_MAX_BYTES,
): CompactionPayloadFitResult<T> {
  return fitCompactionPayload(payload, maxBytes, {
    elideInlineAttachments: elideChatAttachments,
    collectToolOutputSlots: collectChatToolOutputSlots,
  })
}

const elideAnthropicAttachments = (
  payload: Record<string, unknown>,
  counts: ReductionCounts,
): void => {
  if ("messages" in payload) {
    payload.messages = elideAnthropicValue(payload.messages, counts)
  }
}

const elideAnthropicValue = (
  value: unknown,
  counts: ReductionCounts,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => elideAnthropicValue(entry, counts))
  }
  if (!isRecord(value)) return value

  if (
    (value.type === "image" || value.type === "document")
    && isRecord(value.source)
    && value.source.type === "base64"
    && typeof value.source.data === "string"
  ) {
    counts.omittedBinaryBlocks += 1
    return {
      type: "text",
      text: omissionNote(value.type === "image" ? "image" : "file").text,
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      elideAnthropicValue(entry, counts),
    ]),
  )
}

const collectAnthropicToolOutputSlots = (
  value: unknown,
  slots: Array<TextSlot>,
): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collectAnthropicToolOutputSlots(entry, slots)
    return
  }
  if (!isRecord(value)) return

  if (value.type === "tool_result") {
    collectOutputTextSlots(
      value.content,
      (content) => {
        value.content = content
      },
      slots,
    )
    return
  }

  for (const entry of Object.values(value)) {
    collectAnthropicToolOutputSlots(entry, slots)
  }
}

export function fitAnthropicCompactionPayload<T extends object>(
  payload: T,
  maxBytes = COMPACTION_PAYLOAD_MAX_BYTES,
): CompactionPayloadFitResult<T> {
  return fitCompactionPayload(payload, maxBytes, {
    elideInlineAttachments: elideAnthropicAttachments,
    collectToolOutputSlots(record, slots) {
      collectAnthropicToolOutputSlots(record.messages, slots)
    },
  })
}
