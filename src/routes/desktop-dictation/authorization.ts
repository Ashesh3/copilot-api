import type { ResolvedCredential } from "~/lib/credential-resolver"
import type { RuntimeSnapshot } from "~/lib/storage/types"

import { resolveRequestCredential } from "~/lib/credential-resolver"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { getStorageRuntime } from "~/lib/storage/runtime"

export interface DictationAuthority {
  principalId: string
  kind: ResolvedCredential["kind"]
}

export type DictationAdmission =
  | {
      status: "authorized"
      authority: DictationAuthority
      snapshot: RuntimeSnapshot
    }
  | { status: "unauthorized" | "blocked" | "unavailable" }

export async function authorizeDictation(
  request: Request,
  expected?: DictationAuthority,
): Promise<DictationAdmission> {
  try {
    const runtime = getStorageRuntime()
    await runtime.snapshot.refreshIfChanged()
    const result = await resolveProtectedCredential(
      request,
      () => resolveRequestCredential(request, ["user:inference"]),
      { recordFailures: expected === undefined },
    )
    if (result.status !== "authorized") {
      return {
        status: result.status === "blocked" ? "blocked" : "unauthorized",
      }
    }
    const { principalId, kind } = result.credential
    if (
      expected
      && (expected.principalId !== principalId || expected.kind !== kind)
    ) {
      return { status: "unauthorized" }
    }
    return {
      status: "authorized",
      authority: { principalId, kind },
      snapshot: runtime.snapshot.get(),
    }
  } catch {
    return { status: "unavailable" }
  }
}
