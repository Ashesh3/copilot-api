import type {
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type { NativeMessagesRequestOptions } from "~/routes/messages/native-handler"
import type { ContentPart } from "~/services/copilot/create-chat-completions"
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesPayload,
  ResponsesResult,
  ResponseUsage,
} from "~/services/copilot/create-responses"

import {
  assertEndpointTranslationSupported,
  createEndpointTranslationError,
} from "~/lib/error"
import { createNativeMessages } from "~/routes/messages/native-handler"

import {
  convertOpenAIContentPartToAnthropic,
  convertOpenAIToolsToAnthropic,
} from "../chat-completions/anthropic-conversion"
import { checkResponsesToMessagesTranslation } from "./translation-fidelity"

export interface ResponsesMessagesBridgeOptions {
  attachmentsNormalized?: boolean
}

export async function executeResponsesMessagesBridge(options: {
  attachmentsNormalized?: boolean
  compaction?: boolean
  nativeOptions: NativeMessagesRequestOptions
  payload: ResponsesPayload
  preserveValidatedControls?: boolean
  signal?: AbortSignal
}): Promise<ResponsesResult> {
  const anthropicPayload = await responsesPayloadToAnthropic(
    options.payload,
    options.signal,
    { attachmentsNormalized: options.attachmentsNormalized },
  )
  anthropicPayload.stream = false
  const response = (await createNativeMessages(
    anthropicPayload,
    options.nativeOptions,
    {
      compaction: options.compaction,
      preserveValidatedControls: options.preserveValidatedControls,
      signal: options.signal,
    },
  )) as AnthropicResponse
  return anthropicResponseToResponsesResult(
    response,
    options.nativeOptions.requestedModel ?? options.payload.model,
    options.payload,
  )
}

export async function responsesPayloadToAnthropic(
  payload: ResponsesPayload,
  signal?: AbortSignal,
  options?: ResponsesMessagesBridgeOptions,
): Promise<AnthropicMessagesPayload> {
  assertEndpointTranslationSupported(
    {
      blockers: [],
      code: "endpoint_translation_unsupported",
      source: "responses",
    },
    checkResponsesToMessagesTranslation(payload),
  )

  const { messages, systemTexts } = await convertResponsesInput(
    payload.input,
    signal,
    options,
  )
  if (payload.instructions) systemTexts.unshift(payload.instructions)

  const toolChoice = convertResponsesToolChoice(payload.tool_choice)
  const parallelChoice = applyParallelToolChoice(
    toolChoice,
    payload.parallel_tool_calls,
    payload.tools,
  )

  return {
    model: payload.model,
    messages,
    ...((
      payload.max_output_tokens === undefined
      || payload.max_output_tokens === null
    ) ?
      {}
    : { max_tokens: payload.max_output_tokens }),
    ...(systemTexts.length > 0 ? { system: systemTexts.join("\n\n") } : {}),
    ...(payload.temperature === undefined || payload.temperature === null ?
      {}
    : { temperature: payload.temperature }),
    ...(payload.top_p === undefined || payload.top_p === null ?
      {}
    : { top_p: payload.top_p }),
    ...(payload.user ? { metadata: { user_id: payload.user } } : {}),
    ...convertResponsesTools(payload.tools),
    ...parallelChoice,
    ...convertResponsesOutputConfig(payload),
  }
}

async function convertResponsesInput(
  input: ResponsesPayload["input"],
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<{
  messages: Array<AnthropicMessage>
  systemTexts: Array<string>
}> {
  const messages: Array<AnthropicMessage> = []
  const systemTexts: Array<string> = []
  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
    return { messages, systemTexts }
  }
  if (!Array.isArray(input)) return { messages, systemTexts }

  for (const item of input) {
    await appendResponsesItem({ item, messages, options, signal, systemTexts })
  }
  return { messages, systemTexts }
}

async function appendResponsesItem(options: {
  item: ResponseInputItem
  messages: Array<AnthropicMessage>
  options?: { attachmentsNormalized?: boolean }
  signal?: AbortSignal
  systemTexts: Array<string>
}): Promise<void> {
  const item = options.item as Record<string, unknown>
  const type = typeof item.type === "string" ? item.type : undefined
  if (type === "function_call") {
    const callId = typeof item.call_id === "string" ? item.call_id : ""
    const name = typeof item.name === "string" ? item.name : ""
    const argumentsText =
      typeof item.arguments === "string" ? item.arguments : ""
    appendAssistantBlock(options.messages, {
      type: "tool_use",
      id: callId,
      name,
      input: safeParseArguments(argumentsText),
    })
    return
  }
  if (type === "function_call_output") {
    const callId = typeof item.call_id === "string" ? item.call_id : ""
    appendUserBlock(options.messages, {
      type: "tool_result",
      tool_use_id: callId,
      content: await convertResponsesToolResult(
        item.output,
        options.signal,
        options.options,
      ),
    })
    return
  }
  if (type !== undefined && type !== "message") return

  const role = item.role
  const content = item.content
  if (role === "system" || role === "developer") {
    const text = responsesContentToPlainText(content)
    if (text) options.systemTexts.push(text)
    return
  }
  if (role === "assistant") {
    const blocks = await convertResponsesAssistantContent(
      content,
      options.signal,
      options.options,
    )
    options.messages.push({ role: "assistant", content: blocks })
    return
  }
  const blocks = await convertResponsesUserContent(
    content,
    options.signal,
    options.options,
  )
  let messageContent: string | Array<AnthropicUserContentBlock> = ""
  if (typeof content === "string") messageContent = content
  else if (blocks.length > 0) messageContent = blocks
  options.messages.push({
    role: "user",
    content: messageContent,
  })
}

function appendAssistantBlock(
  messages: Array<AnthropicMessage>,
  block: AnthropicAssistantContentBlock,
): void {
  const previous = messages.at(-1)
  if (previous?.role === "assistant" && Array.isArray(previous.content)) {
    previous.content.push(block)
    return
  }
  messages.push({ role: "assistant", content: [block] })
}

function appendUserBlock(
  messages: Array<AnthropicMessage>,
  block: AnthropicUserContentBlock,
): void {
  const previous = messages.at(-1)
  if (previous?.role === "user" && Array.isArray(previous.content)) {
    previous.content.push(block)
    return
  }
  messages.push({ role: "user", content: [block] })
}

async function convertResponsesUserContent(
  content: unknown,
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<Array<AnthropicUserContentBlock>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: Array<AnthropicUserContentBlock> = []
  for (const part of content) {
    assertPreparedAttachment(part, options)
    blocks.push(
      ...(await convertOpenAIContentPartToAnthropic(
        responsesContentPartToOpenAI(part as Record<string, unknown>),
        signal,
      )),
    )
  }
  return blocks
}

async function convertResponsesAssistantContent(
  content: unknown,
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<Array<AnthropicAssistantContentBlock>> {
  const blocks = await convertResponsesUserContent(content, signal, options)
  return blocks.flatMap(
    (block): Array<AnthropicAssistantContentBlock> =>
      block.type === "text" ? [block] : [],
  )
}

async function convertResponsesToolResult(
  output: unknown,
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<AnthropicToolResultBlock["content"]> {
  if (typeof output === "string") return output
  if (!Array.isArray(output)) return ""
  const blocks = await convertResponsesUserContent(output, signal, options)
  return blocks.filter(
    (block) =>
      block.type === "text"
      || block.type === "image"
      || block.type === "document",
  )
}

function assertPreparedAttachment(
  part: unknown,
  options: { attachmentsNormalized?: boolean } | undefined,
): void {
  if (!options?.attachmentsNormalized || !part || typeof part !== "object") {
    return
  }
  const record = part as Record<string, unknown>
  const hasRemoteImage =
    record.type === "input_image"
    && typeof record.image_url === "string"
    && /^https?:\/\//i.test(record.image_url)
  const hasRemoteFile =
    record.type === "input_file"
    && typeof record.file_url === "string"
    && /^https?:\/\//i.test(record.file_url)
  if (!hasRemoteImage && !hasRemoteFile) return

  throw createEndpointTranslationError({
    blockers: ["message_content_part"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })
}

function responsesContentPartToOpenAI(
  part: Record<string, unknown>,
): ContentPart {
  if (part.type === "input_image") {
    const imageUrl = typeof part.image_url === "string" ? part.image_url : ""
    return {
      type: "image_url",
      image_url: {
        url: imageUrl,
        detail: "auto",
      },
    }
  }
  if (part.type === "input_file") {
    return {
      type: "file",
      file: {
        ...(typeof part.filename === "string" ?
          { filename: part.filename }
        : {}),
        ...(typeof part.file_data === "string" ?
          { file_data: part.file_data }
        : {}),
        ...(typeof part.file_id === "string" ? { file_id: part.file_id } : {}),
      },
    }
  }
  return {
    type: "text",
    text: typeof part.text === "string" ? part.text : "",
  }
}

function responsesContentToPlainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return []
      const text = (part as { text?: unknown }).text
      return typeof text === "string" ? [text] : []
    })
    .join("\n\n")
}

function safeParseArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Preserve malformed arguments explicitly instead of dropping them.
  }
  return rawArguments.trim().length > 0 ? { raw_arguments: rawArguments } : {}
}

function convertResponsesTools(
  tools: ResponsesPayload["tools"],
): Pick<AnthropicMessagesPayload, "tools"> {
  if (!Array.isArray(tools)) return {}
  const chatTools = tools.map((tool) => {
    const functionTool = tool as FunctionTool
    return {
      type: "function" as const,
      function: {
        name: functionTool.name,
        ...(functionTool.description ?
          { description: functionTool.description }
        : {}),
        parameters: functionTool.parameters ?? {},
      },
    }
  })
  return convertOpenAIToolsToAnthropic(chatTools)
}

function convertResponsesToolChoice(
  toolChoice: ResponsesPayload["tool_choice"],
): Pick<AnthropicMessagesPayload, "tool_choice"> {
  if (!toolChoice) return {}
  if (toolChoice === "auto") return { tool_choice: { type: "auto" } }
  if (toolChoice === "required") return { tool_choice: { type: "any" } }
  if (toolChoice === "none") return { tool_choice: { type: "none" } }
  if (
    typeof toolChoice === "object"
    && "name" in toolChoice
    && typeof toolChoice.name === "string"
  ) {
    return { tool_choice: { type: "tool", name: toolChoice.name } }
  }
  return {}
}

function applyParallelToolChoice(
  choice: Pick<AnthropicMessagesPayload, "tool_choice">,
  parallel: ResponsesPayload["parallel_tool_calls"],
  tools: ResponsesPayload["tools"],
): Pick<AnthropicMessagesPayload, "tool_choice"> {
  if (parallel !== false || !Array.isArray(tools) || tools.length === 0) {
    return choice
  }
  return {
    tool_choice: {
      ...(choice.tool_choice ?? { type: "auto" as const }),
      disable_parallel_tool_use: true,
    },
  }
}

function convertResponsesOutputConfig(
  payload: ResponsesPayload,
): Pick<AnthropicMessagesPayload, "output_config" | "thinking"> {
  const outputConfig: NonNullable<AnthropicMessagesPayload["output_config"]> =
    {}
  if (typeof payload.reasoning?.effort === "string") {
    outputConfig.effort = payload.reasoning.effort as NonNullable<
      AnthropicMessagesPayload["output_config"]
    >["effort"]
  }
  if (payload.text?.format) outputConfig.format = payload.text.format
  if (payload.task_budget) outputConfig.task_budget = payload.task_budget
  return {
    ...(Object.keys(outputConfig).length > 0 ?
      { output_config: outputConfig }
    : {}),
    ...(typeof payload.reasoning?.effort === "number" ?
      {
        thinking: {
          type: "enabled" as const,
          budget_tokens: payload.reasoning.effort,
        },
      }
    : {}),
  }
}

export function anthropicResponseToResponsesResult(
  response: AnthropicResponse,
  requestedModel: string,
  request?: ResponsesPayload,
): ResponsesResult {
  const { output, text } = convertAnthropicOutput(response)
  const incompleteDetails = mapStopReason(response.stop_reason)
  return {
    id: response.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestedModel,
    output,
    output_text: text,
    status: incompleteDetails ? "incomplete" : "completed",
    usage: mapAnthropicUsage(response),
    error: null,
    incomplete_details: incompleteDetails,
    ...getResponsesRequestContext(request),
  }
}

function getResponsesRequestContext(
  request: ResponsesPayload | undefined,
): Pick<
  ResponsesResult,
  | "instructions"
  | "metadata"
  | "parallel_tool_calls"
  | "temperature"
  | "tool_choice"
  | "tools"
  | "top_p"
>
  & Partial<Pick<ResponsesResult, "max_output_tokens" | "reasoning" | "text">> {
  if (!request) {
    return {
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    }
  }
  return {
    instructions: request.instructions ?? null,
    metadata: request.metadata ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    temperature: request.temperature ?? null,
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    reasoning: request.reasoning ?? null,
    text: request.text ?? null,
  }
}

function convertAnthropicOutput(response: AnthropicResponse): {
  output: Array<ResponseOutputItem>
  text: string
} {
  const output: Array<ResponseOutputItem> = []
  let text = ""
  let messageIndex = 0
  let reasoningIndex = 0
  for (const rawBlock of response.content) {
    const block = rawBlock as unknown as Record<string, unknown>
    if (block.type === "thinking") {
      if (typeof block.thinking !== "string") throwResponseContentError()
      output.push(
        createReasoningOutput(
          response.id,
          block as unknown as Extract<
            AnthropicResponse["content"][number],
            { type: "thinking" }
          >,
          reasoningIndex,
        ),
      )
      reasoningIndex += 1
      continue
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") throwResponseContentError()
      text += block.text
      output.push(createTextOutput(response.id, block.text, messageIndex))
      messageIndex += 1
      continue
    }
    if (
      block.type !== "tool_use"
      || typeof block.id !== "string"
      || typeof block.name !== "string"
      || !isRecordValue(block.input)
    ) {
      throwResponseContentError()
    }
    output.push(
      createFunctionCallOutput(
        block as unknown as Extract<
          AnthropicResponse["content"][number],
          { type: "tool_use" }
        >,
      ),
    )
  }
  return { output, text }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function throwResponseContentError(): never {
  throw createEndpointTranslationError({
    blockers: ["response_content"],
    code: "endpoint_translation_unsupported",
    source: "messages",
  })
}

function createReasoningOutput(
  responseId: string,
  block: Extract<AnthropicResponse["content"][number], { type: "thinking" }>,
  index: number,
): ResponseOutputItem {
  return {
    id: index === 0 ? `rs_${responseId}` : `rs_${responseId}_${index}`,
    type: "reasoning",
    summary:
      block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
    ...(block.signature ? { encrypted_content: block.signature } : {}),
    status: "completed",
  }
}

function createTextOutput(
  responseId: string,
  text: string,
  index: number,
): ResponseOutputItem {
  return {
    id: index === 0 ? `msg_${responseId}` : `msg_${responseId}_${index}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

function createFunctionCallOutput(
  block: Extract<AnthropicResponse["content"][number], { type: "tool_use" }>,
): ResponseOutputItem {
  return {
    id: `fc_${block.id}`,
    type: "function_call",
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
    status: "completed",
  }
}

function mapStopReason(
  reason: AnthropicResponse["stop_reason"],
): ResponsesResult["incomplete_details"] {
  if (reason === "max_tokens") return { reason: "max_output_tokens" }
  if (reason === "refusal") return { reason: "content_filter" }
  return null
}

function mapAnthropicUsage(response: AnthropicResponse): ResponseUsage {
  const cachedTokens = response.usage.cache_read_input_tokens ?? 0
  const inputTokens =
    response.usage.input_tokens
    + cachedTokens
    + (response.usage.cache_creation_input_tokens ?? 0)
  return {
    input_tokens: inputTokens,
    output_tokens: response.usage.output_tokens,
    total_tokens: inputTokens + response.usage.output_tokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}
