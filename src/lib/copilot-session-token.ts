import { normalizeModelName } from "~/lib/model-resolver"

export interface CopilotSessionTokenClaims {
  availableModels: Array<string>
  issuerSubject?: string
  selectedModel?: string
}

const MAX_SESSION_TOKEN_LENGTH = 16 * 1024
const MAX_ISSUER_SUBJECT_LENGTH = 512
const BASE64URL_PATTERN = /^[\w-]+$/
const ASSIGNMENT_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/
const ISSUER_SUBJECT_PATTERN = /^[\w.~-]+$/
const UTF8_DECODER = new TextDecoder(undefined, { fatal: true })

function normalizedClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function decodeCanonicalSegment(segment: string): Buffer | undefined {
  if (
    !segment
    || !BASE64URL_PATTERN.test(segment)
    || segment.length % 4 === 1
  ) {
    return undefined
  }

  try {
    const decoded = Buffer.from(segment, "base64url")
    return decoded.toString("base64url") === segment ? decoded : undefined
  } catch {
    return undefined
  }
}

function parsePayloadSegment(
  segment: string,
): { json: string; payload: Record<string, unknown> } | undefined {
  const decoded = decodeCanonicalSegment(segment)
  if (!decoded) return undefined

  try {
    const json = UTF8_DECODER.decode(decoded)
    const parsed = JSON.parse(json) as unknown
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return undefined
    }
    return { json, payload: parsed as Record<string, unknown> }
  } catch {
    return undefined
  }
}

function findJsonStringEnd(json: string, start: number): number {
  let index = start + 1
  while (index < json.length) {
    if (json[index] === "\\") {
      index += 2
      continue
    }
    if (json[index] === '"') return index
    index++
  }
  return -1
}

function skipJsonWhitespace(json: string, start: number): number {
  let index = start
  while (/\s/.test(json[index] ?? "")) index++
  return index
}

function jsonStringEquals(
  json: string,
  range: { end: number; start: number },
  expected: string,
): boolean {
  try {
    return JSON.parse(json.slice(range.start, range.end + 1)) === expected
  } catch {
    return false
  }
}

function countTopLevelProperty(json: string, property: string): number {
  let depth = 0
  let count = 0
  let index = 0

  while (index < json.length) {
    const character = json[index]
    switch (character) {
      case '"': {
        const end = findJsonStringEnd(json, index)
        if (end < 0) return count
        const next = skipJsonWhitespace(json, end + 1)
        if (
          depth === 1
          && json[next] === ":"
          && jsonStringEquals(json, { end, start: index }, property)
        ) {
          count++
        }
        index = end

        break
      }
      case "{":
      case "[": {
        depth++

        break
      }
      case "}":
      case "]": {
        depth--

        break
      }
      // No default
    }
    index++
  }

  return count
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true
    }
  }
  return false
}

function boundedIssuerSubject(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ISSUER_SUBJECT_LENGTH
    || !ISSUER_SUBJECT_PATTERN.test(value)
  ) {
    return undefined
  }
  return value
}

export function inspectCopilotSessionToken(
  token: string,
): CopilotSessionTokenClaims | undefined {
  if (!token || token.length > MAX_SESSION_TOKEN_LENGTH) return undefined

  const segments = token.split(".")
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    return undefined
  }
  if (
    !decodeCanonicalSegment(segments[0])
    || !decodeCanonicalSegment(segments[2])
  ) {
    return undefined
  }

  const parsedPayload = parsePayloadSegment(segments[1])
  if (!parsedPayload) return undefined
  const { json, payload } = parsedPayload

  const selectedModel = normalizedClaim(payload.selected_model)
  const issuerSubject =
    countTopLevelProperty(json, "sub") === 1 ?
      boundedIssuerSubject(payload.sub)
    : undefined
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
  if (!selectedModel && availableModels.length === 0 && !issuerSubject) {
    return undefined
  }

  return {
    availableModels,
    ...(issuerSubject ? { issuerSubject } : {}),
    ...(selectedModel ? { selectedModel } : {}),
  }
}

export function inspectCopilotBearerTokenIssuer(
  token: string | undefined,
): string | undefined {
  if (!token || token.length > MAX_SESSION_TOKEN_LENGTH) return undefined
  if (containsControlCharacter(token)) return undefined

  let issuerSubject: string | undefined
  const assignmentKeys = new Set<string>()
  for (const assignment of token.split(";")) {
    const separator = assignment.indexOf("=")
    if (
      separator <= 0
      || separator !== assignment.lastIndexOf("=")
      || separator === assignment.length - 1
    ) {
      return undefined
    }
    const key = assignment.slice(0, separator)
    const value = assignment.slice(separator + 1)
    if (!ASSIGNMENT_KEY_PATTERN.test(key)) return undefined
    if (assignmentKeys.has(key)) return undefined
    assignmentKeys.add(key)
    if (containsControlCharacter(value) || /\s/.test(value)) return undefined
    if (key !== "tid") continue
    if (issuerSubject !== undefined) return undefined
    issuerSubject = boundedIssuerSubject(value)
    if (!issuerSubject) return undefined
  }

  return issuerSubject
}

export function sessionTokenMatchesAccount(options: {
  accountSubject?: string
  accountToken: string | undefined
  sessionToken: string | undefined
}): boolean {
  if (!options.sessionToken) return false
  const sessionIssuer = inspectCopilotSessionToken(
    options.sessionToken,
  )?.issuerSubject
  const accountIssuer =
    boundedIssuerSubject(options.accountSubject)
    ?? inspectCopilotBearerTokenIssuer(options.accountToken)
  return Boolean(
    sessionIssuer && accountIssuer && sessionIssuer === accountIssuer,
  )
}

export function sessionTokenMatchesModel(options: {
  finalModel: string
  modelWasRedirected: boolean
  requestedModel: string
  token: string | undefined
}): boolean {
  const { finalModel, modelWasRedirected, requestedModel, token } = options
  if (!token || modelWasRedirected) return false

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
