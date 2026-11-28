import { AsyncLocalStorage } from "node:async_hooks"

import type { CopilotInferenceEndpoint } from "~/lib/endpoint-routing"
import type { Model } from "~/services/copilot/get-models"

import {
  runWithRoutedModelSelection,
  selectCatalogRoutedModel,
  usesPooledAccounts,
} from "~/lib/account-router"
import {
  createCustomProviderChatCompletions,
  type CustomProviderModelReference,
  getCustomProviderModels,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import {
  applyModelFallbackToPayload,
  getModelFallbackRedirect,
  runWithModelFallback,
} from "~/lib/model-fallback"
import {
  getLoadedModelRedirects,
  type ModelRedirectRequest,
  type ModelRedirectResult,
  type ModelRedirectVerbosity,
} from "~/lib/model-redirect"
import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"
import { normalizeModelName } from "~/lib/model-resolver"
import { getModelRoutingSafety } from "~/lib/model-routing-safety"
import {
  getModelReasoningConfig,
  parseModelSuffix,
  type ReasoningEffort,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { runAsIndependentRequest } from "~/lib/request-scopes"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import {
  anthropicResponseToChat,
  chatPayloadToAnthropic,
} from "~/routes/chat-completions/anthropic-bridge"
import {
  chatCompletionsToResponses,
  getResponsesResultOutputText,
} from "~/routes/chat-completions/responses-fallback"
import { selectChatUpstreamEndpoint } from "~/routes/chat-completions/responses-fallback-executor"
import { detectInitiator } from "~/services/copilot/copilot-payload-helpers"
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  createChatCompletions,
} from "~/services/copilot/create-chat-completions"
import { createResponses } from "~/services/copilot/create-responses"
import { finalizeResponsesRequest } from "~/services/copilot/responses-contract"

// AI Assist's model: which one a configured ID resolves to, which endpoint it
// is reached through, and the call itself, which Intercept never holds.

const interceptBypassStorage = new AsyncLocalStorage<boolean>()

export function isInterceptBypassed(): boolean {
  return interceptBypassStorage.getStore() === true
}

export function runBypassingIntercept<T>(work: () => T): T {
  return interceptBypassStorage.run(true, work)
}

// --- Destinations -----------------------------------------------------------

/** A requested model ID resolved the way the Chat Completions route does. */
interface AssistantRoute {
  model: string
  effort?: ReasoningEffort
  verbosity?: ModelRedirectVerbosity
}

type AssistantRedirect = (request: ModelRedirectRequest) => ModelRedirectResult

function assistantPayload(
  model: string,
  system: string,
  user: string,
): ChatCompletionsPayload {
  return {
    model,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }
}

function customChatReference(
  model: string,
): CustomProviderModelReference | undefined {
  return resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds: new Set(state.models?.data.map((entry) => entry.id)),
  })
}

/**
 * `applyModelRedirect`, synchronous so the picker lists IDs exactly as a
 * request resolves them: unsafe or looping rule sets redirect nothing.
 */
function createAssistantRedirect(): AssistantRedirect {
  const rules = getModelRoutingSafety().safe ? getLoadedModelRedirects() : []
  return (request) => {
    const result = resolveModelRedirectRules(rules, request)
    return result.loop ?
        {
          model: request.model,
          effort: request.effort,
          verbosity: request.verbosity,
          redirected: false,
        }
      : result
  }
}

const EFFORT_ORDER: ReadonlyArray<ReasoningEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/**
 * `effort` on the model's scale: kept when supported, otherwise the nearest
 * supported level (the lower one on a tie), never the model's default, so a
 * low setting never turns into a slower one. Models without levels keep it.
 */
function clampEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  const supported = getModelReasoningConfig(model)?.supportedEfforts
  if (!effort || !supported?.length || supported.includes(effort)) return effort
  const target = EFFORT_ORDER.indexOf(effort)
  const distance = (level: ReasoningEffort) =>
    Math.abs(EFFORT_ORDER.indexOf(level) - target)
  return [...supported]
    .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    .reduce((best, level) => (distance(level) < distance(best) ? level : best))
}

/**
 * Chat's model resolution: a reasoning suffix (`model:high`) wins over the
 * configured effort; a custom provider model keeps its own ID, any other is
 * normalized and redirected, and each effort is clamped to its model.
 */
function resolveAssistantRoute(
  requested: string,
  configuredEffort: ReasoningEffort | undefined,
  redirect: AssistantRedirect,
): AssistantRoute {
  const { baseModel, reasoningEffort: suffixEffort } =
    parseModelSuffix(requested)
  const normalized = normalizeModelName(baseModel)
  const effort = clampEffort(normalized, suffixEffort ?? configuredEffort)
  if (customChatReference(baseModel)) return { model: baseModel, effort }
  const target = redirect({ model: normalized, effort })
  const model = normalizeModelName(target.model)
  return {
    model,
    effort: clampEffort(model, target.effort),
    verbosity: target.verbosity,
  }
}

/**
 * The Copilot endpoint the Chat Completions route sends or translates to for
 * `selectedModel`, so models served only through Responses or Messages work.
 */
function assistantEndpoint(
  payload: ChatCompletionsPayload,
  selectedModel: Model | undefined,
): CopilotInferenceEndpoint | undefined {
  if (!selectedModel) return undefined
  const decision = selectChatUpstreamEndpoint({ payload, selectedModel })
  return "target" in decision ? decision.target : undefined
}

/**
 * The model rows of every account that may serve `model`. The merged catalog
 * keeps only the first account's row, whose endpoints can differ.
 */
function servingModelRows(model: string): Array<Model> {
  if (!usesPooledAccounts()) {
    const row = state.models?.data.find((entry) => entry.id === model)
    return row ? [row] : []
  }
  return tokenPool
    .getEligibleAccountsForModel(model)
    .flatMap((account) => tokenPool.getModelForAccount(model, account.id) ?? [])
}

function isAssistantModelAvailable(
  id: string,
  redirect: AssistantRedirect,
): boolean {
  const { model } = resolveAssistantRoute(id, undefined, redirect)
  if (customChatReference(model)) return true
  const payload = assistantPayload(model, "", "")
  return servingModelRows(model).some(
    (row) => assistantEndpoint(payload, row) !== undefined,
  )
}

/** Redirect sources the Chat route accepts, as the models listing names them. */
function redirectSourceIds(): Array<string> {
  return getLoadedModelRedirects()
    .filter((rule) => rule.enabled)
    .map((rule) =>
      rule.sourceEffort === "all" || rule.sourceEffort === "default" ?
        rule.sourceModel
      : `${rule.sourceModel}:${rule.sourceEffort}`,
    )
}

/** Model IDs AI Assist can call, each resolving as it will be sent. */
export function listAssistantModels(): Array<string> {
  const ids = new Set(state.models?.data.map((entry) => entry.id) ?? [])
  for (const listing of getCustomProviderModels()) {
    if (listing.kind === "chat") ids.add(listing.id)
  }
  for (const id of redirectSourceIds()) ids.add(id)
  const redirect = createAssistantRedirect()
  return [...ids]
    .filter((id) => isAssistantModelAvailable(id, redirect))
    .sort((a, b) => a.localeCompare(b))
}

// --- Invocation -------------------------------------------------------------

function replyText(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The assistant model returned no text")
  }
  return content
}

function chatReplyText(
  result: ChatCompletionResponse | AsyncIterable<unknown>,
): string {
  if (Symbol.asyncIterator in result) {
    throw new Error("The assistant model returned a stream")
  }
  return replyText(result.choices[0]?.message.content)
}

/** Send through the Copilot endpoint the Chat Completions route would use. */
async function sendToCopilot(options: {
  endpoint: CopilotInferenceEndpoint
  selectedModel: Model
  payload: ChatCompletionsPayload
  verbosity: ModelRedirectVerbosity | undefined
  signal: AbortSignal | undefined
}): Promise<string> {
  const { endpoint, payload, signal } = options
  if (endpoint === "/chat/completions") {
    return chatReplyText(await createChatCompletions(payload, { signal }))
  }
  if (endpoint === "/responses") {
    const translated = chatCompletionsToResponses(payload)
    if (options.verbosity) {
      translated.text = { ...translated.text, verbosity: options.verbosity }
    }
    // Finalized here without the gateway's default effort, so "Model default"
    // leaves the effort to the model.
    const { body } = finalizeResponsesRequest(translated, {
      implicitDefault: usesImplicitReasoningDefault(payload.model),
    })
    const result = await createResponses(body, {
      vision: false,
      initiator: detectInitiator(payload.messages),
      signal,
      prepared: true,
    })
    if (Symbol.asyncIterator in result) {
      throw new Error("The assistant model returned a stream")
    }
    return replyText(getResponsesResultOutputText(result))
  }
  const result = await createAnthropicMessages(
    await chatPayloadToAnthropic(payload, options.selectedModel, signal),
    { signal },
  )
  if (Symbol.asyncIterator in result) {
    throw new Error("The assistant model returned a stream")
  }
  return chatReplyText(anthropicResponseToChat(result, payload.model))
}

/**
 * The effort a Copilot model receives: clamped to its levels, and none for a
 * model without levels. A requested effort is sent even to a model set to
 * keep its implicit default; that setting only stops a default being added.
 */
function copilotEffort(
  model: string,
  requested: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!getModelReasoningConfig(model)) return undefined
  return clampEffort(model, requested)
}

/** One attempt; the fallback runner supplies the model for retries. */
async function sendAssistantAttempt(
  source: ChatCompletionsPayload,
  options: { effort?: ReasoningEffort; signal?: AbortSignal },
): Promise<{ model: string; content: string }> {
  const { signal } = options
  const route = resolveAssistantRoute(
    source.model,
    options.effort,
    createAssistantRedirect(),
  )
  const payload = { ...structuredClone(source), model: route.model }
  applyModelFallbackToPayload(payload, {
    effort: route.effort,
    verbosity: route.verbosity,
  })
  const { model } = payload
  // A fallback rule's own effort and verbosity win for its target model.
  const fallback = getModelFallbackRedirect()
  const effort =
    model === route.model && !fallback ?
      route.effort
    : clampEffort(model, fallback?.effort ?? route.effort)
  const reference = customChatReference(model)
  if (reference) {
    const result = await createCustomProviderChatCompletions(
      reference,
      { ...payload, model: reference.upstreamModel },
      { signal, reasoningEffort: effort },
    )
    return { model, content: chatReplyText(result) }
  }
  // The account is chosen first; its own model row decides the endpoint.
  const routed = await selectCatalogRoutedModel(model)
  const selectedModel = routed.model
  const endpoint = assistantEndpoint(payload, selectedModel)
  if (!selectedModel || !endpoint) {
    throw new Error(
      `${model} cannot run AI Assist: it is not an available chat model`,
    )
  }
  const sentEffort = copilotEffort(model, effort)
  if (sentEffort) payload.reasoning_effort = sentEffort
  const content = await runWithRoutedModelSelection(
    routed,
    async () =>
      await sendToCopilot({
        endpoint,
        selectedModel,
        payload,
        verbosity: fallback?.verbosity ?? route.verbosity,
        signal,
      }),
  )
  return { model, content }
}

export async function invokeAssistantModel(options: {
  model: string
  system: string
  user: string
  effort?: ReasoningEffort
  signal?: AbortSignal
}): Promise<{ model: string; content: string }> {
  const { effort, signal } = options
  const payload = assistantPayload(options.model, options.system, options.user)
  // A separate request: the held request's account, fallback, telemetry and
  // response headers stay untouched, and its own traffic is never intercepted.
  // Model IDs, redirects and configured model fallbacks resolve as on the
  // Chat Completions route.
  return await runAsIndependentRequest(
    "Intercept Assistant",
    async () =>
      await runBypassingIntercept(
        async () =>
          await runWithModelFallback(
            { payload, signal },
            async () => await sendAssistantAttempt(payload, { effort, signal }),
          ),
      ),
  )
}
