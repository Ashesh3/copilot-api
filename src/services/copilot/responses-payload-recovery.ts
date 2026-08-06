import {
  isDataUri,
  isLikelyBase64,
  parseDataUri,
  toDataUri,
} from "~/lib/attachments"
import { LocalHTTPError } from "~/lib/error"

export const CAPI_RESPONSES_MAX_REQUEST_BYTES = 32 * 1024 * 1024
export const RESPONSES_RECOVERY_MARGIN_BYTES = 64 * 1024

export interface ResponsesImageResizeInput {
  dataUri: string
  mediaType: string
  signal?: AbortSignal
  targetDataUriBytes: number
}

export type ResponsesImageResizeResult =
  | { dataUri: string; outcome: "resized" }
  | { outcome: "invalid" | "unshrinkable" }

export type ResponsesImageResizer = (
  input: ResponsesImageResizeInput,
) => Promise<ResponsesImageResizeResult>

interface ResponsesImagePipeline {
  buffer: () => Promise<Buffer>
  jpeg: (options?: { quality?: number }) => ResponsesImagePipeline
  metadata: () => Promise<{ height: number; width: number }>
  png: (options?: { compressionLevel?: number }) => ResponsesImagePipeline
  resize: (
    width: number,
    height: number,
    options: { fit: "inside"; withoutEnlargement: true },
  ) => ResponsesImagePipeline
  webp: (options?: { quality?: number }) => ResponsesImagePipeline
}

export type ResponsesImageFactory = (bytes: Buffer) => ResponsesImagePipeline

export interface ResponsesPayloadRecoveryResult<T> {
  payload: T
  originalBytes: number
  finalBytes: number
  downscaledImages: number
  removedHistoricalBinaries: number
  removedCurrentBinaries: number
  reduced: boolean
}

interface ImageSlot {
  current: boolean
  dataUri: string
  mediaType: string
  replace: () => void
  setDataUri: (dataUri: string) => void
}

interface ImageTraversal {
  current: boolean
  replace: (value: unknown) => void
  slots: Array<ImageSlot>
}

interface ImageRecoveryResult {
  downscaledImages: number
  invalidImageSlots: Array<ImageSlot>
}

interface BinarySlot {
  bytes: number
  current: boolean
  replace: () => void
}

interface BinaryTraversal {
  current: boolean
  replace: (value: unknown) => void
  slots: Array<BinarySlot>
}

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata"
const IMAGE_OMISSION_TEXT =
  "[inline image omitted to fit the CAPI Responses request-size limit]"
const FILE_OMISSION_TEXT =
  "[inline file omitted to fit the CAPI Responses request-size limit]"

const omissionNote = (kind: "file" | "image") => ({
  type: "input_text",
  text: kind === "image" ? IMAGE_OMISSION_TEXT : FILE_OMISSION_TEXT,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8")

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

const itemTurnId = (item: unknown): string | null => {
  if (!isRecord(item)) return null
  const metadata = item.internal_chat_message_metadata_passthrough
  if (!isRecord(metadata)) return null
  return typeof metadata.turn_id === "string" && metadata.turn_id.length > 0 ?
      metadata.turn_id
    : null
}

const requestTurnId = (record: Record<string, unknown>): string | null => {
  const clientMetadata = parseRecord(record.client_metadata)
  const turnMetadata = parseRecord(clientMetadata?.[CODEX_TURN_METADATA_KEY])
  if (typeof turnMetadata?.turn_id === "string" && turnMetadata.turn_id) {
    return turnMetadata.turn_id
  }
  if (!Array.isArray(record.input)) return null
  for (let index = record.input.length - 1; index >= 0; index -= 1) {
    const turnId = itemTurnId(record.input[index])
    if (turnId !== null) return turnId
  }
  return null
}

const fallbackCurrentStart = (input: Array<unknown>): number => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (isRecord(item) && item.role === "user") return index
  }
  return input.length
}

const currentTurnStart = (
  input: Array<unknown>,
  activeTurnId: string | null,
): number => {
  if (activeTurnId !== null) {
    for (const [index, element] of input.entries()) {
      if (itemTurnId(element) === activeTurnId) return index
    }
  }
  return fallbackCurrentStart(input)
}

const collectImageSlots = (value: unknown, traversal: ImageTraversal): void => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectImageSlots(value[index], {
        ...traversal,
        replace(replacement) {
          value[index] = replacement
        },
      })
    }
    return
  }
  if (!isRecord(value)) return

  if (
    (value.type === "input_image" || value.type === "computer_screenshot")
    && typeof value.image_url === "string"
    && isDataUri(value.image_url)
  ) {
    const parsed = parseDataUri(value.image_url)
    traversal.slots.push({
      current: traversal.current,
      dataUri: value.image_url,
      mediaType: parsed?.mediaType ?? "",
      replace: () => traversal.replace(omissionNote("image")),
      setDataUri(dataUri) {
        value.image_url = dataUri
      },
    })
    return
  }

  for (const [key, entry] of Object.entries(value)) {
    collectImageSlots(entry, {
      ...traversal,
      replace(replacement) {
        value[key] = replacement
      },
    })
  }
}

const collectInputImageSlots = (
  record: Record<string, unknown>,
): Array<ImageSlot> => {
  const input: Array<unknown> = Array.isArray(record.input) ? record.input : []
  if (input.length === 0) return []
  const currentStart = currentTurnStart(input, requestTurnId(record))
  const slots: Array<ImageSlot> = []

  for (let index = 0; index < input.length; index += 1) {
    collectImageSlots(input[index], {
      current: index >= currentStart,
      replace(replacement) {
        input[index] = replacement
      },
      slots,
    })
  }
  return slots
}

const containsResponsesAttachment = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => containsResponsesAttachment(entry))
  }
  if (!isRecord(value)) return false
  if (
    value.type === "input_image"
    || value.type === "input_file"
    || value.type === "computer_screenshot"
  ) {
    return true
  }
  return Object.values(value).some((entry) =>
    containsResponsesAttachment(entry),
  )
}

export const hasResponsesAttachment = (
  payload: Record<string, unknown>,
): boolean => containsResponsesAttachment(payload.input)

const SUPPORTED_RESIZE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
])

const isAnimatedImage = (bytes: Buffer, mediaType: string): boolean => {
  if (mediaType === "image/png") return bytes.includes(Buffer.from("acTL"))
  if (mediaType === "image/webp") return bytes.includes(Buffer.from("ANIM"))
  return false
}

const createBunImage: ResponsesImageFactory = (bytes) =>
  new Bun.Image(bytes, { autoOrient: true })

const encodeImage = async (options: {
  bytes: Buffer
  dimensions?: { height: number; width: number }
  imageFactory: ResponsesImageFactory
  mediaType: string
}): Promise<Buffer> => {
  let image = options.imageFactory(options.bytes)
  if (options.dimensions) {
    image = image.resize(options.dimensions.width, options.dimensions.height, {
      fit: "inside",
      withoutEnlargement: true,
    })
  }
  if (options.mediaType === "image/jpeg")
    return await image.jpeg({ quality: 80 }).buffer()
  if (options.mediaType === "image/webp")
    return await image.webp({ quality: 80 }).buffer()
  return await image.png({ compressionLevel: 9 }).buffer()
}

export const resizeResponsesImageWithFactory = async (
  input: ResponsesImageResizeInput,
  imageFactory: ResponsesImageFactory,
): Promise<ResponsesImageResizeResult> => {
  if (!SUPPORTED_RESIZE_MEDIA_TYPES.has(input.mediaType)) {
    return { outcome: "invalid" }
  }
  const parsed = parseDataUri(input.dataUri)
  if (parsed?.mediaType !== input.mediaType) return { outcome: "invalid" }

  try {
    input.signal?.throwIfAborted()
    const bytes = Buffer.from(parsed.data, "base64")
    if (isAnimatedImage(bytes, input.mediaType)) return { outcome: "invalid" }
    const source = imageFactory(bytes)
    const metadata = await source.metadata()
    input.signal?.throwIfAborted()

    let encoded = await encodeImage({
      bytes,
      imageFactory,
      mediaType: input.mediaType,
    })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      input.signal?.throwIfAborted()
      const candidate = toDataUri(input.mediaType, encoded.toString("base64"))
      const candidateBytes = Buffer.byteLength(candidate, "utf8")
      if (candidateBytes <= input.targetDataUriBytes) {
        return { dataUri: candidate, outcome: "resized" }
      }

      const ratio = Math.sqrt(input.targetDataUriBytes / candidateBytes) * 0.9
      const scale = Math.min(0.9, Math.max(0.1, ratio)) ** (attempt + 1)
      const width = Math.max(1, Math.floor(metadata.width * scale))
      const height = Math.max(1, Math.floor(metadata.height * scale))
      encoded = await encodeImage({
        bytes,
        dimensions: { height, width },
        imageFactory,
        mediaType: input.mediaType,
      })
    }
    input.signal?.throwIfAborted()
    const finalCandidate = toDataUri(
      input.mediaType,
      encoded.toString("base64"),
    )
    if (Buffer.byteLength(finalCandidate, "utf8") <= input.targetDataUriBytes) {
      return { dataUri: finalCandidate, outcome: "resized" }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    return { outcome: "invalid" }
  }
  return { outcome: "unshrinkable" }
}

export const resizeResponsesImage: ResponsesImageResizer = (input) =>
  typeof Bun.Image === "function" ?
    resizeResponsesImageWithFactory(input, createBunImage)
  : Promise.resolve({ outcome: "invalid" })

const collectBinarySlots = (
  value: unknown,
  traversal: BinaryTraversal,
): void => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectBinarySlots(value[index], {
        ...traversal,
        replace(replacement) {
          value[index] = replacement
        },
      })
    }
    return
  }
  if (!isRecord(value)) return

  if (
    (value.type === "input_image" || value.type === "computer_screenshot")
    && typeof value.image_url === "string"
    && isDataUri(value.image_url)
  ) {
    traversal.slots.push({
      bytes: Buffer.byteLength(value.image_url, "utf8"),
      current: traversal.current,
      replace: () => traversal.replace(omissionNote("image")),
    })
    return
  }

  if (
    value.type === "input_file"
    && typeof value.file_data === "string"
    && (isDataUri(value.file_data) || isLikelyBase64(value.file_data))
  ) {
    traversal.slots.push({
      bytes: Buffer.byteLength(value.file_data, "utf8"),
      current: traversal.current,
      replace: () => traversal.replace(omissionNote("file")),
    })
    return
  }

  for (const [key, entry] of Object.entries(value)) {
    collectBinarySlots(entry, {
      ...traversal,
      replace(replacement) {
        value[key] = replacement
      },
    })
  }
}

const collectInputBinarySlots = (
  record: Record<string, unknown>,
): Array<BinarySlot> => {
  const input: Array<unknown> = Array.isArray(record.input) ? record.input : []
  if (input.length === 0) return []
  const activeTurnId = requestTurnId(record)
  const currentStart = currentTurnStart(input, activeTurnId)
  const slots: Array<BinarySlot> = []

  for (let index = 0; index < input.length; index += 1) {
    const item: unknown = input[index]
    const current = index >= currentStart
    collectBinarySlots(item, {
      current,
      replace(replacement) {
        input[index] = replacement
      },
      slots,
    })
  }
  return slots
}

const createPayloadTooLargeError = (
  payloadBytes: number,
  maxBytes: number,
  recoveryMarginBytes: number,
) => {
  const clientBody = {
    error: {
      code: "responses_payload_too_large",
      message:
        "Preserved ordinary Responses content exceeds the safe CAPI request-size budget",
      type: "error",
      max_bytes: maxBytes,
      recovery_margin_bytes: recoveryMarginBytes,
      payload_bytes: payloadBytes,
    },
  }
  return new LocalHTTPError(
    "Responses payload exceeds the CAPI request-size budget after binary recovery",
    Response.json(clientBody, { status: 413 }),
    clientBody,
  )
}

const recoverImages = async (options: {
  imageSlots: Array<ImageSlot>
  originalBytes: number
  payloadTargetBytes: number
  resizeImage: ResponsesImageResizer
  signal?: AbortSignal
}): Promise<ImageRecoveryResult> => {
  const totalImageBytes = options.imageSlots.reduce(
    (total, slot) => total + Buffer.byteLength(slot.dataUri, "utf8"),
    0,
  )
  const nonImageBytes = Math.max(0, options.originalBytes - totalImageBytes)
  const imageBudget = Math.max(0, options.payloadTargetBytes - nonImageBytes)
  const targetDataUriBytes =
    options.imageSlots.length > 0 ?
      Math.floor(imageBudget / options.imageSlots.length)
    : 0
  const invalidImageSlots: Array<ImageSlot> = []
  let downscaledImages = 0

  for (const slot of options.imageSlots) {
    options.signal?.throwIfAborted()
    const resized = await options.resizeImage({
      dataUri: slot.dataUri,
      mediaType: slot.mediaType,
      signal: options.signal,
      targetDataUriBytes,
    })
    options.signal?.throwIfAborted()
    if (resized.outcome === "invalid") {
      invalidImageSlots.push(slot)
      continue
    }
    if (
      resized.outcome === "resized"
      && Buffer.byteLength(resized.dataUri, "utf8")
        < Buffer.byteLength(slot.dataUri, "utf8")
    ) {
      slot.setDataUri(resized.dataUri)
      downscaledImages += 1
    }
  }

  return { downscaledImages, invalidImageSlots }
}

export async function recoverResponsesPayload<T extends object>(
  payload: T,
  options: {
    maxBytes?: number
    recoveryMarginBytes?: number
    resizeImage?: ResponsesImageResizer
    signal?: AbortSignal
  } = {},
): Promise<ResponsesPayloadRecoveryResult<T>> {
  const maxBytes = options.maxBytes ?? CAPI_RESPONSES_MAX_REQUEST_BYTES
  const recoveryMarginBytes =
    options.recoveryMarginBytes ?? RESPONSES_RECOVERY_MARGIN_BYTES
  const originalBytes = serializedBytes(payload)
  if (originalBytes < maxBytes) {
    return {
      payload,
      originalBytes,
      finalBytes: originalBytes,
      downscaledImages: 0,
      removedHistoricalBinaries: 0,
      removedCurrentBinaries: 0,
      reduced: false,
    }
  }

  const recoveredPayload = structuredClone(payload)
  const record = recoveredPayload as Record<string, unknown>
  const imageSlots = collectInputImageSlots(record)
  const targetBytes = Math.max(0, maxBytes - recoveryMarginBytes)
  const { downscaledImages, invalidImageSlots } = await recoverImages({
    imageSlots,
    originalBytes,
    payloadTargetBytes: targetBytes,
    resizeImage: options.resizeImage ?? resizeResponsesImage,
    signal: options.signal,
  })

  let removedHistoricalBinaries = 0
  let removedCurrentBinaries = 0
  for (const slot of invalidImageSlots) {
    slot.replace()
    if (slot.current) removedCurrentBinaries += 1
    else removedHistoricalBinaries += 1
  }

  let currentBytes = serializedBytes(recoveredPayload)
  if (currentBytes > targetBytes) {
    const binarySlots = collectInputBinarySlots(record)
    const removeSlots = (current: boolean): void => {
      const candidates = binarySlots
        .filter((slot) => slot.current === current)
        .sort((left, right) => right.bytes - left.bytes)
      for (const slot of candidates) {
        if (currentBytes <= targetBytes) break
        slot.replace()
        if (current) removedCurrentBinaries += 1
        else removedHistoricalBinaries += 1
        currentBytes = serializedBytes(recoveredPayload)
      }
    }
    removeSlots(false)
    removeSlots(true)
  }

  const finalBytes = serializedBytes(recoveredPayload)
  if (finalBytes > targetBytes) {
    throw createPayloadTooLargeError(finalBytes, maxBytes, recoveryMarginBytes)
  }

  return {
    payload: recoveredPayload,
    originalBytes,
    finalBytes,
    downscaledImages,
    removedHistoricalBinaries,
    removedCurrentBinaries,
    reduced: true,
  }
}
