import type { ReasoningEffort } from "~/lib/model-suffix"
/* eslint-disable max-lines */
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ResponseMessage,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  FunctionTool,
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputFile,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseInputText,
  ResponseOutputContentBlock,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseUsage,
} from "~/services/copilot/create-responses"

import { assertEndpointTranslationSupported } from "~/lib/error"
import {
  createHostedWebSearchTool,
  isChatWebSearchFunctionTool,
  isWebSearchToolType,
} from "~/services/copilot/mcp-web-search"

import { normalizeChatCompletionsRequest } from "./chat-contract"
import { checkNormalizedChatToResponsesTranslation } from "./translation-fidelity"

type WriteSseStream = {
  writeSSE: (data: { data: string }) => Promise<void>
}

type ChatDelta = ChatCompletionChunk["choices"][number]["delta"] & {
  encrypted_content?: string | null
}

type ChatResponseUsage = NonNullable<ChatCompletionResponse["usage"]> & {
  completion_tokens_details?: {
    reasoning_tokens: number
  }
}

type ChatStreamUsage = NonNullable<ChatCompletionChunk["usage"]> & {
  completion_tokens_details?: {
    reasoning_tokens: number
  }
}

type ResponseMessageWithEncryptedContent = ResponseMessage & {
  encrypted_content?: string | null
}

export interface ResponsesAsChatStreamState {
  accumulatedText: string
  created: number
  id: string
  model: string
  nextToolIndex: number
  reasoningEmitted: boolean
  roleEmitted: boolean
  textEmitted: boolean
  toolArgumentEmittedByOutputIndex: Map<number, boolean>
  toolIndexByOutputIndex: Map<number, number>
  toolStartedByOutputIndex: Map<number, boolean>
}

export interface ResponsesAsChatStreamResult {
  cachedTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  receivedFailure?: ResponseStreamEvent
  responseText: string
  state: Readonly<ResponsesAsChatStreamState>
  terminal: "completed" | "error" | "failed" | "incomplete" | undefined
}

const DEFAULT_CREATED_AT = 0

export function chatCompletionsToResponses(
  payload: ChatCompletionsPayload & { model: string },
  reasoningEffort?: ReasoningEffort,
): ResponsesPayload {
  const normalized = normalizeChatCompletionsRequest(payload)
  assertEndpointTranslationSupported(
    {
      blockers: [],
      code: "endpoint_translation_unsupported",
      source: "chat",
    },
    checkNormalizedChatToResponsesTranslation(normalized),
  )

  const input = convertMessagesToResponsesInput(normalized.messages)
  const instructions = createResponsesInstructions(normalized)
  const tools = convertToolsToResponses(normalized.tools)
  const hasTools = Array.isArray(tools) && tools.length > 0
  const effort = reasoningEffort ?? normalized.reasoning_effort ?? undefined

  return {
    model: normalized.model,
    input,
    instructions,
    temperature: normalized.temperature,
    top_p: normalized.top_p,
    max_output_tokens:
      normalized.max_tokens ?? normalized.max_completion_tokens,
    user: normalized.user,
    snippy: normalized.snippy,
    ...(hasTools ?
      {
        tools,
        tool_choice: convertToolChoiceToResponses(
          normalized.tool_choice,
          tools,
        ),
        parallel_tool_calls: normalized.parallel_tool_calls ?? true,
      }
    : {}),
    stream: normalized.stream,
    store: false,
    reasoning: {
      ...(effort ? { effort } : {}),
      summary: "auto",
    },
    include: ["reasoning.encrypted_content"],
    ...convertResponseFormatToResponsesText(normalized.response_format),
  }
}

export function responsesResultToChatCompletion(
  response: ResponsesResult,
  requestedModel: string,
): ChatCompletionResponse {
  const message = buildChatMessage(response.output, response.output_text)
  const finishReason = getFinishReason(response)

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: mapResponsesUsageToChat(response.usage),
  }
}

export async function streamResponsesAsChatCompletions(
  stream: WriteSseStream,
  responseStream: AsyncIterable<{ data?: string; event?: string }>,
  requestedModel: string,
): Promise<ResponsesAsChatStreamResult> {
  const state = createStreamState(requestedModel)
  let finalUsage = extractUsage(null)
  let responseText = ""
  let terminal: ResponsesAsChatStreamResult["terminal"]
  let receivedFailure: ResponseStreamEvent | undefined

  for await (const chunk of responseStream) {
    if (!chunk.data || chunk.data === "[DONE]") continue

    const event = JSON.parse(chunk.data) as ResponseStreamEvent
    const result = await emitTranslatedEvent(stream, event, state)
    if (result.terminal) {
      terminal = result.terminal
      receivedFailure = result.receivedFailure
      if (result.usage) {
        finalUsage = result.usage
        responseText = result.usage.responseText
      }
      break
    }
    const usage = result.usage
    if (usage) {
      finalUsage = usage
      responseText = usage.responseText
    }
  }

  return {
    ...finalUsage,
    ...(receivedFailure ? { receivedFailure } : {}),
    responseText,
    state,
    terminal,
  }
}

function convertMessagesToResponsesInput(
  messages: ChatCompletionsPayload["messages"],
): Array<ResponseInputItem> {
  const input: Array<ResponseInputItem> = []

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      continue
    }

    input.push(...convertMessageToResponsesItems(message))
  }

  return input
}

function convertMessageToResponsesItems(
  message: Message,
): Array<ResponseInputItem> {
  const reasoning = createReasoningItem(message)

  switch (message.role) {
    case "user": {
      return [
        ...reasoning,
        createInputMessage(
          "user",
          message.content,
          getCopilotCacheControl(message),
        ),
      ]
    }
    case "assistant": {
      return [...reasoning, ...convertAssistantMessageToResponsesItems(message)]
    }
    case "tool": {
      return [
        ...reasoning,
        {
          type: "function_call_output",
          call_id: message.tool_call_id ?? "",
          output: convertToolOutput(message.content),
        } satisfies ResponseFunctionCallOutputItem,
      ]
    }
    default: {
      return reasoning
    }
  }
}

function convertAssistantMessageToResponsesItems(
  message: Message,
): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = []
  const hasContent = messageHasContent(message)

  if (hasContent) {
    items.push(
      createInputMessage(
        "assistant",
        message.content,
        getCopilotCacheControl(message),
      ),
    )
  }

  for (const toolCall of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: "completed",
    } satisfies ResponseFunctionToolCallItem)
  }

  return items
}

function createReasoningItem(message: Message): Array<ResponseInputReasoning> {
  if (message.role !== "assistant" || !message.encrypted_content) {
    return []
  }

  return [
    {
      ...(message.reasoning_opaque ? { id: message.reasoning_opaque } : {}),
      type: "reasoning",
      summary:
        message.reasoning_text ?
          [{ type: "summary_text", text: message.reasoning_text }]
        : [],
      encrypted_content: message.encrypted_content,
    },
  ]
}

function createInputMessage(
  role: "user" | "assistant",
  content: Message["content"],
  copilotCacheControl?: { type: "ephemeral" },
): ResponseInputMessage {
  return {
    type: "message",
    role,
    content: convertMessageContent(content, role),
    ...(copilotCacheControl ?
      { copilot_cache_control: copilotCacheControl }
    : {}),
  } as ResponseInputMessage
}

function convertMessageContent(
  content: Message["content"],
  role: "user" | "assistant",
): string | Array<ResponseInputContent> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const converted = content.flatMap((part) => convertContentPart(part, role))

  return converted.length > 0 ? converted : ""
}

function convertContentPart(
  part: ContentPart,
  role: "user" | "assistant",
): Array<ResponseInputContent> {
  switch (part.type) {
    case "text": {
      return [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: part.text,
        } satisfies ResponseInputText,
      ]
    }
    case "image_url": {
      if (role !== "user") return []
      return [
        {
          type: "input_image",
          image_url: part.image_url.url,
          detail: part.image_url.detail ?? "auto",
        } satisfies ResponseInputImage,
      ]
    }
    case "file": {
      if (role !== "user") return []
      return [
        {
          type: "input_file",
          filename: part.file.filename ?? "document.pdf",
          ...(part.file.file_data ? { file_data: part.file.file_data } : {}),
          ...(part.file.file_id ? { file_id: part.file.file_id } : {}),
        } satisfies ResponseInputFile,
      ]
    }
    default: {
      return []
    }
  }
}

/**
 * Tool results may carry images/files (e.g. screenshot tools); the Copilot
 * Responses endpoint accepts structured function_call_output content.
 */
function convertToolOutput(
  content: Message["content"],
): string | Array<ResponseInputContent> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  if (content.every((part) => part.type === "text")) {
    return contentToText(content)
  }

  return content.flatMap((part) => convertContentPart(part, "user"))
}

function extractInstructions(
  messages: ChatCompletionsPayload["messages"],
): string | null {
  const instructions = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => contentToText(message.content))
    .filter((content) => content.length > 0)
    .join("\n")

  return instructions.length > 0 ? instructions : null
}

function convertToolsToResponses(
  tools: ChatCompletionsPayload["tools"],
): ResponsesPayload["tools"] {
  const converted =
    tools?.map((tool) => {
      if (isWebSearchToolType(tool)) {
        return (
          createHostedWebSearchTool(tool)
          ?? (tool as unknown as Record<string, unknown>)
        )
      }
      if (isChatWebSearchFunctionTool(tool)) {
        const hosted = createHostedWebSearchTool(tool)
        if (hosted) return hosted
      }
      if ((tool as { type?: string }).type !== "function") {
        return tool as unknown as Record<string, unknown>
      }
      return {
        type: "function" as const,
        name: tool.function.name,
        description: tool.function.description ?? null,
        parameters: tool.function.parameters,
        strict: false,
        ...(getCopilotCacheControl(tool) ?
          { copilot_cache_control: getCopilotCacheControl(tool) }
        : {}),
      } satisfies FunctionTool
    }) ?? []

  return converted.length > 0 ? converted : null
}

function convertToolChoiceToResponses(
  toolChoice: ChatCompletionsPayload["tool_choice"],
  tools: ResponsesPayload["tools"],
): ResponsesPayload["tool_choice"] {
  if (typeof toolChoice === "string") return toolChoice
  const functionName = getToolChoiceFunctionName(toolChoice)
  if (functionName) {
    if (
      functionName === "web_search"
      && tools?.some((tool) => isWebSearchToolType(tool))
    ) {
      return {
        type: "web_search",
      } as unknown as ResponsesPayload["tool_choice"]
    }
    return { type: "function", name: functionName }
  }
  if (isWebSearchToolChoice(toolChoice)) {
    return toolChoice as unknown as ResponsesPayload["tool_choice"]
  }
  return "auto"
}

function getToolChoiceFunctionName(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): string | undefined {
  if (!toolChoice || typeof toolChoice !== "object") return undefined
  if (!("function" in toolChoice)) return undefined
  if (!toolChoice.function || typeof toolChoice.function !== "object") {
    return undefined
  }
  if (!("name" in toolChoice.function)) return undefined
  return typeof toolChoice.function.name === "string" ?
      toolChoice.function.name
    : undefined
}

function isWebSearchToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): boolean {
  if (!toolChoice || typeof toolChoice !== "object") return false
  if (!("type" in toolChoice) || typeof toolChoice.type !== "string") {
    return false
  }
  return (
    toolChoice.type === "web_search"
    || toolChoice.type.startsWith("web_search_")
  )
}

function convertResponseFormatToResponsesText(
  responseFormat: ChatCompletionsPayload["response_format"],
): Pick<ResponsesPayload, "text"> {
  if (!responseFormat) return {}

  if (
    responseFormat.type === "json_object"
    || responseFormat.type === "json_schema"
  ) {
    return { text: { format: { type: "json_object" } } }
  }

  return {}
}

function createResponsesInstructions(
  payload: ChatCompletionsPayload,
): string | null {
  const instructions = extractInstructions(payload.messages)
  const jsonInstruction = createJsonResponseInstruction(payload.response_format)
  const parts = [instructions, jsonInstruction].filter(Boolean)

  return parts.length > 0 ? parts.join("\n\n") : null
}

function createJsonResponseInstruction(
  responseFormat: ChatCompletionsPayload["response_format"],
): string | null {
  if (!responseFormat || !isJsonChatResponseFormat(responseFormat)) {
    return null
  }

  let instruction =
    "IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation - just raw JSON."

  if (responseFormat.type === "json_schema") {
    const schemaWrapper = responseFormat.json_schema
    const schema =
      isRecord(schemaWrapper) && schemaWrapper.schema !== undefined ?
        schemaWrapper.schema
      : schemaWrapper
    if (schema !== undefined) {
      instruction += `\nYou MUST conform to this JSON schema:\n${JSON.stringify(schema)}`
    }
  }

  return instruction
}

function isJsonChatResponseFormat(
  responseFormat: ChatCompletionsPayload["response_format"],
): responseFormat is { type: "json_object" | "json_schema" } & Record<
  string,
  unknown
> {
  return (
    responseFormat?.type === "json_object"
    || responseFormat?.type === "json_schema"
  )
}

export function getResponsesResultOutputText(
  response: Pick<ResponsesResult, "output" | "output_text">,
): string {
  return collectMessageText(response.output) || response.output_text || ""
}

function buildChatMessage(
  output: Array<ResponseOutputItem>,
  outputText: string,
): ResponseMessageWithEncryptedContent {
  const message: ResponseMessageWithEncryptedContent = {
    role: "assistant" as const,
    content:
      getResponsesResultOutputText({ output, output_text: outputText }) || null,
  }

  const toolCalls = collectToolCalls(output)
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  const reasoning = output.find(
    (item): item is ResponseOutputReasoning => item.type === "reasoning",
  )
  if (reasoning) {
    applyReasoningToMessage(message, reasoning)
  }

  return message
}

function collectMessageText(output: Array<ResponseOutputItem>): string {
  return output
    .filter((item): item is ResponseOutputMessage => item.type === "message")
    .map((item) => collectContentText(item.content))
    .join("")
}

function collectContentText(
  content: Array<ResponseOutputContentBlock> | undefined,
): string {
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (isResponseOutputText(block)) return block.text
      if (isResponseOutputRefusal(block)) return block.refusal
      if (typeof (block as { text?: unknown }).text === "string") {
        return (block as { text: string }).text
      }
      if (typeof (block as { reasoning?: unknown }).reasoning === "string") {
        return (block as { reasoning: string }).reasoning
      }
      return ""
    })
    .join("")
}

function collectToolCalls(output: Array<ResponseOutputItem>): Array<ToolCall> {
  return output
    .filter(
      (item): item is ResponseOutputFunctionCall =>
        item.type === "function_call",
    )
    .map((item) => ({
      id: item.call_id,
      type: "function",
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    }))
}

function applyReasoningToMessage(
  message: ResponseMessageWithEncryptedContent,
  reasoning: ResponseOutputReasoning,
): void {
  message.reasoning_opaque = reasoning.id
  const reasoningText = collectReasoningText(reasoning)
  if (reasoningText) {
    message.reasoning_text = reasoningText
  }
  if (reasoning.encrypted_content) {
    message.encrypted_content = reasoning.encrypted_content
  }
}

function collectReasoningText(reasoning: ResponseOutputReasoning): string {
  return [...(reasoning.summary ?? []), ...(reasoning.content ?? [])]
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
}

function getFinishReason(
  response: ResponsesResult,
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  if (response.incomplete_details?.reason === "max_output_tokens") {
    return "length"
  }
  if (response.incomplete_details?.reason === "content_filter") {
    return "content_filter"
  }
  if (response.output.some((item) => item.type === "function_call")) {
    return "tool_calls"
  }
  return "stop"
}

function mapResponsesUsageToChat(
  usage: ResponseUsage | null | undefined,
): ChatResponseUsage | undefined {
  if (!usage) return undefined

  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: {
      cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    },
  }
}

function mapResponsesUsageToChatStream(
  usage: ResponseUsage | null | undefined,
): ChatStreamUsage | undefined {
  if (!usage) return undefined

  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: {
      cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
    },
    completion_tokens_details: {
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    },
  }
}

function setTextDeltaState(
  state: ResponsesAsChatStreamState,
  delta: string,
): void {
  state.accumulatedText += delta
  state.textEmitted = true
}

async function emitTranslatedEvent(
  stream: WriteSseStream,
  event: ResponseStreamEvent,
  state: ResponsesAsChatStreamState,
): Promise<{
  receivedFailure?: ResponseStreamEvent
  terminal?: ResponsesAsChatStreamResult["terminal"]
  usage?: ReturnType<typeof extractUsage> & { responseText: string }
}> {
  switch (event.type) {
    case "response.created": {
      await emitRoleChunk(stream, state, event.response)
      return {}
    }
    case "response.output_text.delta": {
      setTextDeltaState(state, event.delta)
      await emitDelta(stream, state, { content: event.delta })
      return {}
    }
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta": {
      await emitDelta(stream, state, { reasoning_text: event.delta })
      // eslint-disable-next-line require-atomic-updates
      state.reasoningEmitted = true
      return {}
    }
    case "response.output_item.added": {
      await emitOutputItemAdded({ stream, state, event })
      return {}
    }
    case "response.function_call_arguments.delta": {
      await emitFunctionCallArguments(stream, state, {
        outputIndex: event.output_index,
        argumentsDelta: event.delta,
      })
      return {}
    }
    case "response.function_call_arguments.done": {
      await emitFunctionCallArgumentsDone(stream, state, {
        outputIndex: event.output_index,
        name: event.name,
        arguments: event.arguments,
      })
      return {}
    }
    case "response.output_item.done": {
      await emitOutputItemDone({
        stream,
        state,
        outputIndex: event.output_index,
        item: event.item,
      })
      return {}
    }
    case "response.completed":
    case "response.incomplete": {
      await synthesizeMissingOutput(stream, state, event.response)
      await emitFinalChunk(stream, state, event.response)
      return {
        terminal:
          event.type === "response.completed" ? "completed" : "incomplete",
        usage: {
          ...extractUsage(event.response.usage),
          responseText:
            getResponsesResultOutputText(event.response)
            || state.accumulatedText,
        },
      }
    }
    case "response.failed": {
      return { terminal: "failed", receivedFailure: event }
    }
    case "error": {
      return { terminal: "error", receivedFailure: event }
    }
    default: {
      return {}
    }
  }
}

function createStreamState(model: string): ResponsesAsChatStreamState {
  return {
    accumulatedText: "",
    created: DEFAULT_CREATED_AT,
    id: "chatcmpl_responses_fallback",
    model,
    nextToolIndex: 0,
    reasoningEmitted: false,
    roleEmitted: false,
    textEmitted: false,
    toolArgumentEmittedByOutputIndex: new Map(),
    toolIndexByOutputIndex: new Map(),
    toolStartedByOutputIndex: new Map(),
  }
}

async function emitRoleChunk(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  response: Pick<ResponsesResult, "created_at" | "id">,
): Promise<void> {
  if (state.roleEmitted) return
  state.id = response.id
  state.created = response.created_at
  await writeChunk({ stream, state, delta: { role: "assistant" } })
  // eslint-disable-next-line require-atomic-updates
  state.roleEmitted = true
}

async function emitDelta(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  delta: ChatDelta,
): Promise<void> {
  await ensureRoleChunk(stream, state)
  await writeChunk({ stream, state, delta })
}

async function ensureRoleChunk(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
): Promise<void> {
  if (state.roleEmitted) return
  await writeChunk({ stream, state, delta: { role: "assistant" } })
  // eslint-disable-next-line require-atomic-updates
  state.roleEmitted = true
}

async function emitFunctionCallStart(options: {
  item: ResponseOutputFunctionCall
  outputIndex: number
  state: ResponsesAsChatStreamState
  stream: WriteSseStream
}): Promise<void> {
  const { item, outputIndex, state, stream } = options
  const toolIndex = getToolIndex(state, outputIndex)
  await emitDelta(stream, state, {
    tool_calls: [
      {
        index: toolIndex,
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      },
    ],
  })
  state.toolStartedByOutputIndex.set(outputIndex, true)
  if (item.arguments) {
    state.toolArgumentEmittedByOutputIndex.set(outputIndex, true)
  }
}

async function emitFunctionCallArguments(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  options: { argumentsDelta: string; outputIndex: number },
): Promise<void> {
  const toolIndex = getToolIndex(state, options.outputIndex)
  await emitDelta(stream, state, {
    tool_calls: [
      {
        index: toolIndex,
        function: {
          arguments: options.argumentsDelta,
        },
      },
    ],
  })
  state.toolArgumentEmittedByOutputIndex.set(options.outputIndex, true)
}

async function emitFunctionCallArgumentsDone(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  options: { arguments: string; name: string; outputIndex: number },
): Promise<void> {
  if (state.toolArgumentEmittedByOutputIndex.get(options.outputIndex)) return
  const toolIndex = getToolIndex(state, options.outputIndex)
  await emitDelta(stream, state, {
    tool_calls: [
      {
        index: toolIndex,
        type: "function",
        function: {
          name: options.name,
          arguments: options.arguments,
        },
      },
    ],
  })
}

async function emitOutputItemAdded(options: {
  event: Extract<ResponseStreamEvent, { type: "response.output_item.added" }>
  state: ResponsesAsChatStreamState
  stream: WriteSseStream
}): Promise<void> {
  const { event, state, stream } = options
  if (event.item.type !== "function_call") return

  await emitFunctionCallStart({
    stream,
    state,
    outputIndex: event.output_index,
    item: event.item,
  })
}

async function emitOutputItemDone(options: {
  item: ResponseOutputItem
  outputIndex: number
  state: ResponsesAsChatStreamState
  stream: WriteSseStream
}): Promise<void> {
  const { item, outputIndex, state, stream } = options
  if (item.type === "reasoning") {
    await emitReasoningDone(stream, state, item)
    return
  }

  if (
    item.type === "function_call"
    && !state.toolStartedByOutputIndex.get(outputIndex)
  ) {
    await emitFunctionCallStart({ stream, state, outputIndex, item })
  }
}

async function emitReasoningDone(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  reasoning: ResponseOutputReasoning,
): Promise<void> {
  const delta: ChatDelta = {}
  const reasoningText = collectReasoningText(reasoning)
  if (reasoningText && !state.reasoningEmitted) {
    delta.reasoning_text = reasoningText
  }
  delta.reasoning_opaque = reasoning.id
  if (reasoning.encrypted_content) {
    delta.encrypted_content = reasoning.encrypted_content
  }

  await emitDelta(stream, state, delta)
  // eslint-disable-next-line require-atomic-updates
  state.reasoningEmitted = true
}

async function synthesizeMissingOutput(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  response: ResponsesResult,
): Promise<void> {
  const reasoning = response.output.find(
    (item): item is ResponseOutputReasoning => item.type === "reasoning",
  )
  if (reasoning && !state.reasoningEmitted) {
    await emitReasoningDone(stream, state, reasoning)
  }

  if (!state.textEmitted && response.output_text) {
    setTextDeltaState(state, response.output_text)
    await emitDelta(stream, state, { content: response.output_text })
  }

  for (const [outputIndex, item] of response.output.entries()) {
    if (
      item.type === "function_call"
      && !state.toolStartedByOutputIndex.get(outputIndex)
    ) {
      await emitFunctionCallStart({ stream, state, outputIndex, item })
    }
  }
}

async function emitFinalChunk(
  stream: WriteSseStream,
  state: ResponsesAsChatStreamState,
  response: ResponsesResult,
): Promise<void> {
  await ensureRoleChunk(stream, state)
  await writeChunk({
    stream,
    state,
    delta: {},
    finishReason: getFinishReason(response),
    usage: response.usage,
  })
}

function getToolIndex(
  state: ResponsesAsChatStreamState,
  outputIndex: number,
): number {
  const existing = state.toolIndexByOutputIndex.get(outputIndex)
  if (existing !== undefined) return existing

  const next = state.nextToolIndex
  state.nextToolIndex += 1
  state.toolIndexByOutputIndex.set(outputIndex, next)
  return next
}

async function writeChunk(options: {
  delta: ChatDelta
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
  state: ResponsesAsChatStreamState
  stream: WriteSseStream
  usage?: ResponseUsage | null
}): Promise<void> {
  const { delta, state, stream, finishReason = null, usage } = options
  const chunk = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ? { usage: mapResponsesUsageToChatStream(usage) } : {}),
  } satisfies ChatCompletionChunk

  await stream.writeSSE({ data: JSON.stringify(chunk) })
}

function extractUsage(usage: ResponseUsage | null | undefined): {
  cachedTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
} {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  }
}

function contentToText(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((part) => {
      switch (part.type) {
        case "text": {
          return part.text
        }
        case "image_url": {
          return part.image_url.url
        }
        default: {
          return ""
        }
      }
    })
    .join("")
}

function messageHasContent(message: Message): boolean {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }
  return Array.isArray(message.content) && message.content.length > 0
}

function getCopilotCacheControl(
  value: unknown,
): { type: "ephemeral" } | undefined {
  if (!value || typeof value !== "object") return undefined

  const cacheControl = (value as Record<string, unknown>).copilot_cache_control
  if (!isRecord(cacheControl)) return undefined

  return cacheControl.type === "ephemeral" ? { type: "ephemeral" } : undefined
}

function isResponseOutputText(
  block: ResponseOutputContentBlock,
): block is Extract<ResponseOutputContentBlock, { type: "output_text" }> {
  return isRecord(block) && block.type === "output_text"
}

function isResponseOutputRefusal(
  block: ResponseOutputContentBlock,
): block is Extract<ResponseOutputContentBlock, { type: "refusal" }> {
  return isRecord(block) && block.type === "refusal"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
