/**
 * Some Claude models always think and reject `thinking: {type: "disabled"}`
 * (Claude Code's own catalog marks Opus 5.5 and the Fable models this way).
 * Claude Code omits `thinking` for them, but it cannot recognize Copilot model
 * IDs, so the gateway learns the rejection from upstream for this process.
 */
const MAX_REMEMBERED_MODELS = 64
const modelsRejectingDisabledThinking = new Set<string>()

export function rememberDisabledThinkingRejection(modelId: string): void {
  if (modelsRejectingDisabledThinking.has(modelId)) return
  if (modelsRejectingDisabledThinking.size >= MAX_REMEMBERED_MODELS) {
    const oldest = modelsRejectingDisabledThinking.values().next()
    if (!oldest.done) modelsRejectingDisabledThinking.delete(oldest.value)
  }
  modelsRejectingDisabledThinking.add(modelId)
}

export function rejectsDisabledThinking(modelId: string): boolean {
  return modelsRejectingDisabledThinking.has(modelId)
}

export function resetDisabledThinkingRejectionsForTest(): void {
  modelsRejectingDisabledThinking.clear()
}
