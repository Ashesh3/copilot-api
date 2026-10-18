const legacyEnvelope =
  /^\[Web tool (?:_copilot_web_search(?:_[1-9]\d*)?|web_search) (?:result|failed)\]\n.*\n\[End web tool result\]$/su

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLegacyResultPart(value: unknown): boolean {
  return (
    isRecord(value)
    && Object.keys(value).length === 3
    && value.type === "output_text"
    && Array.isArray(value.annotations)
    && value.annotations.length === 0
    && typeof value.text === "string"
    && value.text.endsWith("\n[End web tool result]")
    && legacyEnvelope.test(value.text)
  )
}

function isLegacyWebResult(value: unknown): boolean {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 5
    || value.type !== "message"
    || value.role !== "assistant"
    || value.status !== "completed"
    || typeof value.id !== "string"
    || !value.id.startsWith("web_result_")
    || value.id.length === "web_result_".length
    || !Array.isArray(value.content)
    || value.content.length !== 1
  )
    return false
  return isLegacyResultPart(value.content[0])
}

/** Remove only complete legacy gateway artifacts; never fabricate tool history. */
export function withoutLegacyWebResults<T>(input: T): T {
  if (
    !Array.isArray(input)
    || !input.some((item: unknown) => isLegacyWebResult(item))
  )
    return input
  return input.filter((item: unknown) => !isLegacyWebResult(item)) as T
}
