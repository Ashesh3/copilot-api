export type SystemPromptOverride =
  | { mode: "clear" | "append" | "prepend"; prompt: string }
  | { mode: "replace"; find: string; replacement: string }

export const MAX_SYSTEM_PROMPT_OVERRIDES = 32
export const MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH = 200_000

/** Resolve a stored chain or the equivalent single legacy prompt rule. */
export function getSystemPromptOverrides(settings: {
  systemPromptOverrides?: Array<SystemPromptOverride>
  forcedSystemPrompt?: string
  clearOtherSystemPrompts?: boolean
  forceAppendSystemPrompt?: boolean
}): Array<SystemPromptOverride> {
  if (settings.systemPromptOverrides !== undefined) {
    return settings.systemPromptOverrides.map((rule) => ({ ...rule }))
  }
  const prompt = settings.forcedSystemPrompt?.trim()
  if (!prompt) return []
  if (settings.clearOtherSystemPrompts) return [{ mode: "clear", prompt }]
  const mode = settings.forceAppendSystemPrompt ? "append" : "prepend"
  return [{ mode, prompt }]
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: Array<string>,
): boolean {
  return (
    Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
  )
}

function validateSystemPromptOverride(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be a rule object"
  }
  const rule = value as Record<string, unknown>
  if (rule.mode === "replace") {
    if (!hasOnlyFields(rule, ["mode", "find", "replacement"])) {
      return "must contain only mode, find, and replacement"
    }
    if (typeof rule.find !== "string" || rule.find.length === 0) {
      return "find must be a non-empty string"
    }
    if (typeof rule.replacement !== "string") {
      return "replacement must be a string"
    }
    return undefined
  }
  if (
    rule.mode !== "clear"
    && rule.mode !== "append"
    && rule.mode !== "prepend"
  ) {
    return "mode must be clear, append, prepend, or replace"
  }
  if (!hasOnlyFields(rule, ["mode", "prompt"])) {
    return "must contain only mode and prompt"
  }
  if (typeof rule.prompt !== "string") return "prompt must be a string"
  if (rule.mode !== "clear" && rule.prompt.trim().length === 0) {
    return "prompt must contain non-whitespace text"
  }
  return undefined
}

/** Validation never changes rule order or literal text, including whitespace. */
export function validateSystemPromptOverrides(
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return "systemPromptOverrides must be an array"
  if (value.length > MAX_SYSTEM_PROMPT_OVERRIDES) {
    return `systemPromptOverrides must contain at most ${MAX_SYSTEM_PROMPT_OVERRIDES} rules`
  }
  let textLength = 0
  for (const [index, entry] of value.entries()) {
    const error = validateSystemPromptOverride(entry)
    if (error) return `systemPromptOverrides[${index}] ${error}`
    const rule = entry as SystemPromptOverride
    textLength +=
      rule.mode === "replace" ?
        rule.find.length + rule.replacement.length
      : rule.prompt.length
    if (textLength > MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH) {
      return `systemPromptOverrides text must be at most ${MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH.toLocaleString("en-US")} characters in total`
    }
  }
  return undefined
}
