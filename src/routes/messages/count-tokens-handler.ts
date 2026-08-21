import type { Context } from "hono"

import consola from "consola"

import {
  recordCopilotMessagesBeta,
  recordCopilotRequestNormalization,
} from "~/lib/copilot-contract-observability"
import {
  resolveCustomProviderModel,
  type CustomProviderModelReference,
} from "~/lib/custom-providers"
import { LocalHTTPError } from "~/lib/error"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  normalizeReasoningEffortForModel,
  parseModelSuffix,
} from "~/lib/model-suffix"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import {
  installRoutingAffinityFallback,
  resolveClaudeRoutingAffinity,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { estimateTokenCount } from "~/lib/tokenizer"
import { countAnthropicTokens } from "~/services/copilot/count-anthropic-tokens"
import {
  createInvalidAnthropicMessagesJsonError,
  prepareAnthropicMessagesRequest,
  validateAnthropicRequestHeaderOptions,
} from "~/services/copilot/messages-contract"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages.
 */
export async function handleCountTokens(c: Context) {
  let rawPayload: AnthropicMessagesPayload
  try {
    rawPayload = await c.req.json<AnthropicMessagesPayload>()
  } catch {
    throw createInvalidAnthropicMessagesJsonError()
  }
  const anthropicPayload = prepareAnthropicMessagesRequest({
    payload: rawPayload,
  })
  const nativeHeaders = validateAnthropicRequestHeaderOptions({
    anthropicBeta: c.req.header("anthropic-beta"),
    anthropicVersion: c.req.header("anthropic-version"),
    modelProviderPreference: c.req.header("x-model-provider-preference"),
  })
  recordCopilotRequestNormalization(
    "messages",
    anthropicPayload.normalizationClasses,
  )
  recordCopilotMessagesBeta(nativeHeaders.anthropicBeta)
  installRoutingAffinityFallback(
    resolveClaudeRoutingAffinity(anthropicPayload.body.metadata),
  )
  const requestedModel = anthropicPayload.body.model

  const { baseModel, reasoningEffort: suffixEffort } =
    parseModelSuffix(requestedModel)
  const normalizedModel = normalizeModelName(baseModel)
  const requestedEffort = normalizeReasoningEffortForModel(
    normalizedModel,
    suffixEffort,
  )
  const redirect = await applyModelRedirect({
    model: normalizedModel,
    effort: requestedEffort,
  })
  reportCountTokensRedirect(c, {
    sourceModel: normalizedModel,
    sourceEffort: requestedEffort,
    redirect,
  })
  const targetModel = normalizeModelName(redirect.model)
  const targetEffort = normalizeReasoningEffortForModel(
    targetModel,
    redirect.effort,
  )
  anthropicPayload.body.model = targetModel

  setRequestContext(c, {
    requestedModel,
    model: targetModel,
    provider: "TokenCount",
    reasoningEffort: targetEffort,
  })
  const customReference = resolveCustomCountModel(targetModel)
  if (customReference) {
    return await countCustomProviderTokens(c, {
      anthropicPayload: anthropicPayload.body,
      customReference,
      requestedModel,
      targetEffort,
    })
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === targetModel,
  )
  if (!selectedModel) throw createCountTokensModelNotFoundError()

  const result = await countAnthropicTokens(anthropicPayload.body, {
    ...nativeHeaders,
    preserveValidatedControls: true,
    signal: c.req.raw.signal,
  })

  setRequestContext(c, { inputTokens: result.input_tokens })
  consola.info(`Token count: ${result.input_tokens} (${requestedModel})`)
  return c.json(result)
}

function resolveCustomCountModel(
  model: string,
): CustomProviderModelReference | undefined {
  return resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds: new Set(state.models?.data.map((entry) => entry.id) ?? []),
  })
}

async function countCustomProviderTokens(
  c: Context,
  options: {
    anthropicPayload: AnthropicMessagesPayload
    customReference: CustomProviderModelReference
    requestedModel: string
    targetEffort: ReturnType<typeof normalizeReasoningEffortForModel>
  },
) {
  const { anthropicPayload, customReference, requestedModel, targetEffort } =
    options
  setRequestContext(c, {
    requestedModel,
    model: customReference.upstreamModel,
    provider: customReference.provider.name,
    reasoningEffort: targetEffort,
  })
  const inputTokens = await estimateTokenCount(
    translateToOpenAI(anthropicPayload),
  )
  setRequestContext(c, { inputTokens })
  consola.info(`Token count: ${inputTokens} (${requestedModel})`)
  return c.json({ input_tokens: inputTokens })
}

function createCountTokensModelNotFoundError(): LocalHTTPError {
  const clientBody = {
    type: "error",
    error: {
      type: "not_found_error",
      code: "model_not_found",
      message: "The requested Copilot Messages model was not found.",
      param: "model",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 404 }),
    clientBody,
  )
}

function reportCountTokensRedirect(
  c: Context,
  options: {
    sourceModel: string
    sourceEffort: ReturnType<typeof normalizeReasoningEffortForModel>
    redirect: Awaited<ReturnType<typeof applyModelRedirect>>
  },
): void {
  if (!options.redirect.redirected) return
  recordNonDefaultBehavior(c, {
    kind: "model_redirect",
    message: `Model redirect chain: ${formatModelRedirectResult(options.redirect)}`,
    data: {
      sourceModel: options.sourceModel,
      sourceEffort: options.sourceEffort,
      targetModel: options.redirect.model,
      targetEffort: options.redirect.effort,
      ruleId: options.redirect.ruleId,
      ruleIds: options.redirect.ruleIds?.join(","),
    },
  })
}
