import type {
  EvaluatedEndpointCandidate,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type { ReasoningEffort } from "~/lib/model-suffix"
import type {
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import {
  createEvaluatedTranslationCheck,
  getModelEndpointSupport,
} from "~/lib/endpoint-routing"
import { usesImplicitReasoningDefault } from "~/lib/model-suffix"
import {
  isAnthropicTextBlock,
  isAnthropicToolResultBlock,
} from "~/routes/messages/anthropic-types"
import { rewriteUnsupportedAssistantPrefill } from "~/services/copilot/create-chat-completions"
import {
  COPILOT_RESPONSES_MIN_OUTPUT_TOKENS,
  normalizeJsonSchemaResponseFormat,
} from "~/services/copilot/responses-contract"

import {
  normalizeAnthropicAttachments,
  normalizeAnthropicImages,
} from "./attachment-normalization"
import { prepareNativeTools } from "./native-handler"
import { translateToOpenAI } from "./non-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "./responses-translation"

export type MessagesNativeCandidate = EvaluatedEndpointCandidate<
  "/v1/messages",
  AnthropicMessagesPayload
>
export type MessagesResponsesCandidate = EvaluatedEndpointCandidate<
  "/responses",
  ResponsesPayload
>
export type MessagesChatCandidate = EvaluatedEndpointCandidate<
  "/chat/completions",
  ChatCompletionsPayload
>
export type MessagesEndpointCandidate =
  | MessagesNativeCandidate
  | MessagesResponsesCandidate
  | MessagesChatCandidate

export interface PreparedMessagesCandidates {
  readonly native: MessagesNativeCandidate
  readonly responses?: MessagesResponsesCandidate
  readonly chat?: MessagesChatCandidate
  readonly ordered: ReadonlyArray<MessagesEndpointCandidate>
}

export interface PrepareMessagesCandidatesOptions {
  readonly source: AnthropicMessagesPayload
  readonly selectedModel: Model | undefined
  readonly effortOverride?: ReasoningEffort
  readonly isCompact?: boolean
  readonly signal?: AbortSignal
}

function hasMeaningfulMessages(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.length > 0
}

function createCandidate<
  Endpoint extends MessagesEndpointCandidate["endpoint"],
  Payload,
>(options: {
  endpoint: Endpoint
  payload: Payload
  findings?: ReadonlyArray<TranslationFinding>
  meaningful: boolean
}): EvaluatedEndpointCandidate<Endpoint, Payload> {
  const findings = [...(options.findings ?? [])]
  if (!options.meaningful) {
    findings.push({ class: "message_shape", severity: "fatal" })
  }
  return {
    endpoint: options.endpoint,
    reason: "endpoint_unavailable",
    payload: options.payload,
    check: createEvaluatedTranslationCheck(findings),
  }
}

function adaptMessagesToChat(options: {
  source: AnthropicMessagesPayload
  effortOverride?: ReasoningEffort
}): MessagesChatCandidate {
  const source = structuredClone(options.source)
  mergeToolResultForCandidate(source)
  const payload = translateToOpenAI(source)
  if (source.temperature === undefined) delete payload.temperature
  if (source.top_p === undefined) delete payload.top_p
  if (source.stop_sequences === undefined) delete payload.stop
  if (source.max_tokens === undefined) delete payload.max_tokens
  const findings: Array<TranslationFinding> = []
  const reasoningEnabled = Boolean(options.effortOverride || source.thinking)
  if (reasoningEnabled) {
    payload.temperature = 1
    if (payload.top_p !== undefined) {
      delete payload.top_p
      findings.push({ class: "sampling", severity: "omitted" })
    }
    if (
      options.effortOverride
      && !usesImplicitReasoningDefault(payload.model)
    ) {
      payload.reasoning_effort = options.effortOverride
    } else {
      delete payload.reasoning_effort
    }
  }
  rewriteUnsupportedAssistantPrefill(payload)
  const usesWebSearch = payload.tools?.some(
    (tool) => tool.function.name === "web_search",
  )
  if (
    source.tool_choice?.disable_parallel_tool_use === true
    || usesWebSearch === true
  ) {
    payload.parallel_tool_calls = false
  } else {
    delete payload.parallel_tool_calls
  }
  return createCandidate({
    endpoint: "/chat/completions",
    payload,
    findings,
    meaningful: payload.messages.length > 0,
  })
}

function mergeToolResultForCandidate(payload: AnthropicMessagesPayload): void {
  for (const message of payload.messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue
    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let supported = true
    for (const block of message.content) {
      if (isAnthropicToolResultBlock(block)) {
        toolResults.push(block)
      } else if (isAnthropicTextBlock(block)) {
        textBlocks.push(block)
      } else {
        supported = false
      }
    }
    if (toolResults.length === 0 || textBlocks.length === 0) continue
    if (!supported) continue
    const text = textBlocks.map((block) => block.text).join("\n\n")
    const last = toolResults.length - 1
    const mergedToolResults: Array<AnthropicToolResultBlock> = []
    for (const [index, block] of toolResults.entries()) {
      if (index !== last) {
        mergedToolResults.push(block)
        continue
      }
      const merged: AnthropicToolResultBlock = {
        ...block,
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content:
          typeof block.content === "string" ?
            `${block.content}\n\n${text}`
          : textBlocks,
      }
      mergedToolResults.push(merged)
    }
    const mergedContent: Array<AnthropicUserContentBlock> = mergedToolResults
    message.content = mergedContent
  }
}

function adaptMessagesToResponses(options: {
  source: AnthropicMessagesPayload
  effortOverride?: ReasoningEffort
}): MessagesResponsesCandidate {
  const source = structuredClone(options.source)
  const payload = translateAnthropicMessagesToResponsesPayload(
    source,
    options.effortOverride,
  )
  if (
    typeof payload.max_output_tokens === "number"
    && payload.max_output_tokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    payload.max_output_tokens = COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  }
  normalizeJsonSchemaResponseFormat(payload)
  const findings: Array<TranslationFinding> = []
  if (source.stop_sequences !== undefined) {
    findings.push({ class: "sampling", severity: "omitted" })
  }
  const reasoningEnabled = Boolean(options.effortOverride || source.thinking)
  if (reasoningEnabled) {
    payload.temperature = 1
    if (payload.top_p !== undefined) {
      delete payload.top_p
      findings.push({ class: "sampling", severity: "omitted" })
    }
  } else {
    payload.temperature = source.temperature
    payload.top_p = source.top_p
  }
  const usesWebSearch = payload.tools?.some(
    (tool) =>
      (tool as { name?: string; type?: string }).name === "web_search"
      || (tool as { type?: string }).type === "web_search",
  )
  if (
    source.tool_choice?.disable_parallel_tool_use === true
    || usesWebSearch === true
  ) {
    payload.parallel_tool_calls = false
  } else {
    delete payload.parallel_tool_calls
  }
  return createCandidate({
    endpoint: "/responses",
    payload,
    findings,
    meaningful:
      (Array.isArray(payload.input) && payload.input.length > 0)
      || Boolean(payload.instructions),
  })
}

export async function prepareMessagesChatCandidate(options: {
  readonly source: AnthropicMessagesPayload
  readonly effortOverride?: ReasoningEffort
  readonly signal?: AbortSignal
}): Promise<MessagesChatCandidate> {
  const source = structuredClone(options.source)
  await normalizeAnthropicAttachments(source, options.signal)
  return adaptMessagesToChat({
    source,
    effortOverride: options.effortOverride,
  })
}

// eslint-disable-next-line complexity -- candidate capability branches are explicit
export async function prepareMessagesCandidates(
  options: PrepareMessagesCandidatesOptions,
): Promise<PreparedMessagesCandidates> {
  const support = getModelEndpointSupport(options.selectedModel)
  const nativePayload = structuredClone(options.source)
  if (support.messages) {
    await normalizeAnthropicImages(nativePayload, options.signal)
  }
  const finalizedNative = prepareNativeTools(nativePayload).payload
  if (
    finalizedNative.max_tokens === undefined
    && Number.isInteger(
      options.selectedModel?.capabilities.limits?.max_output_tokens,
    )
    && Number(options.selectedModel?.capabilities.limits?.max_output_tokens) > 0
  ) {
    finalizedNative.max_tokens = Number(
      options.selectedModel?.capabilities.limits?.max_output_tokens,
    )
  }
  const translatedPayload = structuredClone(
    support.messages ? nativePayload : options.source,
  )
  if (support.responses || support.chat) {
    await normalizeAnthropicAttachments(translatedPayload, options.signal)
  }
  const native = createCandidate({
    endpoint: "/v1/messages",
    payload: finalizedNative,
    meaningful: hasMeaningfulMessages(options.source),
  })
  const responses =
    support.responses ?
      adaptMessagesToResponses({
        source: translatedPayload,
        effortOverride: options.effortOverride,
      })
    : undefined
  const chat =
    support.chat ?
      adaptMessagesToChat({
        source: translatedPayload,
        effortOverride: options.effortOverride,
      })
    : undefined
  const ordered: Array<MessagesEndpointCandidate> = []
  if (support.messages) ordered.push(native)
  if (responses) ordered.push(responses)
  if (chat) ordered.push(chat)
  return { native, responses, chat, ordered }
}
