import { createHash, timingSafeEqual } from "node:crypto"

import { getConfig } from "./config"
import { getOAuthStore } from "./oauth-store"
import { state } from "./state"

export type CredentialKind =
  | "gateway"
  | "oauth"
  | "inference-client"
  | "worker"
  | "environment"
  | "admin"

export type ExternalCredentialKind = "worker" | "environment" | "admin"

export interface ResolvedCredential {
  principalId: string
  kind: CredentialKind
  scopes: ReadonlySet<string>
  metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface CredentialResolutionContext {
  environmentId?: string
  requireCsrf?: boolean
  requiredScopes?: ReadonlyArray<string>
  sessionId?: string
}

type ExternalCredentialProvider = (
  request: Request,
  context: CredentialResolutionContext,
) => Promise<ResolvedCredential | null> | ResolvedCredential | null

const externalCredentialProviders = new Map<
  ExternalCredentialKind,
  ExternalCredentialProvider
>()

const OAUTH_SCOPES = new Set([
  "user:inference",
  "user:profile",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "org:create_api_key",
])

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

function secretEquals(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right))
}

function configuredGatewayKeys(): Array<string> {
  const keys = state.apiKeyAuth ? [state.apiKeyAuth] : getConfig().auth?.apiKeys
  if (!Array.isArray(keys)) return []
  return [
    ...new Set(
      keys
        .filter((key) => typeof key === "string")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ]
}

function effectiveOAuthScopes(scopes: ReadonlyArray<string>): Set<string> {
  const effective = new Set(scopes.filter((scope) => OAUTH_SCOPES.has(scope)))
  // Claude Code's fixed production scope list predates the local voice route.
  // Treat inference entitlement as including transcription without widening the
  // scope string returned to the client.
  if (effective.has("user:inference")) effective.add("voice:transcribe")
  return effective
}

export function credentialHasScopes(
  credential: ResolvedCredential,
  requiredScopes: ReadonlyArray<string>,
): boolean {
  return (
    credential.kind === "gateway"
    || requiredScopes.every((scope) => credential.scopes.has(scope))
  )
}

export function isGoogleApiCredentialPath(pathname: string): boolean {
  return /^\/(?:v1\/|v1beta\/)?models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens)\/?$/.test(
    pathname,
  )
}

export function hasSuppliedRequestCredential(request: Request): boolean {
  if (
    ["authorization", "x-api-key", "x-goog-api-key"].some((header) =>
      request.headers.has(header),
    )
  ) {
    return true
  }

  const url = new URL(request.url)
  return (
    isGoogleApiCredentialPath(url.pathname)
    && url.searchParams.getAll("key").some((value) => value.trim() !== "")
  )
}

export function extractRequestCredential(request: Request): string | null {
  const candidates = [
    request.headers.get("x-api-key")?.trim(),
    request.headers.get("x-goog-api-key")?.trim(),
  ].filter(
    (candidate): candidate is string =>
      candidate !== undefined && candidate !== "",
  )
  const authorization = request.headers.get("authorization")
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/)
    if (scheme.toLowerCase() !== "bearer") return null
    const bearerToken = rest.join(" ").trim()
    if (!bearerToken) return null
    candidates.push(bearerToken)
  }

  const url = new URL(request.url)
  if (isGoogleApiCredentialPath(url.pathname)) {
    candidates.push(
      ...url.searchParams
        .getAll("key")
        .map((candidate) => candidate.trim())
        .filter(Boolean),
    )
  }

  const uniqueCandidates = [...new Set(candidates)]
  if (uniqueCandidates.length !== 1) return null
  return uniqueCandidates[0] ?? null
}

export async function resolveCredential(
  rawCredential: string,
  requiredScopes: ReadonlyArray<string> = [],
): Promise<ResolvedCredential | null> {
  const gatewayCredential = resolveGatewayCredential(
    rawCredential,
    requiredScopes,
  )
  if (gatewayCredential) return gatewayCredential
  if (!rawCredential) return null

  const store = getOAuthStore()
  const oauthCredential = await store.resolveAccessToken(rawCredential)
  if (oauthCredential) {
    const credential: ResolvedCredential = {
      principalId: oauthCredential.principalId,
      kind: "oauth",
      scopes: effectiveOAuthScopes(oauthCredential.scopes),
    }
    return credentialHasScopes(credential, requiredScopes) ? credential : null
  }

  const inferenceCredential =
    await store.resolveInferenceCredential(rawCredential)
  if (inferenceCredential) {
    const credential: ResolvedCredential = {
      principalId: inferenceCredential.principalId,
      kind: "inference-client",
      scopes: new Set(
        inferenceCredential.scopes.filter(
          (scope) => scope === "user:inference",
        ),
      ),
    }
    return credentialHasScopes(credential, requiredScopes) ? credential : null
  }

  return null
}

export function resolveGatewayCredential(
  rawCredential: string,
  requiredScopes: ReadonlyArray<string> = [],
): ResolvedCredential | null {
  const normalizedCredential = rawCredential.trim()
  if (!normalizedCredential) return null
  for (const gatewayKey of configuredGatewayKeys()) {
    if (!secretEquals(normalizedCredential, gatewayKey)) continue
    const credential: ResolvedCredential = {
      principalId: `gateway:${digest(gatewayKey).toString("hex").slice(0, 16)}`,
      kind: "gateway",
      scopes: new Set(["*"]),
    }
    return credentialHasScopes(credential, requiredScopes) ? credential : null
  }
  return null
}

export async function resolveRequestCredential(
  request: Request,
  requiredScopes: ReadonlyArray<string> = [],
): Promise<ResolvedCredential | null> {
  const rawCredential = extractRequestCredential(request)
  if (!rawCredential) return null
  return await resolveCredential(rawCredential, requiredScopes)
}

export function registerCredentialProvider(
  kind: ExternalCredentialKind,
  provider: ExternalCredentialProvider,
): () => void {
  const previous = externalCredentialProviders.get(kind)
  externalCredentialProviders.set(kind, provider)
  return () => {
    if (externalCredentialProviders.get(kind) === provider) {
      if (previous) externalCredentialProviders.set(kind, previous)
      else externalCredentialProviders.delete(kind)
    }
  }
}

export async function resolveRequestCredentialKind(
  request: Request,
  kind: CredentialKind,
  context: CredentialResolutionContext = {},
): Promise<ResolvedCredential | null> {
  if (kind === "gateway" || kind === "oauth" || kind === "inference-client") {
    const credential = await resolveRequestCredential(
      request,
      context.requiredScopes,
    )
    return credential?.kind === kind ? credential : null
  }
  const provider = externalCredentialProviders.get(kind)
  if (!provider) return null
  const credential = await provider(request, context)
  return credential?.kind === kind ? credential : null
}
