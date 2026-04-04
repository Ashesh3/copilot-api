/**
 * Normalize a model name by converting dashes to dots between numbers
 * and converting Anthropic's [1m] suffix to Copilot's -1m suffix.
 * e.g., "claude-opus-4-5" -> "claude-opus-4.5"
 *       "claude-opus-4-6[1m]" -> "claude-opus-4.6-1m"
 *       "gpt-4-1" -> "gpt-4.1"
 *       "gpt-5-1-codex" -> "gpt-5.1-codex"
 *       "claude-opus-4.6-1m" -> "claude-opus-4.6-1m" (preserved)
 *       "gpt-4o-mini-2024-07-18" -> "gpt-4o-mini-2024-07-18" (date preserved)
 *       "gpt-4.1-2025-04-14" -> "gpt-4.1-2025-04-14" (date preserved)
 */
export function normalizeModelName(model: string): string {
  // Convert Anthropic's [1m] context suffix to Copilot's -1m format
  let normalized = model.replace("[1m]", "-1m")

  // Strip Anthropic date suffixes (e.g., "-20251001") — Copilot doesn't support them
  normalized = normalized.replace(/-\d{8}$/, "")

  // Strip known suffixes before digit-dash-digit conversion to avoid mangling them
  let suffix = ""
  const suffixMatch = normalized.match(/(?:-1m|-fast)$/)
  if (suffixMatch) {
    suffix = suffixMatch[0]
    normalized = normalized.slice(0, -suffix.length)
  }

  // Protect date suffixes (e.g., "-2024-07-18", "-2025-04-14") from digit-dash-digit conversion.
  // These are real Copilot model IDs and must be preserved as-is.
  let dateSuffix = ""
  const dateMatch = normalized.match(/-(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) {
    dateSuffix = `-${dateMatch[1]}`
    normalized = normalized.slice(0, -dateSuffix.length)
  }

  // Replace dash with dot only between two single digits: "4-5" -> "4.5"
  // Multi-digit sequences like "4-0613" or "2024-07" are model IDs, not versions.
  normalized = normalized.replaceAll(/(?<!\d)(\d)-(\d)(?!\d)/g, (_, p1, p2) => `${p1}.${p2}`)

  return normalized + dateSuffix + suffix
}
