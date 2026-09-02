interface JsonRecord {
  [key: string]: unknown
}

const REFRESH_TOKEN_PREFIX = "local_codex_v1."
const BASE64URL_PATTERN = /^[\w-]+$/
const JWT_PART_PATTERN = /^[\w-]+$/
const EXPECTED_ISSUER = "https://auth.openai.com"
const EXPECTED_AUDIENCE = "https://api.openai.com/v1"
const AUTH_CLAIMS_KEY = "https://api.openai.com/auth"

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeJsonBase64Url(value: string): unknown {
  if (!JWT_PART_PATTERN.test(value)) return null
  try {
    return JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown
  } catch {
    return null
  }
}

function hasExpectedHeader(header: unknown): boolean {
  return isRecord(header) && header.alg === "none" && header.typ === "JWT"
}

function hasExpectedAuthClaims(value: unknown): boolean {
  return (
    isRecord(value)
    && typeof value.chatgpt_user_id === "string"
    && value.chatgpt_user_id.length > 0
    && value.chatgpt_plan_type === "plus"
    && typeof value.chatgpt_account_id === "string"
    && value.chatgpt_account_id.length > 0
  )
}

function hasExpectedPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  if (
    payload.iss !== EXPECTED_ISSUER
    || payload.aud !== EXPECTED_AUDIENCE
    || typeof payload.sub !== "string"
    || !payload.sub
    || typeof payload.email !== "string"
    || !payload.email
  ) {
    return false
  }
  return hasExpectedAuthClaims(payload[AUTH_CLAIMS_KEY])
}

function hasExpectedSyntheticClaims(jwt: string): boolean {
  const parts = jwt.split(".")
  if (
    parts.length !== 3
    || parts.some((part) => !JWT_PART_PATTERN.test(part))
  ) {
    return false
  }

  return (
    hasExpectedHeader(decodeJsonBase64Url(parts[0] ?? ""))
    && hasExpectedPayload(decodeJsonBase64Url(parts[1] ?? ""))
  )
}

export function parseCodexDesktopRefreshToken(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(REFRESH_TOKEN_PREFIX)) {
    return null
  }
  const encodedJwt = value.slice(REFRESH_TOKEN_PREFIX.length)
  if (!encodedJwt || !BASE64URL_PATTERN.test(encodedJwt)) return null

  let jwt: string
  try {
    jwt = Buffer.from(encodedJwt, "base64url").toString("utf8")
  } catch {
    return null
  }
  if (!hasExpectedSyntheticClaims(jwt)) return null
  return jwt
}
