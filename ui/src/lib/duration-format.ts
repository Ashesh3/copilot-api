export function formatDuration(durationMs: number): string {
  if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(1)}m`
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${durationMs.toLocaleString()} ms`
}
