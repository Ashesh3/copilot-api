import { LocalHTTPError } from "~/lib/error"

export const MAX_SHARED_WEB_SEARCH_USES = 8

export function readPositiveWebSearchLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ?
      value
    : undefined
}

export function createWebSearchBudget(
  sourceMaxUses: number | undefined,
  optionMaxUses: number | undefined,
): { claimBatch: (count: number) => void } {
  const effectiveMaxUses = Math.min(
    MAX_SHARED_WEB_SEARCH_USES,
    readPositiveWebSearchLimit(sourceMaxUses) ?? MAX_SHARED_WEB_SEARCH_USES,
    readPositiveWebSearchLimit(optionMaxUses) ?? MAX_SHARED_WEB_SEARCH_USES,
  )
  let executedUses = 0

  return {
    claimBatch(count) {
      if (executedUses + count > effectiveMaxUses) {
        throw createWebSearchLimitError(effectiveMaxUses)
      }
      executedUses += count
    },
  }
}

function createWebSearchLimitError(limit: number): LocalHTTPError {
  const clientBody = {
    error: {
      type: "invalid_request_error",
      code: "web_search_limit_exceeded",
      message: "The Copilot request was rejected.",
      param: "web_search_limit",
    },
  }
  return new LocalHTTPError(
    `Web search exceeded ${limit} uses.`,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}
