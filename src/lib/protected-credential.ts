import {
  extractClientIpFromHeaders,
  isIpBlocked,
  recordFailedAttempt,
} from "./ip-blocker"

export type ProtectedCredentialResult<T> =
  | { status: "authorized"; clientIp: string | null; credential: T }
  | { status: "blocked"; clientIp: string }
  | { status: "failed"; clientIp: string | null }

export async function resolveProtectedCredential<T>(
  request: Request,
  resolve: () => Promise<T | null>,
): Promise<ProtectedCredentialResult<T>> {
  const clientIp = extractClientIpFromHeaders(request.headers)
  if (clientIp !== null && isIpBlocked(clientIp)) {
    return { status: "blocked", clientIp }
  }

  const credential = await resolve()
  if (credential !== null) {
    return { status: "authorized", clientIp, credential }
  }

  if (clientIp !== null) recordFailedAttempt(clientIp)
  return { status: "failed", clientIp }
}
