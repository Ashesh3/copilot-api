import { normalizeModelName } from "~/lib/model-resolver"

export interface CopilotSessionTokenClaims {
  availableModels: Array<string>
  selectedModel?: string
}

const MAX_SESSION_TOKEN_LENGTH = 16 * 1024
const BASE64URL_PATTERN = /^[\w-]+$/

function normalizedClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function parsePayloadSegment(
  segment: string,
): Record<string, unknown> | undefined {
  if (!segment || !BASE64URL_PATTERN.test(segment)) return undefined

  try {
    const parsed = JSON.parse(
      Buffer.from(segment, "base64url").toString(),
    ) as unknown
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function inspectCopilotSessionToken(
  token: string,
): CopilotSessionTokenClaims | undefined {
  if (!token || token.length > MAX_SESSION_TOKEN_LENGTH) return undefined

  const segments = token.split(".")
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    return undefined
  }

  const payload = parsePayloadSegment(segments[1])
  if (!payload) return undefined

  const selectedModel = normalizedClaim(payload.selected_model)
  const availableModels = [
    ...new Set(
      (Array.isArray(payload.available_models) ?
        payload.available_models
      : []
      ).flatMap((value) => {
        const model = normalizedClaim(value)
        return model ? [model] : []
      }),
    ),
  ]
  if (!selectedModel && availableModels.length === 0) return undefined

  return {
    availableModels,
    ...(selectedModel ? { selectedModel } : {}),
  }
}

export function sessionTokenMatchesModel(options: {
  finalModel: string
  requestedModel: string
  token: string | undefined
}): boolean {
  const { finalModel, requestedModel, token } = options
  if (!token) return false

  const normalizedRequestedModel = normalizeModelName(requestedModel)
  const normalizedFinalModel = normalizeModelName(finalModel)
  if (normalizedRequestedModel !== normalizedFinalModel) return false

  const claims = inspectCopilotSessionToken(token)
  if (!claims) return false

  if (claims.selectedModel) {
    return normalizeModelName(claims.selectedModel) === normalizedFinalModel
  }
  return claims.availableModels.some(
    (model) => normalizeModelName(model) === normalizedFinalModel,
  )
}
