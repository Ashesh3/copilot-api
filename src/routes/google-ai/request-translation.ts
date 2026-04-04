/**
 * Translate Google Generative AI request format → OpenAI ChatCompletions format.
 * This allows Copilot's ChatCompletions API to handle Google-format requests.
 */

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import type {
  GoogleAIRequest,
  GoogleContent,
  GoogleFileDataPart,
  GoogleFunctionCallPart,
  GoogleFunctionResponsePart,
  GoogleInlineDataPart,
  GooglePart,
  GoogleTextPart,
} from "./google-ai-types"

let toolCallCounter = 0

function nextToolCallId(): string {
  return `call_${Date.now()}_${toolCallCounter++}`
}

function isTextPart(part: GooglePart): part is GoogleTextPart {
  return "text" in part
}

function isFunctionCallPart(part: GooglePart): part is GoogleFunctionCallPart {
  return "functionCall" in part
}

function isFunctionResponsePart(
  part: GooglePart,
): part is GoogleFunctionResponsePart {
  return "functionResponse" in part
}

function isInlineDataPart(part: GooglePart): part is GoogleInlineDataPart {
  return "inlineData" in part
}

function isFileDataPart(part: GooglePart): part is GoogleFileDataPart {
  return "fileData" in part
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/")
}

function isSupportedImageUri(uri: string): boolean {
  return (
    uri.startsWith("https://")
    || uri.startsWith("http://")
    || uri.startsWith("data:")
  )
}

function flattenContentParts(
  contentParts: Array<ContentPart>,
): string | Array<ContentPart> | null {
  if (contentParts.length === 0) {
    return null
  }

  if (contentParts.every((part) => part.type === "text")) {
    return (contentParts as Array<{ type: "text"; text: string }>)
      .map((part) => part.text)
      .join("")
  }

  return contentParts
}

function translateContentParts(
  parts: Array<GooglePart>,
  options?: { includeThoughtText?: boolean },
): string | Array<ContentPart> | null {
  const includeThoughtText = options?.includeThoughtText ?? false
  const contentParts: Array<ContentPart> = []

  for (const part of parts) {
    if (isTextPart(part)) {
      if (part.thought && !includeThoughtText) {
        continue
      }
      contentParts.push({ type: "text", text: part.text })
      continue
    }

    if (isInlineDataPart(part)) {
      if (isImageMimeType(part.inlineData.mimeType)) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          },
        })
      } else {
        contentParts.push({
          type: "text",
          text: `[inlineData:${part.inlineData.mimeType}]`,
        })
      }
      continue
    }

    if (isFileDataPart(part)) {
      const uri = part.fileData.fileUri
      if (isImageMimeType(part.fileData.mimeType) && isSupportedImageUri(uri)) {
        contentParts.push({
          type: "image_url",
          image_url: { url: uri },
        })
      } else {
        contentParts.push({
          type: "text",
          text: `[fileData:${part.fileData.mimeType}] ${uri}`,
        })
      }
      continue
    }
  }

  return flattenContentParts(contentParts)
}

/**
 * Convert Google contents array → OpenAI messages array.
 */
function translateContents(contents: Array<GoogleContent>): Array<Message> {
  const messages: Array<Message> = []

  for (const content of contents) {
    if (content.role === "user") {
      // Check if this content has function responses (tool results)
      const functionResponses = content.parts.filter((p) =>
        isFunctionResponsePart(p),
      )
      const otherParts = content.parts.filter((p) => !isFunctionResponsePart(p))

      // Emit tool result messages first
      for (const part of functionResponses) {
        messages.push({
          role: "tool",
          tool_call_id: findToolCallId(messages, part.functionResponse.name),
          content: JSON.stringify(part.functionResponse.response),
        })
      }

      // Emit regular user message if there are non-tool parts
      if (otherParts.length > 0) {
        const content = translateContentParts(otherParts)
        if (content) {
          messages.push({ role: "user", content })
        }
      }
    } else {
      // Model messages may contain text and/or function calls
      const functionCalls = content.parts.filter((p) => isFunctionCallPart(p))

      const modelContent = translateContentParts(content.parts)

      const toolCalls =
        functionCalls.length > 0 ?
          functionCalls.map((part) => ({
            id: nextToolCallId(),
            type: "function" as const,
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          }))
        : undefined

      messages.push({
        role: "assistant",
        content: modelContent,
        tool_calls: toolCalls,
      })
    }
  }

  return messages
}

/**
 * Find the tool_call_id for a function response by walking back through messages
 * to find the matching assistant tool_call by function name.
 */
function findToolCallId(
  messages: Array<Message>,
  functionName: string,
): string {
  // Walk backwards to find the most recent assistant message with a matching tool call
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.tool_calls) {
      const match = msg.tool_calls.find(
        (tc) => tc.function.name === functionName,
      )
      if (match) return match.id
    }
  }
  // Fallback: generate a new ID if no match found
  return nextToolCallId()
}

/**
 * Convert Google tools → OpenAI tools format.
 */
function translateTools(
  tools: GoogleAIRequest["tools"],
  allowedFunctionNames?: ReadonlySet<string>,
): Array<Tool> | undefined {
  if (!tools || tools.length === 0) return undefined

  const openAITools: Array<Tool> = []

  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const decl of tool.functionDeclarations) {
        if (
          allowedFunctionNames
          && allowedFunctionNames.size > 0
          && !allowedFunctionNames.has(decl.name)
        ) {
          continue
        }
        openAITools.push({
          type: "function",
          function: {
            name: decl.name,
            description: decl.description,
            parameters: normalizeToolParameters(decl.parameters ?? {}),
          },
        })
      }
    }
    // googleSearch and codeExecution tools are not translatable to OpenAI format
  }

  return openAITools.length > 0 ? openAITools : undefined
}

/**
 * Remove $schema from tool parameters and ensure valid structure.
 * Copilot requires parameters to have at least { type: "object", properties: {} }.
 */
function normalizeToolParameters(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...params }
  delete cleaned.$schema
  // Ensure minimum valid schema — Copilot rejects empty {} or {type:"object"} without properties
  if (!cleaned.type) {
    cleaned.type = "object"
  }
  if (!cleaned.properties) {
    cleaned.properties = {}
  }
  return cleaned
}

/**
 * Convert Google toolConfig → OpenAI tool_choice.
 */
function translateToolChoice(
  toolConfig: GoogleAIRequest["toolConfig"],
): ChatCompletionsPayload["tool_choice"] {
  if (!toolConfig?.functionCallingConfig) return undefined

  const mode = toolConfig.functionCallingConfig.mode
  switch (mode) {
    case "AUTO": {
      return "auto"
    }
    case "NONE": {
      return "none"
    }
    case "ANY": {
      const allowed = toolConfig.functionCallingConfig.allowedFunctionNames
      if (allowed && allowed.length === 1) {
        return {
          type: "function",
          function: { name: allowed[0] },
        }
      }
      return "required"
    }
    default: {
      return undefined
    }
  }
}

/**
 * Extract system instruction from Google payload as an OpenAI system message.
 */
function translateSystemInstruction(
  systemInstruction: GoogleAIRequest["systemInstruction"],
): Message | undefined {
  if (!systemInstruction?.parts) return undefined

  const systemText = systemInstruction.parts.map((p) => p.text).join("\n")
  if (!systemText) return undefined

  return { role: "system", content: systemText }
}

/**
 * Map Google generationConfig fields to OpenAI-compatible fields.
 */
function mapGenerationConfigFields(
  config: GoogleAIRequest["generationConfig"],
): Partial<ChatCompletionsPayload> {
  if (!config) return {}
  return {
    max_tokens: config.maxOutputTokens,
    temperature: config.temperature,
    top_p: config.topP,
    stop: config.stopSequences,
    seed: config.seed,
    frequency_penalty: config.frequencyPenalty,
    presence_penalty: config.presencePenalty,
    response_format:
      config.responseMimeType === "application/json" ?
        { type: "json_object" }
      : undefined,
  }
}

/**
 * Convert Google generationConfig → OpenAI-compatible config fields.
 */
function translateGenerationConfig(
  config: GoogleAIRequest["generationConfig"],
  stream: boolean,
): Partial<ChatCompletionsPayload> {
  return {
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    ...mapGenerationConfigFields(config),
  }
}

/**
 * Main translation: Google Generative AI request → OpenAI ChatCompletions payload.
 */
export function translateGoogleToOpenAI(
  googlePayload: GoogleAIRequest,
  model: string,
  stream: boolean,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // System instruction → system message
  const systemMessage = translateSystemInstruction(
    googlePayload.systemInstruction,
  )
  if (systemMessage) {
    messages.push(systemMessage)
  }

  // Contents → messages
  messages.push(...translateContents(googlePayload.contents))

  const allowedFunctionNames =
    (
      googlePayload.toolConfig?.functionCallingConfig?.mode === "ANY"
      && googlePayload.toolConfig.functionCallingConfig.allowedFunctionNames
    ) ?
      new Set(
        googlePayload.toolConfig.functionCallingConfig.allowedFunctionNames,
      )
    : undefined

  return {
    model,
    messages,
    ...translateGenerationConfig(googlePayload.generationConfig, stream),
    tools: translateTools(googlePayload.tools, allowedFunctionNames),
    tool_choice: translateToolChoice(googlePayload.toolConfig),
    snippy: { enabled: false },
  }
}
