import type { Model } from "~/services/copilot/get-models"

export interface SafeCandidateFailure {
  code?: string
  phase: "tool_call" | "tool_result"
  providerClass: string
  status: number
}

export function selectToolCapableResponsesCandidates(
  models: ReadonlyArray<Model>,
  limit: number,
): Array<Model> {
  const candidates: Array<Model> = []
  const providers = new Set<string>()

  for (const model of models) {
    if (!model.supported_endpoints?.includes("/responses")) continue
    if (model.capabilities.supports.tool_calls !== true) continue

    const provider = providerIdentity(model)
    if (providers.has(provider)) continue
    providers.add(provider)
    candidates.push(model)
    if (candidates.length >= limit) break
  }

  return candidates
}

function providerIdentity(model: Model): string {
  return (
    model.vendor?.trim().toLowerCase()
    || `family:${model.capabilities.family.trim().toLowerCase()}`
  )
}

export function classifyProvider(model: Model): string {
  const value =
    `${model.vendor ?? ""} ${model.capabilities.family}`.toLowerCase()
  for (const provider of [
    "anthropic",
    "openai",
    "google",
    "gemini",
    "xai",
    "mistral",
    "deepseek",
  ]) {
    if (value.includes(provider)) {
      return provider === "gemini" ? "google" : provider
    }
  }
  return "other"
}

export function isSafeCandidateRejection(status: number): boolean {
  return [400, 403, 404, 409, 422, 429].includes(status)
}

export async function safeCandidateFailure(
  model: Model,
  phase: SafeCandidateFailure["phase"],
  response: Response,
): Promise<SafeCandidateFailure> {
  return {
    code: await readSafeErrorCode(response),
    phase,
    providerClass: classifyProvider(model),
    status: response.status,
  }
}

async function readSafeErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = await response.json()
    if (!isRecord(body)) return undefined
    const error = isRecord(body.error) ? body.error : undefined
    return safeCode(error?.code) ?? safeCode(body.code)
  } catch {
    return undefined
  }
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,80}$/.test(value) ?
      value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
