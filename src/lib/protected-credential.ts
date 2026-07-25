import { resolveRequestCredential } from "./credential-resolver"
import {
  extractClientIpFromHeaders,
  isIpBlocked,
  recordFailedAttempt,
} from "./ip-blocker"

export type ProtectedCredentialResult<T> =
  | { status: "authorized"; clientIp: string | null; credential: T }
  | { status: "blocked"; clientIp: string }
  | { status: "failed"; clientIp: string | null }

export interface ProtectedCredentialOptions {
  /**
   * Compatibility stubs guard no protected resource, so a denial there is no
   * evidence of credential guessing. Claude Code polls them in the background
   * (telemetry, bootstrap, settings), and a client whose credential is merely
   * the wrong kind for those routes would otherwise ban itself. Denials stay
   * `401`; only the brute-force tracker is skipped.
   */
  recordFailures?: boolean
}

/**
 * A request carrying a credential that resolves to a known principal failed
 * authorization, not authentication. Denying it is correct; counting it as a
 * guess is not.
 */
async function isRecognizedPrincipal(request: Request): Promise<boolean> {
  return (await resolveRequestCredential(request)) !== null
}

export async function resolveProtectedCredential<T>(
  request: Request,
  resolve: () => Promise<T | null>,
  options: ProtectedCredentialOptions = {},
): Promise<ProtectedCredentialResult<T>> {
  const clientIp = extractClientIpFromHeaders(request.headers)
  if (clientIp !== null && isIpBlocked(clientIp)) {
    return { status: "blocked", clientIp }
  }

  const credential = await resolve()
  if (credential !== null) {
    return { status: "authorized", clientIp, credential }
  }

  if (
    clientIp !== null
    && options.recordFailures !== false
    && !(await isRecognizedPrincipal(request))
  ) {
    recordFailedAttempt(clientIp)
  }
  return { status: "failed", clientIp }
}
