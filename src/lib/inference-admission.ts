import type { Context } from "hono"

import type { ResolvedCredential } from "~/lib/credential-resolver"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { extractClientIp } from "~/lib/ip-blocker"

interface VerifiedAdmission {
  rawCredential: string | null
  clientIp: string | null
  credential: ResolvedCredential
}

// Hono creates a new context for every dispatch, including repeated use of the
// same Request. Entries exist only while the first guard awaits its next step.
const admissions = new WeakMap<Context, VerifiedAdmission>()

export function getVerifiedInferenceAdmission(
  context: Context,
): ResolvedCredential | undefined {
  const admission = admissions.get(context)
  if (
    admission?.rawCredential === extractRequestCredential(context.req.raw)
    && admission.clientIp === extractClientIp(context)
  )
    return admission.credential
  return undefined
}

export async function withVerifiedInferenceAdmission<T>(
  context: Context,
  admission: VerifiedAdmission,
  work: () => Promise<T>,
): Promise<T> {
  const previous = admissions.get(context)
  admissions.set(context, admission)
  try {
    return await work()
  } finally {
    if (previous) admissions.set(context, previous)
    else admissions.delete(context)
  }
}
