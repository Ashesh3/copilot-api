import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessagesPayload,
  AnthropicTool,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  ContentPart,
} from "~/services/copilot/create-chat-completions"

import {
  fetchUrlAsDataUri,
  isPdfMediaType,
  parseDataUri,
} from "~/lib/attachments"
import { createEndpointTranslationError } from "~/lib/error"

const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

export async function convertOpenAIContentPartToAnthropic(
  part: ContentPart | AnthropicDocumentBlock,
  signal?: AbortSignal,
): Promise<Array<AnthropicUserContentBlock>> {
  switch (part.type) {
    case "text": {
      return [{ type: "text", text: part.text }]
    }
    case "image_url": {
      return [await convertImagePart(part.image_url.url, signal)]
    }
    case "file": {
      return [convertFilePart(part)]
    }
    case "document": {
      return [part]
    }
    default: {
      throw createEndpointTranslationError({
        blockers: ["message_content_part"],
        code: "endpoint_translation_unsupported",
        source: "chat",
      })
    }
  }
}

async function convertImagePart(
  url: string,
  signal?: AbortSignal,
): Promise<AnthropicImageBlock> {
  let parsed = parseDataUri(url)
  if (!parsed) {
    parsed = await fetchUrlAsDataUri(url, { signal })
  }

  if (parsed && ANTHROPIC_IMAGE_MEDIA_TYPES.has(parsed.mediaType)) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: parsed.data,
      },
    }
  }

  throwUnsupportedContentPart()
}

function convertFilePart(
  part: ContentPart & { type: "file" },
): AnthropicDocumentBlock {
  const parsed = part.file.file_data ? parseDataUri(part.file.file_data) : null

  if (parsed && isPdfMediaType(parsed.mediaType)) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: parsed.data,
      },
      ...(part.file.filename ? { title: part.file.filename } : {}),
    }
  }

  throwUnsupportedContentPart()
}

function throwUnsupportedContentPart(): never {
  throw createEndpointTranslationError({
    blockers: ["message_content_part"],
    code: "endpoint_translation_unsupported",
    source: "chat",
  })
}

export function convertOpenAIToolsToAnthropic(
  tools: ChatCompletionsPayload["tools"],
): Pick<AnthropicMessagesPayload, "tools"> {
  if (!tools || tools.length === 0) return {}
  const converted: Array<AnthropicTool> = (tools as Array<unknown>).map(
    (tool) => {
      const candidate = tool as {
        function?: {
          description?: unknown
          name?: unknown
          parameters?: unknown
        }
        type?: unknown
      }
      if (
        candidate.type !== "function"
        || !candidate.function
        || typeof candidate.function.name !== "string"
        || candidate.function.name.trim().length === 0
        || !candidate.function.parameters
        || typeof candidate.function.parameters !== "object"
        || Array.isArray(candidate.function.parameters)
      ) {
        throw createEndpointTranslationError({
          blockers: ["tool_semantics"],
          code: "endpoint_translation_unsupported",
          source: "chat",
        })
      }
      return {
        name: candidate.function.name,
        ...((
          typeof candidate.function.description === "string"
          && candidate.function.description
        ) ?
          { description: candidate.function.description }
        : {}),
        input_schema: candidate.function.parameters as Record<string, unknown>,
      }
    },
  )
  return { tools: converted }
}
