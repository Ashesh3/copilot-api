import type {
  EvaluatedEndpointCandidate,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type { ModelRedirectVerbosity } from "~/lib/model-redirect"
import type { ReasoningEffort } from "~/lib/model-suffix"
import type {
  AnthropicMessagesPayload,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
  AnthropicToolUseBlock,
} from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import { createAttachmentFetchResolver } from "~/lib/attachments"
import {
  createEvaluatedTranslationCheck,
  getModelEndpointSupport,
} from "~/lib/endpoint-routing"
import { normalizeModelName } from "~/lib/model-resolver"
import { usesImplicitReasoningDefault } from "~/lib/model-suffix"
import {
  isAnthropicTextBlock,
  isAnthropicToolResultBlock,
  isAnthropicToolUseBlock,
} from "~/routes/messages/anthropic-types"
import { rewriteUnsupportedAssistantPrefill } from "~/services/copilot/create-chat-completions"
import { isWebSearchToolType } from "~/services/copilot/mcp-web-search"
import {
  COPILOT_RESPONSES_MIN_OUTPUT_TOKENS,
  normalizeJsonSchemaResponseFormat,
} from "~/services/copilot/responses-contract"

import {
  type AnthropicAttachmentResolver,
  normalizeAnthropicAttachments,
  normalizeAnthropicImages,
} from "./attachment-normalization"
import { prepareNativeTools } from "./native-handler"
import {
  hasUnrepresentableChatThinkingHistory,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "./responses-translation"

export type MessagesNativeCandidate = EvaluatedEndpointCandidate<
  "/v1/messages",
  AnthropicMessagesPayload
>
export interface MessagesResponsesCandidate
  extends EvaluatedEndpointCandidate<"/responses", ResponsesPayload> {
  readonly webSearchMaxUses?: number
}
export interface MessagesChatCandidate
  extends EvaluatedEndpointCandidate<
    "/chat/completions",
    ChatCompletionsPayload
  > {
  readonly webSearchMaxUses?: number
}
export type MessagesEndpointCandidate =
  | PreparedMessagesNativeCandidate
  | MessagesResponsesCandidate
  | MessagesChatCandidate

export interface PreparedMessagesCandidates {
  readonly native: PreparedMessagesNativeCandidate
  readonly responses?: MessagesResponsesCandidate
  readonly chat?: MessagesChatCandidate
  readonly ordered: ReadonlyArray<MessagesEndpointCandidate>
}

export interface PreparedMessagesNativeCandidate
  extends MessagesNativeCandidate {
  readonly compaction: boolean
}

const ORPHAN_TOOL_RESULT_PREFIX = "[Orphaned tool result]"
const ORPHAN_TOOL_RESULT_MAX_CHARS = 16_384
const UNSERIALIZABLE_ORPHAN_TOOL_RESULT = "[Unserializable content]"

function serializeOrphanToolResult(
  content: AnthropicToolResultBlock["content"],
): string {
  if (typeof content === "string") {
    return content.slice(0, ORPHAN_TOOL_RESULT_MAX_CHARS)
  }
  let serialized: string
  try {
    serialized = JSON.stringify(content)
  } catch {
    serialized = UNSERIALIZABLE_ORPHAN_TOOL_RESULT
  }
  return serialized.slice(0, ORPHAN_TOOL_RESULT_MAX_CHARS)
}

export interface PrepareMessagesCandidatesOptions {
  readonly source: AnthropicMessagesPayload
  readonly selectedModel: Model | undefined
  readonly effortOverride?: ReasoningEffort
  readonly responsesVerbosity?: ModelRedirectVerbosity
  readonly isCompact?: boolean
  readonly signal?: AbortSignal
}

function createAttachmentResolver(): AnthropicAttachmentResolver {
  const resolve = createAttachmentFetchResolver()
  return async ({ expectPdf, signal, url }) =>
    await resolve({ expectPdf, signal, value: url })
}

interface ToolHistoryAssociations {
  readonly callIdByBlock: ReadonlyMap<AnthropicToolUseBlock, string>
  readonly resultIdByBlock: ReadonlyMap<AnthropicToolResultBlock, string>
  readonly adapted: boolean
  readonly orphaned: boolean
}

interface MutableToolHistoryState {
  readonly callIdByBlock: Map<AnthropicToolUseBlock, string>
  readonly pending: Map<string, Array<string>>
  readonly reserved: Set<string>
  readonly resultIdByBlock: Map<AnthropicToolResultBlock, string>
  readonly used: Set<string>
  adapted: boolean
  orphaned: boolean
}

function reserveToolHistoryIds(source: AnthropicMessagesPayload): Set<string> {
  const reserved = new Set<string>()
  for (const message of source.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isAnthropicToolUseBlock(block) && block.id.trim())
        reserved.add(block.id)
      if (isAnthropicToolResultBlock(block) && block.tool_use_id.trim()) {
        reserved.add(block.tool_use_id)
      }
    }
  }
  return reserved
}

function allocateToolCallId(options: {
  block: AnthropicToolUseBlock
  blockIndex: number
  messageIndex: number
  state: MutableToolHistoryState
}): void {
  const { block, blockIndex, messageIndex, state } = options
  const sourceId = block.id.trim()
  let targetId = sourceId
  if (!targetId || state.used.has(targetId)) {
    const base = `messages_call_${messageIndex}_${blockIndex}`
    targetId = base
    let suffix = 0
    while (state.reserved.has(targetId) || state.used.has(targetId)) {
      suffix += 1
      targetId = `${base}_${suffix}`
    }
    state.adapted = true
  }
  state.used.add(targetId)
  state.callIdByBlock.set(block, targetId)
  const queue = state.pending.get(sourceId) ?? []
  queue.push(targetId)
  state.pending.set(sourceId, queue)
}

function associateToolResult(
  block: AnthropicToolResultBlock,
  state: MutableToolHistoryState,
): void {
  const targetId = state.pending.get(block.tool_use_id.trim())?.shift()
  if (targetId) state.resultIdByBlock.set(block, targetId)
  else state.orphaned = true
}

function associateToolHistory(
  source: AnthropicMessagesPayload,
): ToolHistoryAssociations {
  const state: MutableToolHistoryState = {
    adapted: false,
    callIdByBlock: new Map(),
    orphaned: false,
    pending: new Map(),
    reserved: reserveToolHistoryIds(source),
    resultIdByBlock: new Map(),
    used: new Set(),
  }
  for (const [messageIndex, message] of source.messages.entries()) {
    if (!Array.isArray(message.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (isAnthropicToolUseBlock(block)) {
        allocateToolCallId({ block, blockIndex, messageIndex, state })
        continue
      }
      if (isAnthropicToolResultBlock(block)) associateToolResult(block, state)
    }
  }
  return {
    adapted: state.adapted,
    callIdByBlock: state.callIdByBlock,
    orphaned: state.orphaned,
    resultIdByBlock: state.resultIdByBlock,
  }
}

function rewriteSourceToolHistoryForTarget(
  source: AnthropicMessagesPayload,
  findings: Array<TranslationFinding>,
): void {
  const associations = associateToolHistory(source)
  for (const message of source.messages) {
    if (!Array.isArray(message.content)) continue
    const content: Array<AnthropicContentBlock> = []
    for (const block of message.content) {
      if (isAnthropicToolUseBlock(block)) {
        const id = associations.callIdByBlock.get(block)
        if (id) content.push({ ...block, id })
        continue
      }
      if (!isAnthropicToolResultBlock(block)) {
        content.push(block)
        continue
      }
      const id = associations.resultIdByBlock.get(block)
      const hasToolReference =
        Array.isArray(block.content)
        && block.content.some((item) => item.type === "tool_reference")
      if (id) {
        content.push({ ...block, tool_use_id: id })
      } else if (hasToolReference) {
        content.push({ type: "text", text: JSON.stringify(block.content) })
      } else {
        content.push({
          type: "text",
          text: `${ORPHAN_TOOL_RESULT_PREFIX}\n${serializeOrphanToolResult(block.content)}`,
        })
      }
    }
    message.content = content
  }
  if (associations.adapted || associations.orphaned) {
    addFinding(findings, { class: "tool_history", severity: "adapted" })
  }
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

// eslint-disable-next-line complexity -- target controls are finalized together
function adaptMessagesToChat(options: {
  source: AnthropicMessagesPayload
  effortOverride?: ReasoningEffort
}): MessagesChatCandidate {
  const source = structuredClone(options.source)
  mergeToolResultForCandidate(source)
  const findings: Array<TranslationFinding> = []
  rewriteSourceToolHistoryForTarget(source, findings)
  const payload = translateToOpenAI(source)
  if (hasUnrepresentableChatThinkingHistory(source.messages)) {
    findings.push({ class: "reasoning_state", severity: "adapted" })
  }
  payload.model = normalizeModelName(payload.model)
  if (source.temperature === undefined) delete payload.temperature
  if (source.top_p === undefined) delete payload.top_p
  if (source.stop_sequences === undefined) delete payload.stop
  if (source.max_tokens === undefined) delete payload.max_tokens
  applyTranslatedToolFindings(source, findings)
  degradeChatFileParts(payload, findings)
  const reasoningEnabled = Boolean(options.effortOverride || source.thinking)
  if (reasoningEnabled) {
    payload.temperature = 1
    if (payload.top_p !== undefined) {
      delete payload.top_p
      findings.push({ class: "sampling", severity: "omitted" })
    }
    if (!usesImplicitReasoningDefault(payload.model)) {
      payload.reasoning_effort = options.effortOverride ?? "medium"
    } else {
      delete payload.reasoning_effort
    }
    if (
      source.thinking?.budget_tokens
      && !usesImplicitReasoningDefault(payload.model)
    ) {
      payload.thinking_budget = source.thinking.budget_tokens
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
  const candidate = createCandidate({
    endpoint: "/chat/completions",
    payload,
    findings,
    meaningful: payload.messages.length > 0,
  })
  const webSearchMaxUses = getMessagesWebSearchMaxUses(source)
  return {
    ...candidate,
    ...(webSearchMaxUses === undefined ? {} : { webSearchMaxUses }),
  }
}

function addFinding(
  findings: Array<TranslationFinding>,
  finding: TranslationFinding,
): void {
  if (
    findings.some(
      (current) =>
        current.class === finding.class
        && current.severity === finding.severity,
    )
  ) {
    return
  }
  findings.push(finding)
}

function applyTranslatedToolFindings(
  source: AnthropicMessagesPayload,
  findings: Array<TranslationFinding>,
): void {
  for (const tool of source.tools ?? []) {
    const type = typeof tool.type === "string" ? tool.type : undefined
    if (type?.startsWith("web_search")) continue
    if (
      typeof tool.name === "string"
      && tool.name.trim()
      && (type === undefined || tool.input_schema !== undefined)
    ) {
      continue
    }
    addFinding(findings, { class: "tool_shape", severity: "omitted" })
  }
}

function degradeChatFileParts(
  payload: ChatCompletionsPayload,
  findings: Array<TranslationFinding>,
): void {
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue
    message.content = message.content.flatMap((part) => {
      if (part.type !== "file") return [part]
      addFinding(findings, { class: "attachment", severity: "omitted" })
      return [{ type: "text" as const, text: "[File attachment unavailable]" }]
    })
  }
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
    if (
      toolResults.some(
        (block) =>
          Array.isArray(block.content)
          && block.content.some((content) => content.type === "tool_reference"),
      )
    ) {
      continue
    }
    const text = textBlocks.map((block) => block.text).join("\n\n")
    const last = toolResults.length - 1
    const mergedToolResults: Array<AnthropicToolResultBlock> = []
    for (const [index, block] of toolResults.entries()) {
      if (index !== last) {
        mergedToolResults.push(block)
        continue
      }
      let mergedContent: AnthropicToolResultBlock["content"] = textBlocks
      if (typeof block.content === "string") {
        mergedContent = `${block.content}\n\n${text}`
      } else if (Array.isArray(block.content)) {
        mergedContent = [...block.content, ...textBlocks]
      }
      const merged: AnthropicToolResultBlock = {
        ...block,
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: mergedContent,
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
  verbosity?: ModelRedirectVerbosity
}): MessagesResponsesCandidate {
  const source = structuredClone(options.source)
  const findings: Array<TranslationFinding> = []
  rewriteSourceToolHistoryForTarget(source, findings)
  const payload = translateAnthropicMessagesToResponsesPayload(
    source,
    options.effortOverride,
  )
  if (options.verbosity) {
    payload.text =
      payload.text ?
        { ...payload.text, verbosity: options.verbosity }
      : { verbosity: options.verbosity }
  }
  if (
    typeof payload.max_output_tokens === "number"
    && payload.max_output_tokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    payload.max_output_tokens = COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  }
  normalizeJsonSchemaResponseFormat(payload)
  applyTranslatedToolFindings(source, findings)
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
  const candidate = createCandidate({
    endpoint: "/responses",
    payload,
    findings,
    meaningful:
      (Array.isArray(payload.input) && payload.input.length > 0)
      || Boolean(payload.instructions),
  })
  const webSearchMaxUses = getMessagesWebSearchMaxUses(source)
  return {
    ...candidate,
    ...(webSearchMaxUses === undefined ? {} : { webSearchMaxUses }),
  }
}

function getMessagesWebSearchMaxUses(
  source: AnthropicMessagesPayload,
): number | undefined {
  let limit: number | undefined
  for (const tool of source.tools ?? []) {
    if (!isWebSearchToolType(tool) && tool.name !== "web_search") continue
    const value = tool.max_uses
    if (!Number.isInteger(value) || Number(value) <= 0) continue
    limit = Math.min(limit ?? Number(value), Number(value))
  }
  return limit
}

export async function prepareMessagesChatCandidate(options: {
  readonly source: AnthropicMessagesPayload
  readonly effortOverride?: ReasoningEffort
  readonly signal?: AbortSignal
}): Promise<MessagesChatCandidate> {
  const source = structuredClone(options.source)
  await normalizeAnthropicAttachments(
    source,
    options.signal,
    createAttachmentResolver(),
  )
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
  const resolveAttachment = createAttachmentResolver()
  const nativePayload = structuredClone(options.source)
  if (support.messages) {
    await normalizeAnthropicImages(
      nativePayload,
      options.signal,
      resolveAttachment,
    )
  }
  const finalizedNative = prepareNativeTools(nativePayload).payload
  if (!options.isCompact) mergeToolResultForCandidate(finalizedNative)
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
  const nativeCandidate = createCandidate({
    endpoint: "/v1/messages",
    payload: finalizedNative,
    meaningful: hasMeaningfulMessages(options.source),
  })
  const native: PreparedMessagesNativeCandidate = {
    ...nativeCandidate,
    compaction: options.isCompact === true,
  }
  const responses =
    support.responses ?
      await (async () => {
        const source = structuredClone(options.source)
        await normalizeAnthropicAttachments(
          source,
          options.signal,
          resolveAttachment,
        )
        return adaptMessagesToResponses({
          source,
          effortOverride: options.effortOverride,
          verbosity: options.responsesVerbosity,
        })
      })()
    : undefined
  const chat =
    support.chat ?
      await (async () => {
        const source = structuredClone(options.source)
        await normalizeAnthropicAttachments(
          source,
          options.signal,
          resolveAttachment,
        )
        return adaptMessagesToChat({
          source,
          effortOverride: options.effortOverride,
        })
      })()
    : undefined
  const ordered: Array<MessagesEndpointCandidate> = []
  if (support.messages) ordered.push(native)
  if (responses) ordered.push(responses)
  if (chat) ordered.push(chat)
  return { native, responses, chat, ordered }
}
