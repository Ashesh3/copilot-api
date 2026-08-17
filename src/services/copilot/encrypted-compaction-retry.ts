import { randomUUID } from "node:crypto"

interface UpstreamErrorBody {
  error?: {
    code?: unknown
    message?: unknown
  }
}

const hasNativeCompactionEncryptedContent = (
  requestInit: RequestInit | undefined,
): boolean => {
  if (typeof requestInit?.body !== "string") return false

  try {
    const payload = JSON.parse(requestInit.body) as { input?: unknown }
    if (!Array.isArray(payload.input)) return false
    return payload.input.some(
      (item) =>
        typeof item === "object"
        && item !== null
        && !Array.isArray(item)
        && (item as Record<string, unknown>).type === "compaction"
        && typeof (item as Record<string, unknown>).encrypted_content
          === "string"
        && Boolean(
          (item as Record<string, unknown>).encrypted_content as string,
        ),
    )
  } catch {
    return false
  }
}

export const isEncryptedCompactionVerificationError = async (
  path: string,
  response: Response,
  requestInit: RequestInit | undefined,
): Promise<boolean> => {
  if (
    path !== "/responses"
    || response.status !== 400
    || !hasNativeCompactionEncryptedContent(requestInit)
  ) {
    return false
  }

  let body: UpstreamErrorBody
  try {
    body = (await response.clone().json()) as UpstreamErrorBody
  } catch {
    return false
  }

  const code = body.error?.code
  const message = body.error?.message
  if (code !== "invalid_encrypted_content" && code !== "invalid_request_body") {
    return false
  }
  if (typeof message !== "string") return false

  const normalized = message.toLowerCase().replaceAll(/\s+/gu, " ")
  return /\bencrypted content(?: \S+)? could not be (?:verified|decrypted|parsed)/u.test(
    normalized,
  )
}

const toHeaderRecord = (
  headersInit: RequestInit["headers"],
): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (!headersInit) return headers

  if (headersInit instanceof Headers) {
    for (const [key, value] of headersInit.entries()) headers[key] = value
    return headers
  }
  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) headers[key] = value
    return headers
  }
  for (const [key, value] of Object.entries(headersInit)) {
    if (typeof value === "string") headers[key] = value
  }
  return headers
}

export const refreshRequestIdForRetry = (
  requestInit: RequestInit | undefined,
): RequestInit | undefined => {
  const headers = Object.fromEntries(
    Object.entries(toHeaderRecord(requestInit?.headers)).filter(
      ([key]) => key.toLowerCase() !== "x-request-id",
    ),
  )
  headers["X-Request-Id"] = randomUUID()
  return { ...requestInit, headers }
}
