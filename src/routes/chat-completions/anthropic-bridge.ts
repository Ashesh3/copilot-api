import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import {
  attachmentOmittedNote,
  fetchUrlAsDataUri,
  isHttpUrl,
  isImageMediaType,
  isPdfMediaType,
  parseDataUri,
} from "~/lib/attachments"
import { assertEndpointTranslationSupported, isAbortError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { setRequestContext } from "~/lib/request-logger"
import {
  createSentryChatSpanOptions,
  setSentryOutputMessages,
} from "~/lib/sentry"
import { withSseHeartbeat } from "~/lib/sse-lifecycle"
import { resolveNativeWebSearch } from "~/routes/messages/native-handler"
import {
  createAnthropicMessages,
  type AnthropicStreamChunk,
} from "~/services/copilot/create-anthropic-messages"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  applyParallelToolChoice,
  convertChatReasoningOptions,
  createAssistantBlocks,
  getAnthropicReasoning,
} from "./anthropic-reasoning"
import { normalizeChatCompletionsRequest } from "./chat-contract"
import { checkNormalizedChatToMessagesTranslation } from "./translation-fidelity"

const logger = createHandlerLogger("anthropic-bridge")

/**
 * Bridge OpenAI Chat Completions payloads to Copilot's native /v1/messages
 * endpoint. Used when an OpenAI-dialect request carries PDF `file` parts and
 * the target claude model cannot receive them any other way
 * (/chat/completions only accepts text and image_url parts upstream).
 */
export async function executeAnthropicBridge(
  c: Context,
  options: {
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    selectedModel?: Model
  },
): Promise<Response> {
  const { payload, requestedModel, selectedModel } = options

  setRequestContext(c, { provider: "ChatCompletions→AnthropicMessages" })

  const anthropicPayload = await chatPayloadToAnthropic(
    payload,
    selectedModel,
    c.req.raw.signal,
  )
  logger.debug("Bridged Anthropic payload:", JSON.stringify(anthropicPayload))

  if (anthropicPayload.tools?.some((tool) => tool.name === "web_search")) {
    return await executeBridgeWebSearch(c, {
      payload,
      anthropicPayload,
      requestedModel,
    })
  }

  if (!anthropicPayload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: payload.model,
      }),
      async (span) => {
        const response = (await createAnthropicMessages(anthropicPayload, {
          signal: c.req.raw.signal,
        })) as AnthropicResponse

        recordAccountContext(c)

        const chatResponse = anthropicResponseToChat(response, requestedModel)
        if (chatResponse.usage) {
          setRequestContext(c, {
            inputTokens: chatResponse.usage.prompt_tokens,
            outputTokens: chatResponse.usage.completion_tokens,
          })
        }
        span.setAttribute(
          "gen_ai.usage.input_tokens",
          chatResponse.usage?.prompt_tokens ?? 0,
        )
        span.setAttribute(
          "gen_ai.usage.output_tokens",
          chatResponse.usage?.completion_tokens ?? 0,
        )
        setSentryOutputMessages(
          span,
          chatResponse.choices[0]?.message?.content ?? "",
        )
        return c.json(chatResponse)
      },
    )
  }

  return await executeBridgeStreaming(c, {
    payload,
    anthropicPayload,
    requestedModel,
  })
}

async function executeBridgeWebSearch(
  c: Context,
  options: {
    payload: ChatCompletionsPayload & { model: string }
    anthropicPayload: AnthropicMessagesPayload
    requestedModel: string
  },
): Promise<Response> {
  const requestedStream = Boolean(options.anthropicPayload.stream)
  options.anthropicPayload.stream = false
  const response = await resolveNativeWebSearch(options.anthropicPayload, {
    signal: c.req.raw.signal,
  })
  recordAccountContext(c)
  const result = anthropicResponseToChat(response, options.requestedModel)

  if (!requestedStream) return c.json(result)
  return streamSSE(c, async (stream) => {
    const chunk: ChatCompletionChunk = {
      id: result.id,
      object: "chat.completion.chunk",
      created: result.created,
      model: result.model,
      choices: result.choices.map((choice) => ({
        index: choice.index,
        delta: {
          role: "assistant",
          content: choice.message.content,
          reasoning_text: choice.message.reasoning_text,
          tool_calls: choice.message.tool_calls?.map((toolCall, index) => ({
            ...toolCall,
            index,
          })),
        },
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs,
      })),
      usage: result.usage,
    }
    await stream.writeSSE({ data: JSON.stringify(chunk) })
    await stream.writeSSE({ data: "[DONE]" })
  })
}

async function executeBridgeStreaming(
  c: Context,
  options: {
    payload: ChatCompletionsPayload & { model: string }
    anthropicPayload: AnthropicMessagesPayload
    requestedModel: string
  },
): Promise<Response> {
  const { payload, anthropicPayload, requestedModel } = options

  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: payload.messages,
      model: payload.model,
      streaming: true,
    }),
    async (streamSpan, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const response = (await createAnthropicMessages(anthropicPayload, {
          signal: c.req.raw.signal,
        })) as AsyncIterable<AnthropicStreamChunk>

        recordAccountContext(c)

        return streamSSE(c, async (stream) => {
          try {
            const usage = await streamAnthropicAsChatCompletions(
              stream,
              withSseHeartbeat(response, stream),
              requestedModel,
            )
            setRequestContext(c, {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            })
            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              usage.inputTokens,
            )
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              usage.outputTokens,
            )
            if (usage.cachedTokens > 0) {
              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens.cached",
                usage.cachedTokens,
              )
            }
            setSentryOutputMessages(streamSpan, usage.responseText)
          } catch (error) {
            if (isAbortError(error)) return
            throw error
          } finally {
            finishSpan()
          }
        })
      } catch (error) {
        finishSpan()
        throw error
      }
    },
  )
}

function recordAccountContext(c: Context): void {
  const accountId = getLastUsedAccountId()
  if (accountId !== undefined) {
    setRequestContext(c, { accountId })
  }
}

// ─── Request translation ───

export async function chatPayloadToAnthropic(
  payload: ChatCompletionsPayload & { model: string },
  selectedModel?: Model,
  signal?: AbortSignal,
): Promise<AnthropicMessagesPayload> {
  const normalized = normalizeChatCompletionsRequest(payload)
  assertEndpointTranslationSupported(
    {
      blockers: [],
      code: "endpoint_translation_unsupported",
      source: "chat",
    },
    checkNormalizedChatToMessagesTranslation(normalized),
  )

  const { systemTexts, messages } = await convertChatMessages(
    normalized.messages,
    signal,
  )

  const maxTokens =
    normalized.max_tokens
    ?? normalized.max_completion_tokens
    ?? selectedModel?.capabilities.limits?.max_output_tokens
  const toolChoice = convertToolChoice(normalized.tool_choice)
  const parallelChoice = applyParallelToolChoice(
    toolChoice,
    normalized.parallel_tool_calls,
    normalized.tools,
  )

  return {
    model: normalized.model,
    messages,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(systemTexts.length > 0 ? { system: systemTexts.join("\n\n") } : {}),
    ...convertSamplingOptions(normalized),
    ...(normalized.stream ? { stream: true } : {}),
    ...(normalized.user ? { metadata: { user_id: normalized.user } } : {}),
    ...convertTools(normalized.tools),
    ...parallelChoice,
    ...convertChatReasoningOptions(normalized),
  }
}

async function convertChatMessages(
  chatMessages: Array<Message>,
  signal?: AbortSignal,
): Promise<{ systemTexts: Array<string>; messages: Array<AnthropicMessage> }> {
  const systemTexts: Array<string> = []
  const messages: Array<AnthropicMessage> = []
  let pendingToolResults: Array<AnthropicToolResultBlock> = []

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return
    messages.push({ role: "user", content: pendingToolResults })
    pendingToolResults = []
  }

  for (const message of chatMessages) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentToPlainText(message.content)
      if (text) systemTexts.push(text)
      continue
    }

    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: await convertToolResultContent(message.content, signal),
      })
      continue
    }

    flushToolResults()

    if (message.role === "user") {
      const blocks = await convertUserContent(message.content, signal)
      if (blocks.length > 0 || typeof message.content === "string") {
        messages.push({
          role: "user",
          content:
            typeof message.content === "string" ? message.content : blocks,
        })
      }
      continue
    }

    const assistantMessage = convertAssistantMessage(message)
    if (assistantMessage) messages.push(assistantMessage)
  }
  flushToolResults()

  return { systemTexts, messages }
}

function convertAssistantMessage(message: Message): AnthropicMessage | null {
  const blocks = createAssistantBlocks(message)
  const text = contentToPlainText(message.content)
  if (text) blocks.push({ type: "text", text })
  for (const toolCall of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: safeParseArguments(toolCall.function.arguments),
    })
  }
  return blocks.length > 0 ? { role: "assistant", content: blocks } : null
}

function convertSamplingOptions(
  payload: ChatCompletionsPayload,
): Partial<AnthropicMessagesPayload> {
  return {
    ...(payload.temperature !== undefined && payload.temperature !== null ?
      { temperature: payload.temperature }
    : {}),
    ...(payload.top_p !== undefined && payload.top_p !== null ?
      { top_p: payload.top_p }
    : {}),
    ...(payload.stop ?
      {
        stop_sequences:
          Array.isArray(payload.stop) ? payload.stop : [payload.stop],
      }
    : {}),
  }
}

function contentToPlainText(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (part): part is ContentPart & { type: "text" } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
}

async function convertUserContent(
  content: Message["content"],
  signal?: AbortSignal,
): Promise<Array<AnthropicUserContentBlock>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: Array<AnthropicUserContentBlock> = []
  for (const part of content) {
    blocks.push(...(await convertContentPart(part, signal)))
  }
  return blocks
}

async function convertToolResultContent(
  content: Message["content"],
  signal?: AbortSignal,
): Promise<AnthropicToolResultBlock["content"]> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const blocks: Array<
    AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock
  > = []
  for (const part of content) {
    blocks.push(
      ...((await convertContentPart(part, signal)) as Array<
        AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock
      >),
    )
  }
  return blocks
}

async function convertContentPart(
  part: ContentPart,
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
    default: {
      return []
    }
  }
}

async function convertImagePart(
  url: string,
  signal?: AbortSignal,
): Promise<AnthropicImageBlock | AnthropicTextBlock> {
  let parsed = parseDataUri(url)
  if (!parsed && isHttpUrl(url)) {
    parsed = await fetchUrlAsDataUri(url, { signal })
  }

  if (parsed && isImageMediaType(parsed.mediaType)) {
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

  return {
    type: "text",
    text: attachmentOmittedNote({
      kind: "image",
      name: url,
      reason: "the image could not be decoded or fetched by the proxy",
    }),
  }
}

function convertFilePart(
  part: ContentPart & { type: "file" },
): AnthropicDocumentBlock | AnthropicTextBlock {
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

  return {
    type: "text",
    text: attachmentOmittedNote({
      kind: "file",
      name: part.file.filename,
      reason:
        part.file.file_id ?
          "file_id references are not supported by this proxy; send file_data as a base64 data URI"
        : "file_data must be a base64 data URI (e.g. data:application/pdf;base64,...)",
    }),
  }
}

function safeParseArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  return rawArguments.trim().length > 0 ? { raw_arguments: rawArguments } : {}
}

function convertTools(
  tools: ChatCompletionsPayload["tools"],
): Pick<AnthropicMessagesPayload, "tools"> {
  if (!tools || tools.length === 0) return {}
  const converted: Array<AnthropicTool> = tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ?
      { description: tool.function.description }
    : {}),
    input_schema: tool.function.parameters,
  }))
  return { tools: converted }
}

function convertToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): Pick<AnthropicMessagesPayload, "tool_choice"> {
  if (!toolChoice) return {}
  if (toolChoice === "auto") return { tool_choice: { type: "auto" } }
  if (toolChoice === "required") return { tool_choice: { type: "any" } }
  if (toolChoice === "none") return { tool_choice: { type: "none" } }
  if (
    typeof toolChoice === "object"
    && "function" in toolChoice
    && typeof toolChoice.function === "object"
    && toolChoice.function !== null
    && "name" in toolChoice.function
    && typeof toolChoice.function.name === "string"
  ) {
    return {
      tool_choice: { type: "tool", name: toolChoice.function.name },
    }
  }
  return {}
}

// ─── Response translation ───

export function anthropicResponseToChat(
  response: AnthropicResponse,
  requestedModel: string,
): ChatCompletionResponse {
  const textContent = response.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")

  const reasoning = getAnthropicReasoning(response.content)

  const toolCalls: Array<ToolCall> = response.content
    .filter((block) => block.type === "tool_use")
    .map((block) => {
      const toolUse = block
      return {
        id: toolUse.id,
        type: "function" as const,
        function: {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input),
        },
      }
    })

  const cachedTokens = response.usage.cache_read_input_tokens ?? 0
  const promptTokens =
    response.usage.input_tokens
    + cachedTokens
    + (response.usage.cache_creation_input_tokens ?? 0)

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...reasoning,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: mapStopReason(response.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: promptTokens + response.usage.output_tokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  }
}

function mapStopReason(
  stopReason: AnthropicResponse["stop_reason"],
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (stopReason) {
    case "max_tokens": {
      return "length"
    }
    case "tool_use": {
      return "tool_calls"
    }
    case "refusal": {
      return "content_filter"
    }
    default: {
      return "stop"
    }
  }
}

// ─── Stream translation ───

interface BridgeStreamState {
  id: string
  created: number
  roleEmitted: boolean
  nextToolIndex: number
  toolIndexByBlockIndex: Map<number, number>
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  responseText: string
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

type WriteBridgeChunk = (
  delta: ChatCompletionChunk["choices"][number]["delta"],
  options?: {
    finishReason?: BridgeStreamState["finishReason"]
    usage?: ChatCompletionChunk["usage"]
  },
) => Promise<void>

interface BridgeStreamContext {
  state: BridgeStreamState
  writeChunk: WriteBridgeChunk
  writeRaw: (data: string) => Promise<void>
}

export async function streamAnthropicAsChatCompletions(
  stream: { writeSSE: (data: { data: string }) => Promise<void> },
  response: AsyncIterable<AnthropicStreamChunk>,
  requestedModel: string,
): Promise<{
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  responseText: string
}> {
  const state: BridgeStreamState = {
    id: "chatcmpl_anthropic_bridge",
    created: Math.floor(Date.now() / 1000),
    roleEmitted: false,
    nextToolIndex: 0,
    toolIndexByBlockIndex: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    responseText: "",
    finishReason: null,
  }

  const writeChunk: WriteBridgeChunk = async (delta, options) => {
    const chunk: ChatCompletionChunk = {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: options?.finishReason ?? null,
          logprobs: null,
        },
      ],
      ...(options?.usage ? { usage: options.usage } : {}),
    }
    await stream.writeSSE({ data: JSON.stringify(chunk) })
  }

  const context: BridgeStreamContext = {
    state,
    writeChunk,
    writeRaw: async (data) => stream.writeSSE({ data }),
  }

  for await (const chunk of response) {
    if (!chunk.data || chunk.data.trim() === "[DONE]") continue

    let event: AnthropicStreamEventData
    try {
      event = JSON.parse(chunk.data) as AnthropicStreamEventData
    } catch {
      continue
    }

    await handleBridgeStreamEvent(event, context)
  }

  return {
    inputTokens: state.inputTokens + state.cachedTokens,
    outputTokens: state.outputTokens,
    cachedTokens: state.cachedTokens,
    responseText: state.responseText,
  }
}

async function handleBridgeStreamEvent(
  event: AnthropicStreamEventData,
  context: BridgeStreamContext,
): Promise<void> {
  const { state, writeChunk, writeRaw } = context

  switch (event.type) {
    case "message_start": {
      state.id = event.message.id
      state.inputTokens = event.message.usage.input_tokens
      state.cachedTokens = event.message.usage.cache_read_input_tokens ?? 0
      if (!state.roleEmitted) {
        state.roleEmitted = true
        await writeChunk({ role: "assistant" })
      }
      break
    }
    case "content_block_start": {
      if (event.content_block.type === "tool_use") {
        const toolIndex = state.nextToolIndex++
        state.toolIndexByBlockIndex.set(event.index, toolIndex)
        await writeChunk({
          tool_calls: [
            {
              index: toolIndex,
              id: event.content_block.id,
              type: "function",
              function: { name: event.content_block.name, arguments: "" },
            },
          ],
        })
      }
      break
    }
    case "content_block_delta": {
      await handleBridgeContentDelta(event, context)
      break
    }
    case "message_delta": {
      if (event.usage) {
        state.outputTokens = event.usage.output_tokens
        if (event.usage.input_tokens !== undefined) {
          state.inputTokens = event.usage.input_tokens
        }
      }
      if (event.delta.stop_reason) {
        state.finishReason = mapStopReason(event.delta.stop_reason)
      }
      break
    }
    case "message_stop": {
      await writeChunk(
        {},
        {
          finishReason: state.finishReason ?? "stop",
          usage: {
            prompt_tokens: state.inputTokens + state.cachedTokens,
            completion_tokens: state.outputTokens,
            total_tokens:
              state.inputTokens + state.cachedTokens + state.outputTokens,
            prompt_tokens_details: { cached_tokens: state.cachedTokens },
          },
        },
      )
      await writeRaw("[DONE]")
      break
    }
    case "error": {
      logger.warn("Native messages stream error:", event.error.message)
      await writeRaw(
        JSON.stringify({ error: { message: event.error.message } }),
      )
      await writeRaw("[DONE]")
      break
    }
    default: {
      break
    }
  }
}

async function handleBridgeContentDelta(
  event: Extract<AnthropicStreamEventData, { type: "content_block_delta" }>,
  context: BridgeStreamContext,
): Promise<void> {
  const { state, writeChunk } = context

  switch (event.delta.type) {
    case "text_delta": {
      state.responseText += event.delta.text
      await writeChunk({ content: event.delta.text })
      break
    }
    case "input_json_delta": {
      const toolIndex = state.toolIndexByBlockIndex.get(event.index)
      if (toolIndex !== undefined) {
        await writeChunk({
          tool_calls: [
            {
              index: toolIndex,
              function: { arguments: event.delta.partial_json },
            },
          ],
        })
      }
      break
    }
    case "thinking_delta": {
      await writeChunk({ reasoning_text: event.delta.thinking })
      break
    }
    // No default
  }
}
