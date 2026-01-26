/**
 * Normalize a model name by converting dashes to dots between numbers.
 * e.g., "claude-opus-4-5" -> "claude-opus-4.5"
 *       "gpt-4-1" -> "gpt-4.1"
 *       "gpt-5-1-codex" -> "gpt-5.1-codex"
 */
export function normalizeModelName(model: string): string {
  // Replace dash with dot only between two digits: "4-5" -> "4.5"
  return model.replace(/(\d)-(\d)/g, (_, p1, p2) => `${p1}.${p2}`)
}
