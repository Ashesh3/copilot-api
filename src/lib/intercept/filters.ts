import { RE2JS } from "re2js"

import type {
  InterceptConfig,
  InterceptDirection,
  InterceptFilterCondition,
  InterceptFilterConfig,
  InterceptPhase,
} from "./types"

export interface InterceptMatchContext {
  phase: InterceptPhase
  path: string
  upstream: "copilot" | "custom"
  providerId?: string
  model?: string
  sessionId?: string
  headers: Record<string, string>
  requestBody: string
  responseBody?: string
}

export function directionMatchesPhase(
  direction: InterceptDirection,
  phase: InterceptPhase,
): boolean {
  if (direction === "both") return true
  return direction === phase
}

function getHeaderValue(
  headers: Record<string, string>,
  headerName: string | undefined,
): string {
  if (!headerName) return ""
  const target = headerName.trim().toLowerCase()
  if (!target) return ""
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return ""
}

function extractFieldValue(
  condition: InterceptFilterCondition,
  ctx: InterceptMatchContext,
): string {
  switch (condition.field) {
    case "sessionId": {
      return ctx.sessionId ?? ""
    }
    case "model": {
      return ctx.model ?? ""
    }
    case "path": {
      return ctx.path
    }
    case "upstream": {
      return ctx.providerId ? `${ctx.upstream}:${ctx.providerId}` : ctx.upstream
    }
    case "requestBody": {
      return ctx.requestBody
    }
    case "responseBody": {
      return ctx.responseBody ?? ""
    }
    case "header": {
      return getHeaderValue(ctx.headers, condition.headerName)
    }
    case "direction": {
      return ctx.phase
    }
    default: {
      return ""
    }
  }
}

export function evaluateFilterCondition(
  condition: InterceptFilterCondition,
  ctx: InterceptMatchContext,
): boolean {
  const actual = extractFieldValue(condition, ctx)
  const expected = condition.value
  const caseSensitive = condition.caseSensitive === true

  if (condition.operator === "regex") {
    if (!expected) return true
    try {
      const flags = caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE
      const pattern = RE2JS.compile(expected, flags)
      return pattern.matcher(actual).find()
    } catch {
      return false
    }
  }

  const lhs = caseSensitive ? actual : actual.toLowerCase()
  const rhs = caseSensitive ? expected : expected.toLowerCase()

  switch (condition.operator) {
    case "equals": {
      return lhs === rhs
    }
    case "not_equals": {
      return lhs !== rhs
    }
    case "contains": {
      return lhs.includes(rhs)
    }
    case "not_contains": {
      return !lhs.includes(rhs)
    }
    case "starts_with": {
      return lhs.startsWith(rhs)
    }
    default: {
      return false
    }
  }
}

export function matchesInterceptFilters(
  filters: InterceptFilterConfig,
  ctx: InterceptMatchContext,
): boolean {
  if (!filters.enabled) return true
  const active = filters.conditions.filter((c) => c.enabled)
  if (active.length === 0) return true

  if (filters.matchMode === "any") {
    return active.some((cond) => evaluateFilterCondition(cond, ctx))
  }
  return active.every((cond) => evaluateFilterCondition(cond, ctx))
}

export function shouldIntercept(
  config: InterceptConfig,
  ctx: InterceptMatchContext,
): boolean {
  if (!config.enabled) return false
  if (!directionMatchesPhase(config.direction, ctx.phase)) return false
  return matchesInterceptFilters(config.filters, ctx)
}

export function validateFilterRegex(pattern: string): string | null {
  if (!pattern) return null
  try {
    RE2JS.compile(pattern)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression"
  }
}
