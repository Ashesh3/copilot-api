import {
  attachmentOmittedNote,
  fetchUrlAsDataUri,
  isDataUri,
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
  options?: { failClosed?: boolean },
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
  if (!fileUrl) return part

  const inlined = await fetchUrlAsDataUri(fileUrl, {
    expectPdf: true,
    signal,
  })
  if (inlined) {
    return stripFileUrl({
      ...part,
      filename:
        part.filename
        ?? (() => {
          try {
            return new URL(fileUrl).pathname.split("/").pop() ?? null
          } catch {
            return null
          }
        })(),
      file_data: toDataUri(inlined.mediaType, inlined.data),
    })
  }
  return options?.failClosed ? part : (
      {
        type: "input_text",
        text: attachmentOmittedNote({
          kind: "file",
          name: part.filename,
          reason: "the URL could not be fetched by the proxy",
        }),
      }
    )
}

async function normalizeContentPart(
  part: ResponseInputContent,
  options: {
    failClosed?: boolean
    resizeImage: ResponsesImageResizer
    signal?: AbortSignal
  },
): Promise<ResponseInputContent> {
  const { failClosed, resizeImage, signal } = options
  if (
    isInputImage(part)
    && part.image_url
    && !part.image_url.startsWith("data:")
  ) {
    const inlined = await fetchUrlAsDataUri(part.image_url, { signal })
    if (inlined) {
      return await normalizeContentPart(
        { ...part, image_url: toDataUri(inlined.mediaType, inlined.data) },
        options,
      )
    }
    return failClosed ? part : (
        {
          type: "input_text",
          text: attachmentOmittedNote({
            kind: "image",
            reason: "the URL could not be fetched by the proxy",
          }),
        }
      )
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
    if (failClosed) return part
    return {
      type: "input_text",
      text: attachmentOmittedNote({
        kind: "image",
        reason: "WebP could not be converted to a Copilot-compatible format",
      }),
    }
  }
  if (isInputFile(part)) {
    return await normalizeInputFile(part, signal, { failClosed })
  }
  return part
}

async function normalizeContentArray(
  content: Array<ResponseInputContent>,
  options: {
    failClosed?: boolean
    resizeImage: ResponsesImageResizer
    signal?: AbortSignal
  },
): Promise<Array<ResponseInputContent>> {
  const normalized: Array<ResponseInputContent> = []
  for (const part of content) {
    normalized.push(await normalizeContentPart(part, options))
  }
  return normalized
}

export async function normalizeResponsesAttachments(
  payload: Pick<ResponsesPayload, "input"> & Record<string, unknown>,
  signal?: AbortSignal,
  resizeImage: ResponsesImageResizer = resizeResponsesImage,
): Promise<void> {
  await normalizeResponsesAttachmentsWithOptions(payload, {
    resizeImage,
    signal,
  })
}

export async function normalizeResponsesAttachmentsFailClosed(
  payload: Pick<ResponsesPayload, "input"> & Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  await normalizeResponsesAttachmentsWithOptions(payload, {
    failClosed: true,
    resizeImage: resizeResponsesImage,
    signal,
  })
}

async function normalizeResponsesAttachmentsWithOptions(
  payload: Pick<ResponsesPayload, "input"> & Record<string, unknown>,
  options: {
    failClosed?: boolean
    resizeImage: ResponsesImageResizer
    signal?: AbortSignal
  },
): Promise<void> {
  const { failClosed = false, resizeImage, signal } = options
  if (!Array.isArray(payload.input)) return

  const normalizedInput: Array<ResponseInputItem> = []
  for (const item of payload.input) {
    if (isInputImage(item) || isInputFile(item)) {
      normalizedInput.push(
        (await normalizeContentPart(item, {
          failClosed,
          resizeImage,
          signal,
        })) as ResponseInputItem,
      )
      continue
    }
    if (isRecord(item) && Array.isArray(item.content)) {
      normalizedInput.push({
        ...item,
        content: await normalizeContentArray(
          item.content as Array<ResponseInputContent>,
          { failClosed, resizeImage, signal },
        ),
      })
      continue
    }
    if (isRecord(item) && Array.isArray(item.output)) {
      normalizedInput.push({
        ...item,
        output: await normalizeContentArray(
          item.output as Array<ResponseInputContent>,
          { failClosed, resizeImage, signal },
        ),
      })
      continue
    }
    if (isRecord(item) && isInputImage(item.output)) {
      normalizedInput.push({
        ...item,
        output: await normalizeContentPart(item.output, {
          failClosed,
          resizeImage,
          signal,
        }),
      })
      continue
    }
    normalizedInput.push(item)
  }
  payload.input = normalizedInput
}
