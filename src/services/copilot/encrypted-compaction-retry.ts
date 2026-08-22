import { randomUUID } from "node:crypto"

import { classifyCompatibilityRetry } from "./compatibility-retry"

const parseRequestBody = (
  requestInit: RequestInit | undefined,
): Record<string, unknown> | undefined => {
  if (typeof requestInit?.body !== "string") return undefined
  try {
    const payload: unknown = JSON.parse(requestInit.body)
    return (
        typeof payload === "object"
          && payload !== null
          && !Array.isArray(payload)
      ) ?
        (payload as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const isEncryptedCompactionVerificationError = async (
  path: string,
  response: Response,
  requestInit: RequestInit | undefined,
): Promise<boolean> => {
  if (path !== "/responses") return false
  const body = parseRequestBody(requestInit)
  if (!body) return false
  return (
    (
      await classifyCompatibilityRetry({
        body,
        endpoint: "/responses",
        response,
      })
    ).kind === "encrypted_compaction_verification"
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
