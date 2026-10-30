import type { Model } from "~/services/copilot/get-models"

/**
 * Environment for running Claude Code against this server. Claude Code knows
 * the context window only of Claude models; for any other model name it
 * assumes 200k tokens unless CLAUDE_CODE_MAX_CONTEXT_TOKENS says otherwise,
 * so it would compact a larger window too early or overflow a smaller one.
 */
export function buildClaudeCodeEnvironment(options: {
  serverUrl: string
  model: string
  smallModel: string
  models: ReadonlyArray<Model>
}): Record<string, string> {
  const promptLimit = options.models.find((entry) => entry.id === options.model)
    ?.capabilities.limits?.max_prompt_tokens
  const knowsWindow = options.model.toLowerCase().startsWith("claude-")
  return {
    ANTHROPIC_BASE_URL: options.serverUrl,
    ANTHROPIC_AUTH_TOKEN: "dummy",
    ANTHROPIC_MODEL: options.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: options.model,
    ANTHROPIC_SMALL_FAST_MODEL: options.smallModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: options.smallModel,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    ...((
      !knowsWindow
      && typeof promptLimit === "number"
      && Number.isInteger(promptLimit)
      && promptLimit > 0
    ) ?
      { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(promptLimit) }
    : {}),
  }
}
