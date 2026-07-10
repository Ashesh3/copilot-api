import type { StatsigDynamicConfig } from "./types"

function isJsonCompatibleValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return true
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonCompatibleValue(item))
  }
  if (typeof value === "object") {
    return Object.values(value).every((item) => isJsonCompatibleValue(item))
  }
  return false
}

export function parseDynamicConfig(value: string):
  | {
      ok: true
      value: StatsigDynamicConfig
    }
  | {
      ok: false
      error: string
    } {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return { ok: false, error: "Dynamic config must be a JSON object" }
    }
    if (!isJsonCompatibleValue(parsed)) {
      return {
        ok: false,
        error: "Dynamic config numbers must be finite",
      }
    }
    return {
      ok: true,
      value: parsed as StatsigDynamicConfig,
    }
  } catch {
    return { ok: false, error: "Enter valid JSON" }
  }
}
