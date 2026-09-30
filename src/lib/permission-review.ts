import type { ModelRedirectResult } from "~/lib/model-redirect"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { getConfigForTest, getPermissionReviewSettings } from "~/lib/config"
import { resolveCustomProviderModel } from "~/lib/custom-providers"
import { LocalHTTPError } from "~/lib/error"
import { getLoadedModelRedirects } from "~/lib/model-redirect"
import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"
import { normalizeModelName } from "~/lib/model-resolver"
import { getModelRoutingSafety } from "~/lib/model-routing-safety"
import { parseModelSuffix } from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { peekStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"

// Copilot's assisted-approval runtime uses ordinary inference with this judge.
// Keep the calling client's policy and verdict format, not Copilot's ALLOW/DENY prompt.
const PERMISSION_REVIEW_RULE = "builtin:permission-review"
const PERMISSION_REVIEW_MIN_OUTPUT_TOKENS = 1024

function textContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) => {
      if (typeof part !== "object" || part === null) return ""
      if (!("type" in part) || part.type !== "text") return ""
      return "text" in part && typeof part.text === "string" ? part.text : ""
    })
    .join("")
}

/** Claude's classifier has a dynamic model name and may omit its beta header. */
export function isClaudePermissionReviewRequest(
  payload: AnthropicMessagesPayload,
): boolean {
  if (payload.tools?.length || payload.messages.length === 0) return false
  const systemBlocks =
    typeof payload.system === "string" ?
      [payload.system]
    : (payload.system ?? []).map((block) => textContent([block]))
  const hasPolicy = systemBlocks.some(
    (text) =>
      text
        .trimStart()
        .startsWith(
          "You are a security monitor for autonomous AI coding agents.",
        )
      && text.includes("## Classification Process")
      && text.includes("## Output Format")
      && (text.includes("<block>") || text.includes("<severity>")),
  )
  if (!hasPolicy || payload.messages.some((message) => message.role !== "user"))
    return false
  // The classifier can prepend user CLAUDE.md context, then split the transcript
  // across several user messages. Do not match transcript text inside that context.
  const messages = payload.messages.map((message) =>
    textContent(message.content),
  )
  const first = messages[0].trimStart()
  const contextPrefix = first.startsWith(
    "The following is the user's CLAUDE.md configuration.",
  )
  if (
    contextPrefix
    && (!first.includes("<user_claude_md>")
      || !first.includes("</user_claude_md>"))
  )
    return false
  const transcript = messages
    .slice(contextPrefix ? 1 : 0)
    .join("")
    .trimStart()
  return (
    transcript.startsWith("<transcript>")
    && transcript.includes("</transcript>")
  )
}

function isAdvertisedModel(model: string): boolean {
  // Raw membership also covers disabled accounts/models; never evade their policy.
  return (
    state.models?.data.some((entry) => entry.id === model) === true
    || tokenPool.hasKnownModel(model)
  )
}

function isCustomReviewModel(model: string): boolean {
  return Boolean(
    (peekStorageRuntime() || getConfigForTest())
      && resolveCustomProviderModel({ model, kind: "chat" }),
  )
}

function requireReviewModel(model: string, kind: "codex" | "claude"): void {
  if (isAdvertisedModel(model) || isCustomReviewModel(model)) return
  const body = {
    ...(kind === "claude" ? { type: "error" } : {}),
    error: {
      code: "permission_review_model_unavailable",
      type: "api_error",
      message: `The permission-review model (${model}) is unavailable. Select an available model in Settings, configure a custom provider, or add a Model Redirect.`,
    },
  }
  throw new LocalHTTPError(
    body.error.message,
    Response.json(body, { status: 503 }),
    body,
  )
}

function getReviewerRouteRequest(redirect: ModelRedirectResult) {
  const parsed = parseModelSuffix(getPermissionReviewSettings().model)
  return {
    model:
      isCustomReviewModel(parsed.baseModel) ?
        parsed.baseModel
      : normalizeModelName(parsed.baseModel),
    effort: parsed.reasoningEffort ?? redirect.effort ?? "low",
    verbosity: redirect.verbosity,
  } as const
}

export function normalizePermissionReviewTarget(model: string): string {
  return isCustomReviewModel(model) ? model : normalizeModelName(model)
}

/** Resolve recognized review requests to the configured judge before allocation. */
export function resolvePermissionReviewRedirect(
  redirect: ModelRedirectResult,
  kind: "codex" | "claude" | undefined,
): ModelRedirectResult {
  if (!kind || redirect.redirected) return redirect
  if (!getModelRoutingSafety().safe) return redirect
  if (isCustomReviewModel(redirect.model)) return redirect
  const reviewer = getReviewerRouteRequest(redirect)
  const { model: reviewerModel, effort } = reviewer
  // The caller already loaded and applied the source's configured rules. Apply
  // the judge's rules too, so HTTP and rehydrated WebSocket turns resolve alike.
  const target = resolveModelRedirectRules(getLoadedModelRedirects(), reviewer)
  if (
    target.loop
    || (target.model === redirect.model && !isAdvertisedModel(target.model))
  )
    return redirect
  if (!target.redirected) requireReviewModel(reviewerModel, kind)
  return {
    ...redirect,
    model: target.model,
    effort: target.effort,
    verbosity: target.verbosity,
    redirected: true,
    originalModel: redirect.model,
    originalEffort: redirect.effort,
    originalVerbosity: redirect.verbosity,
    ruleId: PERMISSION_REVIEW_RULE,
    ruleIds: [PERMISSION_REVIEW_RULE, ...(target.ruleIds ?? [])],
    redirectChain: [
      {
        ruleId: PERMISSION_REVIEW_RULE,
        sourceModel: redirect.model,
        sourceEffort: redirect.effort,
        sourceVerbosity: redirect.verbosity,
        targetModel: reviewerModel,
        targetEffort: effort,
        targetVerbosity: redirect.verbosity,
      },
      ...(target.redirectChain ?? []),
    ],
  }
}

export function preparePermissionReviewResponsesCandidate(
  source: AnthropicMessagesPayload,
  payload: ResponsesPayload,
): void {
  if (!isClaudePermissionReviewRequest(source)) return
  // Native Copilot's Responses judge omits sampling controls. The normal
  // Messages adapter otherwise injects temperature=1 when enabling reasoning.
  delete payload.temperature
  delete payload.top_p
  // Claude's first pass allows just 64 tokens. The Copilot reasoning judge needs
  // room for its reasoning before producing the client's visible verdict.
  if (
    payload.reasoning?.effort !== "none"
    && typeof payload.max_output_tokens === "number"
    && payload.max_output_tokens < PERMISSION_REVIEW_MIN_OUTPUT_TOKENS
  )
    payload.max_output_tokens = PERMISSION_REVIEW_MIN_OUTPUT_TOKENS
}

export function isCodexPermissionReviewModel(model: unknown): model is string {
  return (
    typeof model === "string"
    && parseModelSuffix(model).baseModel === "codex-auto-review"
  )
}

export function shouldAllowAllCodexPermissionReviews(model: string): boolean {
  return (
    isCodexPermissionReviewModel(model)
    && getPermissionReviewSettings().allowAll
  )
}

export function shouldAllowAllClaudePermissionReviews(
  payload: AnthropicMessagesPayload,
): boolean {
  return (
    isClaudePermissionReviewRequest(payload)
    && getPermissionReviewSettings().allowAll
  )
}

export function claudePermissionReviewAllowText(
  payload: AnthropicMessagesPayload,
): string {
  // The format comes from the classifier policy, never from quoted transcript.
  const system = textContent(payload.system)
  const outputFormat = system.slice(system.lastIndexOf("## Output Format"))
  return outputFormat.includes("<severity>") ?
      "<severity>0</severity>"
    : "<block>no</block>"
}
