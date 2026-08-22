import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTextBlock,
  AnthropicToolResultContentBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type { AnthropicStreamChunk } from "~/services/copilot/create-anthropic-messages"
import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { inspectHttpError, isAbortError, isHTTPError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { setRequestContext } from "~/lib/request-logger"
import {
  createSentryChatSpanOptions,
  setSentryOutputMessages,
} from "~/lib/sentry"
import { withSseHeartbeat } from "~/lib/sse-lifecycle"
import {
  isAnthropicToolResultBlock,
  isAnthropicToolUseBlock,
} from "~/routes/messages/anthropic-types"
import {
  createNativeMessages,
  type NativeMessagesRequestOptions,
  resolveNativeWebSearch,
} from "~/routes/messages/native-handler"
import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  convertOpenAIContentPartToAnthropic,
  convertOpenAIToolsToAnthropic,
} from "./anthropic-conversion"
import {
  applyParallelToolChoice,
  convertChatReasoningOptions,
  createAssistantBlocks,
  getAnthropicReasoning,
} from "./anthropic-reasoning"
import { normalizeChatCompletionsRequest } from "./chat-contract"
import { createChatStreamTerminalAdapter } from "./stream-lifecycle"

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
    nativeOptions: NativeMessagesRequestOptions
    payload: ChatCompletionsPayload & { model: string }
    preparedPayload?: AnthropicMessagesPayload
    selectedModel?: Model
  },
): Promise<Response> {
  const { nativeOptions, payload, selectedModel } = options
  const requestedModel = nativeOptions.requestedModel ?? payload.model

  setRequestContext(c, { provider: "ChatCompletions→AnthropicMessages" })

  const anthropicPayload =
    options.preparedPayload
    ?? (await chatPayloadToAnthropic(payload, selectedModel, c.req.raw.signal))
  const alreadyAdapted = options.preparedPayload !== undefined
  logger.debug("Prepared Anthropic bridge request", {
    messageCount: anthropicPayload.messages.length,
    model: anthropicPayload.model,
    stream: Boolean(anthropicPayload.stream),
    toolCount: anthropicPayload.tools?.length ?? 0,
  })

  if (anthropicPayload.tools?.some((tool) => tool.name === "web_search")) {
    return await executeBridgeWebSearch(c, {
      payload,
      anthropicPayload,
      nativeOptions,
    })
  }

  if (!anthropicPayload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: payload.model,
      }),
      async (span) => {
        const response = (await createNativeMessages(
          anthropicPayload,
          nativeOptions,
          {
            alreadyAdapted,
            signal: c.req.raw.signal,
          },
        )) as AnthropicResponse

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
    alreadyAdapted,
    payload,
    anthropicPayload,
    nativeOptions,
  })
}

async function executeBridgeWebSearch(
  c: Context,
  options: {
    payload: ChatCompletionsPayload & { model: string }
    anthropicPayload: AnthropicMessagesPayload
    nativeOptions: NativeMessagesRequestOptions
  },
): Promise<Response> {
  const requestedStream = Boolean(options.anthropicPayload.stream)
  const bufferedPayload = structuredClone(options.anthropicPayload)
  bufferedPayload.stream = false
  const response = await resolveNativeWebSearch(bufferedPayload, {
    ...options.nativeOptions,
    signal: c.req.raw.signal,
  })
  recordAccountContext(c)
  const result = anthropicResponseToChat(
    response,
    options.nativeOptions.requestedModel ?? options.payload.model,
  )

  if (!requestedStream) return c.json(result)
  return streamSSE(c, async (stream) => {
    const adapter = createChatStreamTerminalAdapter({ c, stream })
    stream.onAbort(() => {
      adapter.abort()
    })
    try {
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
      await adapter.succeedAfterFinalChunk()
    } catch (error) {
      if (isAbortError(error)) {
        adapter.abort()
        return
      }
      await adapter.failAfterCommit({
        kind: "thrown",
        error,
        ...(isHTTPError(error) ?
          { inspection: await inspectHttpError(error) }
        : {}),
      })
    }
  })
}

async function executeBridgeStreaming(
  c: Context,
  options: {
    payload: ChatCompletionsPayload & { model: string }
    anthropicPayload: AnthropicMessagesPayload
    alreadyAdapted?: boolean
    nativeOptions: NativeMessagesRequestOptions
  },
): Promise<Response> {
  const { payload, anthropicPayload, nativeOptions } = options
  const requestedModel = nativeOptions.requestedModel ?? payload.model

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
        const response = (await createNativeMessages(
          anthropicPayload,
          nativeOptions,
          {
            alreadyAdapted: options.alreadyAdapted,
            signal: c.req.raw.signal,
          },
        )) as AsyncIterable<AnthropicStreamChunk>

        recordAccountContext(c)

        return streamSSE(c, async (stream) => {
          const adapter = createChatStreamTerminalAdapter({ c, stream })
          stream.onAbort(() => {
            adapter.abort()
          })
          try {
            const usage = await streamAnthropicAsChatCompletions(
              stream,
              withSseHeartbeat(response, stream),
              requestedModel,
            )
            if (usage.receivedFailure) {
              await adapter.failReceived(usage.receivedFailure)
            } else if (usage.terminalSeen) {
              await adapter.succeedAfterFinalChunk()
            } else {
              await adapter.finishSource()
            }
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
            if (isAbortError(error)) {
              adapter.abort()
              return
            }
            await adapter.failAfterCommit({
              kind: "thrown",
              error,
              ...(isHTTPError(error) ?
                { inspection: await inspectHttpError(error) }
              : {}),
            })
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

  const { systemTexts, messages } = await convertChatMessages(
    normalized.messages,
    signal,
  )

  const hasMaxTokens = Object.hasOwn(normalized, "max_tokens")
  const hasMaxCompletionTokens = Object.hasOwn(
    normalized,
    "max_completion_tokens",
  )
  const maxTokens = resolveBridgeMaxTokens({
    hasMaxCompletionTokens,
    hasMaxTokens,
    normalized,
    selectedModel,
  })
  const toolChoice = convertToolChoice(normalized.tool_choice)
  const parallelChoice = applyParallelToolChoice(
    toolChoice,
    normalized.parallel_tool_calls,
    normalized.tools,
  )

  return {
    model: normalized.model,
    messages,
    ...maxTokens,
    ...(systemTexts.length > 0 ? { system: systemTexts.join("\n\n") } : {}),
    ...convertSamplingOptions(normalized),
    ...(normalized.stream ? { stream: true } : {}),
    ...(normalized.user ? { metadata: { user_id: normalized.user } } : {}),
    ...convertOpenAIToolsToAnthropic(normalized.tools),
    ...parallelChoice,
    ...convertChatReasoningOptions(normalized),
  }
}

function resolveBridgeMaxTokens(options: {
  hasMaxCompletionTokens: boolean
  hasMaxTokens: boolean
  normalized: ChatCompletionsPayload & { model: string }
  selectedModel?: Model
}): Pick<AnthropicMessagesPayload, "max_tokens"> | Record<never, never> {
  if (options.hasMaxCompletionTokens) {
    return { max_tokens: options.normalized.max_completion_tokens }
  }
  if (options.hasMaxTokens) {
    return { max_tokens: options.normalized.max_tokens }
  }
  const maxTokens =
    options.selectedModel?.capabilities.limits?.max_output_tokens
  if (maxTokens === undefined) return {}
  return { max_tokens: maxTokens }
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
    ...((
      payload.temperature === undefined
      && payload.top_p !== undefined
      && payload.top_p !== null
    ) ?
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
    blocks.push(...(await convertOpenAIContentPartToAnthropic(part, signal)))
  }
  return blocks
}

async function convertToolResultContent(
  content: Message["content"],
  signal?: AbortSignal,
): Promise<AnthropicToolResultBlock["content"]> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const blocks: Array<AnthropicToolResultContentBlock> = []
  for (const part of content) {
    const converted = await convertOpenAIContentPartToAnthropic(part, signal)
    blocks.push(
      ...converted.filter(
        (
          block,
        ): block is Exclude<
          AnthropicUserContentBlock,
          AnthropicToolResultBlock
        > => !isAnthropicToolResultBlock(block),
      ),
    )
  }
  return blocks
}

function safeParseArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return { raw_arguments: rawArguments }
  }
  return { raw_arguments: rawArguments }
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
    .filter((block) => isAnthropicToolUseBlock(block))
    .map((toolUse) => {
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
    case "pause_turn": {
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
  anthropicStopReason: AnthropicResponse["stop_reason"]
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null
  signatureByBlockIndex: Map<number, string>
  terminalSeen: boolean
}

type WriteBridgeChunk = (
  delta: ChatCompletionChunk["choices"][number]["delta"],
  options?: {
    finishReason?: BridgeStreamState["finishReason"]
    usage?: ChatCompletionChunk["usage"]
    copilotStopReason?: "pause_turn"
  },
) => Promise<void>

interface BridgeStreamContext {
  state: BridgeStreamState
  writeChunk: WriteBridgeChunk
}

export async function streamAnthropicAsChatCompletions(
  stream: { writeSSE: (data: { data: string }) => Promise<void> },
  response: AsyncIterable<AnthropicStreamChunk>,
  requestedModel: string,
): Promise<{
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  receivedFailure?: unknown
  responseText: string
  terminalSeen: boolean
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
    anthropicStopReason: null,
    finishReason: null,
    signatureByBlockIndex: new Map(),
    terminalSeen: false,
  }

  const writeChunk: WriteBridgeChunk = async (delta, options) => {
    const chunk: ChatCompletionChunk & {
      copilot_stop_reason?: "pause_turn"
    } = {
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
      ...(options?.copilotStopReason ?
        { copilot_stop_reason: options.copilotStopReason }
      : {}),
    }
    await stream.writeSSE({ data: JSON.stringify(chunk) })
  }

  const context: BridgeStreamContext = {
    state,
    writeChunk,
  }

  let receivedFailure: unknown

  for await (const chunk of response) {
    if (state.terminalSeen || receivedFailure !== undefined) break
    if (!chunk.data || chunk.data.trim() === "[DONE]") continue

    const event = JSON.parse(chunk.data) as AnthropicStreamEventData

    receivedFailure = await handleBridgeStreamEvent(event, context)
    if (event.type === "message_stop" || event.type === "error") break
  }

  return {
    inputTokens: state.inputTokens + state.cachedTokens,
    outputTokens: state.outputTokens,
    cachedTokens: state.cachedTokens,
    ...(receivedFailure === undefined ? {} : { receivedFailure }),
    responseText: state.responseText,
    terminalSeen: state.terminalSeen,
  }
}

async function handleBridgeStreamEvent(
  event: AnthropicStreamEventData,
  context: BridgeStreamContext,
): Promise<unknown> {
  const { state, writeChunk } = context

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
        state.anthropicStopReason = event.delta.stop_reason
        state.finishReason = mapStopReason(event.delta.stop_reason)
      }
      break
    }
    case "message_stop": {
      if (state.terminalSeen) break
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
          ...(state.anthropicStopReason === "pause_turn" ?
            { copilotStopReason: "pause_turn" }
          : {}),
        },
      )
      state.terminalSeen = true
      break
    }
    case "error": {
      logger.warn("Native messages stream failed")
      return event.error
    }
    default: {
      break
    }
  }
  return undefined
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
    case "signature_delta": {
      const signature =
        (state.signatureByBlockIndex.get(event.index) ?? "")
        + event.delta.signature
      state.signatureByBlockIndex.set(event.index, signature)
      await writeChunk({ reasoning_opaque: signature })
      break
    }
    case "thinking_delta": {
      await writeChunk({ reasoning_text: event.delta.thinking })
      break
    }
    // No default
  }
}
