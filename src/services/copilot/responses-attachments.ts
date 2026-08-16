import {
  attachmentOmittedNote,
  fetchUrlAsDataUri,
  isDataUri,
  isHttpUrl,
  isLikelyBase64,
  mediaTypeFromFilename,
  toDataUri,
} from "~/lib/attachments"

import type {
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputImage,
  ResponseInputItem,
  ResponsesPayload,
} from "./create-responses"

import {
  resizeResponsesImage,
  type ResponsesImageResizer,
} from "./responses-payload-recovery"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
const isInputImage = (value: unknown): value is ResponseInputImage =>
  isRecord(value)
  && (value.type === "input_image" || value.type === "computer_screenshot")
const isInputFile = (value: unknown): value is ResponseInputFile =>
  isRecord(value) && value.type === "input_file"

function stripFileUrl(part: ResponseInputFile): ResponseInputFile {
  if (part.file_url === undefined || part.file_url === null) return part
  const { file_url: _fileUrl, ...rest } = part
  return rest
}

async function normalizeInputFile(
  part: ResponseInputFile,
  signal?: AbortSignal,
): Promise<ResponseInputContent> {
  const { file_url: fileUrl, file_data: fileData } = part
  if (fileData) {
    if (isDataUri(fileData)) return stripFileUrl(part)
    if (isLikelyBase64(fileData)) {
      return stripFileUrl({
        ...part,
        file_data: toDataUri(
          mediaTypeFromFilename(part.filename) ?? "application/pdf",
          fileData,
        ),
      })
    }
    return stripFileUrl(part)
  }
  if (!fileUrl || !isHttpUrl(fileUrl)) return part

  const inlined = await fetchUrlAsDataUri(fileUrl, {
    expectPdf: true,
    signal,
  })
  if (inlined) {
    return stripFileUrl({
      ...part,
      filename:
        part.filename ?? new URL(fileUrl).pathname.split("/").pop() ?? null,
      file_data: toDataUri(inlined.mediaType, inlined.data),
    })
  }
  return {
    type: "input_text",
    text: attachmentOmittedNote({
      kind: "file",
      name: part.filename ?? fileUrl,
      reason: "the URL could not be fetched by the proxy",
    }),
  }
}

async function normalizeContentPart(
  part: ResponseInputContent,
  signal: AbortSignal | undefined,
  resizeImage: ResponsesImageResizer,
): Promise<ResponseInputContent> {
  if (isInputImage(part) && part.image_url && isHttpUrl(part.image_url)) {
    const inlined = await fetchUrlAsDataUri(part.image_url, { signal })
    if (inlined) {
      return await normalizeContentPart(
        { ...part, image_url: toDataUri(inlined.mediaType, inlined.data) },
        signal,
        resizeImage,
      )
    }
    return {
      type: "input_text",
      text: attachmentOmittedNote({
        kind: "image",
        name: part.image_url,
        reason: "the URL could not be fetched by the proxy",
      }),
    }
  }
  if (isInputImage(part) && part.image_url?.startsWith("data:image/webp;")) {
    const normalized = await resizeImage({
      dataUri: part.image_url,
      mediaType: "image/webp",
      signal,
      targetDataUriBytes: Number.MAX_SAFE_INTEGER,
    })
    if (normalized.outcome === "resized") {
      return { ...part, image_url: normalized.dataUri }
    }
    return {
      type: "input_text",
      text: attachmentOmittedNote({
        kind: "image",
        reason: "WebP could not be converted to a Copilot-compatible format",
      }),
    }
  }
  if (isInputFile(part)) return await normalizeInputFile(part, signal)
  return part
}

async function normalizeContentArray(
  content: Array<ResponseInputContent>,
  signal: AbortSignal | undefined,
  resizeImage: ResponsesImageResizer,
): Promise<Array<ResponseInputContent>> {
  const normalized: Array<ResponseInputContent> = []
  for (const part of content) {
    normalized.push(await normalizeContentPart(part, signal, resizeImage))
  }
  return normalized
}

export async function normalizeResponsesAttachments(
  payload: ResponsesPayload,
  signal?: AbortSignal,
  resizeImage: ResponsesImageResizer = resizeResponsesImage,
): Promise<void> {
  if (!Array.isArray(payload.input)) return

  const normalizedInput: Array<ResponseInputItem> = []
  for (const item of payload.input) {
    if (isInputImage(item) || isInputFile(item)) {
      normalizedInput.push(
        (await normalizeContentPart(
          item,
          signal,
          resizeImage,
        )) as ResponseInputItem,
      )
      continue
    }
    if (isRecord(item) && Array.isArray(item.content)) {
      normalizedInput.push({
        ...item,
        content: await normalizeContentArray(
          item.content as Array<ResponseInputContent>,
          signal,
          resizeImage,
        ),
      })
      continue
    }
    if (isRecord(item) && Array.isArray(item.output)) {
      normalizedInput.push({
        ...item,
        output: await normalizeContentArray(
          item.output as Array<ResponseInputContent>,
          signal,
          resizeImage,
        ),
      })
      continue
    }
    if (isRecord(item) && isInputImage(item.output)) {
      normalizedInput.push({
        ...item,
        output: await normalizeContentPart(item.output, signal, resizeImage),
      })
      continue
    }
    normalizedInput.push(item)
  }
  payload.input = normalizedInput
}
