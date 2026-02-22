/**
 * Normalize a model name by converting dashes to dots between numbers
 * and converting Anthropic's [1m] suffix to Copilot's -1m suffix.
 * e.g., "claude-opus-4-5" -> "claude-opus-4.5"
 *       "claude-opus-4-6[1m]" -> "claude-opus-4.6-1m"
 *       "gpt-4-1" -> "gpt-4.1"
 *       "gpt-5-1-codex" -> "gpt-5.1-codex"
 */
export function normalizeModelName(model: string): string {
  // Convert Anthropic's [1m] context suffix to Copilot's -1m format
  let normalized = model.replace("[1m]", "-1m")

  // Strip Anthropic date suffixes (e.g., "-20251001") — Copilot doesn't support them
  normalized = normalized.replace(/-\d{8}$/, "")

  // Replace dash with dot only between two digits: "4-5" -> "4.5"
  normalized = normalized.replaceAll(/(\d)-(\d)/g, (_, p1, p2) => `${p1}.${p2}`)

  return normalized
}
