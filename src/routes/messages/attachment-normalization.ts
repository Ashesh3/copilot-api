import consola from "consola"

import {
  attachmentOmittedNote,
  fetchUrlAsDataUri,
  isImageMediaType,
  isPdfMediaType,
  isSafeExternalHttpUrl,
} from "~/lib/attachments"

import {
  type AnthropicDocumentBlock,
  type AnthropicImageBlock,
  type AnthropicInlineContentBlock,
  type AnthropicMessagesPayload,
  type AnthropicTextBlock,
  type AnthropicToolReferenceBlock,
  type AnthropicToolResultBlock,
  type AnthropicUnknownContentBlock,
  type AnthropicUserContentBlock,
  isAnthropicDocumentBlock,
  isAnthropicImageBlock,
  isAnthropicToolReferenceBlock,
  isAnthropicToolResultBlock,
  isAnthropicUserMessage,
} from "./anthropic-types"

/**
 * Normalize Anthropic attachment blocks before endpoint routing so the rest
 * of the pipeline only ever sees:
 *   - base64 image blocks
 *   - base64 application/pdf document blocks
 *   - text blocks
 *
 * Upstream Copilot rejects url image/document sources ("external image URLs
 * are not supported") and text document sources, so the proxy fetches URLs
 * and inlines text documents here. Runs on user messages and inside
 * tool_result content arrays.
 */
export async function normalizeAnthropicAttachments(
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
): Promise<void> {
  for (const message of payload.messages) {
    if (!isAnthropicUserMessage(message) || !Array.isArray(message.content)) {
      continue
    }

    const normalized: Array<AnthropicUserContentBlock> = []
    for (const block of message.content) {
      if (isAnthropicToolResultBlock(block) && Array.isArray(block.content)) {
        const inner = await normalizeToolResultContent(block.content, signal)
        normalized.push({ ...block, content: inner })
        continue
      }
      if (isAnthropicToolResultBlock(block)) {
        normalized.push(block)
        continue
      }

      normalized.push(...(await normalizeBlock(block, signal)))
    }
    message.content = normalized
  }
}

/** Inline only image URL blocks, preserving document blocks verbatim. */
export async function normalizeAnthropicImages(
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
): Promise<void> {
  for (const message of payload.messages) {
    if (!isAnthropicUserMessage(message) || !Array.isArray(message.content)) {
      continue
    }

    const normalized: Array<AnthropicUserContentBlock> = []
    for (const block of message.content) {
      if (isAnthropicImageBlock(block)) {
        normalized.push(await normalizeImageBlock(block, signal))
        continue
      }
      if (isAnthropicToolResultBlock(block) && Array.isArray(block.content)) {
        normalized.push({
          ...block,
          content: await normalizeToolResultImages(block.content, signal),
        })
        continue
      }
      if (isAnthropicToolResultBlock(block)) {
        normalized.push(block)
        continue
      }
      normalized.push(block)
    }
    message.content = normalized
  }
}

async function normalizeToolResultImages(
  content: Exclude<AnthropicToolResultBlock["content"], string>,
  signal?: AbortSignal,
): Promise<Exclude<AnthropicToolResultBlock["content"], string>> {
  const normalized: Exclude<AnthropicToolResultBlock["content"], string> = []
  for (const block of content) {
    normalized.push(
      isAnthropicImageBlock(block) ?
        await normalizeImageBlock(block, signal)
      : block,
    )
  }
  return normalized
}

type NormalizableBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicUnknownContentBlock

async function normalizeToolResultContent(
  content: Exclude<AnthropicToolResultBlock["content"], string>,
  signal?: AbortSignal,
): Promise<
  Array<
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicDocumentBlock
    | AnthropicUnknownContentBlock
    | AnthropicToolReferenceBlock
  >
> {
  const normalized: Array<
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicDocumentBlock
    | AnthropicUnknownContentBlock
    | AnthropicToolReferenceBlock
  > = []
  for (const block of content) {
    if (isAnthropicToolReferenceBlock(block)) {
      normalized.push(block)
      continue
    }
    normalized.push(...(await normalizeBlock(block, signal)))
  }
  return normalized
}

async function normalizeBlock(
  block: AnthropicInlineContentBlock,
  signal?: AbortSignal,
): Promise<Array<NormalizableBlock>> {
  if (isAnthropicImageBlock(block)) {
    return [await normalizeImageBlock(block, signal)]
  }
  if (isAnthropicDocumentBlock(block)) {
    return await normalizeDocumentBlock(block, signal)
  }
  return [block]
}

async function normalizeImageBlock(
  block: AnthropicImageBlock,
  signal?: AbortSignal,
): Promise<AnthropicImageBlock | AnthropicTextBlock> {
  if (block.source.type !== "url") return block

  const inlined = await fetchUrlAsDataUri(block.source.url, { signal })
  if (inlined && isImageMediaType(inlined.mediaType)) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: inlined.mediaType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: inlined.data,
      },
    }
  }

  consola.warn("Could not inline remote image attachment")
  return {
    type: "text",
    text: attachmentOmittedNote({
      kind: "image",
      name: block.source.url,
      reason: "the URL could not be fetched by the proxy",
    }),
  }
}

async function normalizeDocumentBlock(
  block: AnthropicDocumentBlock,
  signal?: AbortSignal,
): Promise<Array<NormalizableBlock>> {
  const source = block.source

  switch (source.type) {
    case "base64": {
      if (isPdfMediaType(source.media_type)) {
        return [block]
      }
      // Non-PDF base64 documents (e.g. text encoded as base64) — decode to
      // text when possible, since upstream only accepts application/pdf.
      const decoded = tryDecodeBase64Text(source.data)
      if (decoded !== null) {
        return [wrapDocumentText(block, decoded)]
      }
      return [
        omittedDocumentNote(
          block,
          `media type ${source.media_type} is not supported upstream`,
        ),
      ]
    }

    case "text": {
      return [wrapDocumentText(block, source.data)]
    }

    case "url": {
      return await normalizeUrlDocument(block, source.url, signal)
    }

    case "content": {
      const blocks: Array<NormalizableBlock> = []
      const texts: Array<string> = []
      const content = source.content
      if (typeof content === "string") {
        texts.push(content)
      } else {
        for (const inner of content) {
          if (inner.type === "text") {
            texts.push(inner.text)
          } else {
            blocks.push(await normalizeImageBlock(inner, signal))
          }
        }
      }
      if (texts.length > 0) {
        blocks.unshift(wrapDocumentText(block, texts.join("\n\n")))
      }
      return blocks
    }

    default: {
      return [block]
    }
  }
}

async function normalizeUrlDocument(
  block: AnthropicDocumentBlock,
  url: string,
  signal?: AbortSignal,
): Promise<Array<NormalizableBlock>> {
  if (!isSafeExternalHttpUrl(url)) {
    return [
      omittedDocumentNote(block, "the URL is unavailable for proxy recovery"),
    ]
  }

  const inlined = await fetchUrlAsDataUri(url, { expectPdf: true, signal })

  if (inlined && isPdfMediaType(inlined.mediaType)) {
    return [
      {
        ...block,
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: inlined.data,
        },
      },
    ]
  }

  if (inlined && isImageMediaType(inlined.mediaType)) {
    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: inlined.mediaType as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp",
          data: inlined.data,
        },
      },
    ]
  }

  const decodedText =
    inlined && inlined.mediaType.startsWith("text/") ?
      tryDecodeBase64Text(inlined.data)
    : null
  if (decodedText !== null) {
    return [wrapDocumentText(block, decodedText)]
  }

  consola.warn("Could not inline remote document attachment")
  return [
    omittedDocumentNote(
      block,
      "the URL could not be fetched by the proxy",
      url,
    ),
  ]
}

function wrapDocumentText(
  block: AnthropicDocumentBlock,
  text: string,
): AnthropicTextBlock {
  const title = block.title ? ` title=${JSON.stringify(block.title)}` : ""
  const context = block.context ? `\n${block.context}` : ""
  return {
    type: "text",
    text: `<document${title}>${context}\n${text}\n</document>`,
  }
}

function omittedDocumentNote(
  block: AnthropicDocumentBlock,
  reason: string,
  fallbackName?: string,
): AnthropicTextBlock {
  return {
    type: "text",
    text: attachmentOmittedNote({
      kind: "file",
      name: block.title ?? fallbackName,
      reason,
    }),
  }
}

function tryDecodeBase64Text(data: string): string | null {
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8")
    if (decoded.length === 0 || decoded.includes("�")) return null
    return decoded
  } catch {
    return null
  }
}

/** True when any base64 PDF document block remains after normalization. */
export function payloadHasPdfDocuments(
  payload: AnthropicMessagesPayload,
): boolean {
  for (const message of payload.messages) {
    if (!isAnthropicUserMessage(message) || !Array.isArray(message.content)) {
      continue
    }
    for (const block of message.content) {
      if (isPdfDocumentBlock(block)) return true
      if (
        isAnthropicToolResultBlock(block)
        && Array.isArray(block.content)
        && block.content.some((inner) => isPdfDocumentBlock(inner))
      ) {
        return true
      }
    }
  }
  return false
}

function isPdfDocumentBlock(block: { type: string }): boolean {
  if (block.type !== "document") return false
  const source = (block as AnthropicDocumentBlock).source
  return source.type === "base64" && isPdfMediaType(source.media_type)
}
