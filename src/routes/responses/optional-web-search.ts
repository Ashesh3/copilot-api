import type { ResponsesPayload } from "~/services/copilot/create-responses"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHostedSearch(value: unknown): boolean {
  return (
    isRecord(value)
    && typeof value.type === "string"
    && /^web_search(?:_[a-z\d]+)*$/.test(value.type)
  )
}

/** Mapped client tools are ordinary functions; hosted search is only an offered
 * capability unless tool_choice selects it. Stateless fallback adapters cannot
 * replay its server-side history across client-tool handoffs. Omit that optional
 * capability, not the entire coding request or any caller-owned function. */
export function omitOptionalResponsesWebSearch(
  source: ResponsesPayload,
): boolean {
  if (
    !Array.isArray(source.tools)
    || !source.tools.some((tool) => isRecord(tool) && tool.type === "function")
  )
    return false
  const choice: unknown = source.tool_choice
  if (isHostedSearch(choice)) return false
  if (
    choice !== undefined
    && choice !== null
    && choice !== "auto"
    && choice !== "none"
    && choice !== "required"
    && (!isRecord(choice) || choice.type !== "function")
  )
    return false
  const retained = source.tools.filter((tool) => !isHostedSearch(tool))
  if (retained.length === source.tools.length) return false
  source.tools = retained
  return true
}
