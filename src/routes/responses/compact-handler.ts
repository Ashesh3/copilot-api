import type { Context } from "hono"

import consola from "consola"
import { randomUUID } from "node:crypto"

import { createHandlerLogger } from "~/lib/logger"
import { parseModelSuffix } from "~/lib/model-suffix"
import { setRequestContext } from "~/lib/request-logger"
import { installResponsesRoutingAffinity } from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import {
  type CompactionPayloadFitResult,
  fitResponsesCompactionPayload,
} from "~/services/copilot/compaction-payload"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  createChatCompletions,
} from "~/services/copilot/create-chat-completions"
import {
  type ResponseInputItem,
  type ResponseUsage,
  type ResponsesPayload,
  type ResponsesResult,
  createResponses,
} from "~/services/copilot/create-responses"

import { getCompactionPrompt } from "./compact-prompt"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("compact-handler")

const RESPONSES_ENDPOINT = "/responses"

interface CompactRequestBody {
  model: string
  input: Array<ResponseInputItem>
  instructions?: string
  client_metadata?: Record<string, unknown> | string
  previous_response_id?: string
  prompt_cache_key?: string
}

interface CompactionItem {
  id: string
  type: "compaction"
  encrypted_content: string
}

interface CompactedResponse {
  id: string
  object: "response.compaction"
  created_at: number
  output: Array<CompactionItem>
  usage: ResponseUsage | null
}

/**
 * Extract text output from a Responses API result.
 */
const extractTextFromResponsesResult = (result: ResponsesResult): string => {
  for (const item of result.output) {
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        const outputBlock = block as { type?: string; text?: string }
        if (outputBlock.type === "output_text" && outputBlock.text) {
          return outputBlock.text
        }
      }
    }
  }
  return result.output_text
}

/**
 * Extract text output from a ChatCompletions response.
 */
const extractTextFromCCResult = (result: ChatCompletionResponse): string => {
  const choice = result.choices[0]
  return choice.message.content ?? ""
}

/**
 * Map ChatCompletions usage to ResponseUsage format.
 */
const mapCCUsage = (
  usage: ChatCompletionResponse["usage"],
): ResponseUsage | null => {
  if (!usage) return null
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

/**
 * Build the final CompactedResponse from summary text and usage data.
 */
const buildCompactedResponse = (
  summaryText: string,
  usage: ResponseUsage | null,
): CompactedResponse => {
  const encoded = Buffer.from(summaryText, "utf8").toString("base64")

  return {
    id: `resp_compact_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [
      {
        id: `cmp_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "compaction",
        encrypted_content: encoded,
      },
    ],
    usage,
  }
}

/**
 * Convert ResponseInputItems to ChatCompletions messages for the fallback path.
 */
const convertInputToMessages = (
  input: Array<ResponseInputItem>,
): ChatCompletionsPayload["messages"] => {
  const messages: ChatCompletionsPayload["messages"] = []

  for (const item of input) {
    const itemType = (item as { type?: string }).type
    if (!itemType || itemType === "message") {
      const msg = item as {
        role: "user" | "assistant" | "system" | "developer"
        content?: string | Array<{ type?: string; text?: string }>
      }
      const role = msg.role === "developer" ? "system" : msg.role
      let content = ""
      if (typeof msg.content === "string") {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("")
      }
      messages.push({ role, content })
    } else {
      convertSpecialItem(messages, itemType, item)
    }
  }

  return messages
}

const convertSpecialItem = (
  messages: ChatCompletionsPayload["messages"],
  itemType: string,
  item: ResponseInputItem,
): void => {
  switch (itemType) {
    case "custom_tool_call": {
      const call = item as {
        call_id?: string
        input?: string
        name?: string
      }
      messages.push({
        role: "assistant",
        content:
          `[Custom tool call ${call.call_id ?? "unknown"}: `
          + `${call.name ?? "unknown"}(${call.input ?? ""})]`,
      })
      break
    }
    case "custom_tool_call_output": {
      const output = item as { call_id?: string; output?: unknown }
      messages.push({
        role: "user",
        content:
          `[Custom tool result ${output.call_id ?? "unknown"}: `
          + `${stringifyToolOutput(output.output)}]`,
      })
      break
    }
    case "function_call": {
      const fc = item as {
        call_id?: string
        name?: string
        arguments?: string
      }
      messages.push({
        role: "assistant",
        content:
          `[Tool call ${fc.call_id ?? "unknown"}: `
          + `${fc.name ?? "unknown"}(${fc.arguments ?? ""})]`,
      })
      break
    }
    case "function_call_output": {
      const fco = item as { call_id?: string; output?: string }
      const output = stringifyToolOutput(fco.output)
      messages.push({
        role: "user",
        content: `[Tool result ${fco.call_id ?? "unknown"}: ${output}]`,
      })
      break
    }
    case "reasoning": {
      const reasoning = item as {
        summary?: Array<{ text?: string }>
      }
      const text = reasoning.summary
        ?.map((s) => s.text ?? "")
        .filter(Boolean)
        .join("\n")
      if (text) {
        messages.push({
          role: "assistant",
          content: `[Thinking: ${text}]`,
        })
      }
      break
    }
    // No default
  }
}

const stringifyToolOutput = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output)

const reportCompactionReduction = (
  message: string,
  fitted: CompactionPayloadFitResult<ResponsesPayload>,
): void => {
  if (!fitted.reduced) return
  consola.warn(message, {
    originalBytes: fitted.originalBytes,
    finalBytes: fitted.finalBytes,
    omittedBinaryBlocks: fitted.omittedBinaryBlocks,
    truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
  })
}

export const handleCompact = async (c: Context) => {
  const body = await c.req.json<CompactRequestBody>()
  installResponsesRoutingAffinity(body.client_metadata)

  const { baseModel } = parseModelSuffix(body.model)
  const model = baseModel

  setRequestContext(c, {
    requestedModel: body.model,
    provider: "Compact",
    model,
  })
  logger.debug("Compact request for model:", model)

  // Build the compaction payload — send conversation to model with compaction prompt
  const compactionPrompt = getCompactionPrompt()
  const compactionUserMessage: ResponseInputItem = {
    type: "message",
    role: "user",
    content: "Please summarize the conversation above concisely.",
  }

  const input: Array<ResponseInputItem> = [
    ...(Array.isArray(body.input) ? body.input : []),
    compactionUserMessage,
  ]

  // Expand any previous compaction items so the upstream API doesn't
  // try to decrypt our fake base64 encrypted_content
  const tempPayload = { input, model } as ResponsesPayload
  expandCompactionItems(tempPayload)
  const expandedInput = tempPayload.input as Array<ResponseInputItem>
  const responsesPayload: ResponsesPayload = {
    model,
    instructions: compactionPrompt,
    input: expandedInput,
    stream: false,
    tool_choice: "none",
    store: false,
  }
  // Check if the model supports native /responses
  const selectedModel = state.models?.data.find((m) => m.id === model)
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  let summaryText: string
  let usage: ResponseUsage | null

  if (supportsResponses) {
    // Use native Responses API
    const fitted = fitResponsesCompactionPayload(responsesPayload)
    const fittedPayload = fitted.payload
    reportCompactionReduction(
      "Reduced oversized compact summary payload",
      fitted,
    )
    const { vision, initiator } = getResponsesRequestOptions(fittedPayload)
    const response = await createResponses(fittedPayload, {
      vision,
      initiator,
      signal: c.req.raw.signal,
      compaction: true,
    })

    const result = response as ResponsesResult
    summaryText = extractTextFromResponsesResult(result)
    usage = result.usage ?? null

    logger.debug("Compact Responses result received")
  } else {
    // Fall back to ChatCompletions
    consola.debug(
      `[compact] Model ${model} does not support /responses, falling back to ChatCompletions`,
    )
    setRequestContext(c, { provider: "Compact→ChatCompletions" })
    const ccPayload: ChatCompletionsPayload = {
      model,
      messages: [
        { role: "system", content: compactionPrompt },
        ...convertInputToMessages(expandedInput),
      ],
      stream: false,
      temperature: 0,
    }

    const response = await createChatCompletions(ccPayload, {
      compaction: true,
      signal: c.req.raw.signal,
    })
    const result = response as ChatCompletionResponse
    summaryText = extractTextFromCCResult(result)
    usage = mapCCUsage(result.usage)

    logger.debug("Compact ChatCompletions result received")
  }

  if (usage) {
    setRequestContext(c, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    })
  }

  const compactedResponse = buildCompactedResponse(summaryText, usage)
  return c.json(compactedResponse)
}
