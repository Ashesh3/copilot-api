export function shouldApplyFallbackSnapshot(
  currentRevision: number,
  incomingRevision: number,
): boolean {
  return incomingRevision >= currentRevision
}
