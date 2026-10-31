import type { Context } from "hono"

import { Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { randomBytes, timingSafeEqual } from "node:crypto"

import { resolveCredential } from "~/lib/credential-resolver"
import { desktopGatewayIssuer } from "~/lib/desktop-gateway-url"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { secureHtml } from "~/lib/secure-html"
import { getDesktopGatewayAuthRepository } from "~/lib/storage/desktop-gateway-auth-repository"

import { gatewayVerificationPage } from "./page"

const CSRF_COOKIE = "claude_gateway_csrf"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

type FormResult =
  | { fields: Record<string, string | undefined> }
  | { error: "invalid_request"; status: 400 }

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
}

function errorResponse(
  c: Context,
  error: string,
  status: 400 | 401 | 403 = 400,
) {
  noStore(c)
  return c.json({ error }, status)
}

async function readForm(request: Request): Promise<FormResult> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase()
  if (contentType !== "application/x-www-form-urlencoded")
    return { error: "invalid_request", status: 400 }
  let text: string
  try {
    text = await request.text()
  } catch {
    return { error: "invalid_request", status: 400 }
  }
  const parameters = new URLSearchParams(text)
  const fields = Object.create(null) as Record<string, string | undefined>
  for (const [name, value] of parameters) {
    if (Object.hasOwn(fields, name))
      return { error: "invalid_request", status: 400 }
    fields[name] = value
  }
  return { fields }
}

function csrfMatches(
  c: Context,
  value: string | undefined,
  issuer: string,
): boolean {
  if (c.req.header("origin") !== new URL(issuer).origin) return false
  const cookie = getCookie(c, CSRF_COOKIE)
  if (
    !cookie
    || !value
    || !/^[\w-]{43}$/.test(value)
    || !/^[\w-]{43}$/.test(cookie)
  )
    return false
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(value))
}

function verificationPage(
  c: Context,
  issuer: string,
  options: { userCode: string; message?: string; status?: 200 | 400 | 401 },
): Response {
  const csrfToken = randomBytes(32).toString("base64url")
  setCookie(c, CSRF_COOKIE, csrfToken, {
    httpOnly: true,
    secure: new URL(issuer).protocol === "https:",
    sameSite: "Strict",
    path: `${new URL(issuer).pathname.replace(/\/+$/, "")}/gateway/oauth`,
    maxAge: 300,
  })
  const response = secureHtml(
    c,
    gatewayVerificationPage({
      actionUrl: `${issuer}/gateway/oauth/verify`,
      csrfToken,
      userCode: options.userCode,
      message: options.message,
    }),
  )
  return new Response(response.body, {
    status: options.status ?? 200,
    headers: response.headers,
  })
}

async function verify(c: Context, issuer: string): Promise<Response> {
  const form = await readForm(c.req.raw)
  if ("error" in form) return errorResponse(c, form.error, form.status)
  const { fields } = form
  if (!csrfMatches(c, fields.csrf_token, issuer))
    return errorResponse(c, "invalid_request", 403)
  if (
    !fields.user_code
    || fields.user_code.length > 64
    || (fields.action !== "approve" && fields.action !== "deny")
  )
    return errorResponse(c, "invalid_request")
  const apiKey = fields.api_key ?? ""
  const authRequest = new Request(c.req.url, { headers: c.req.raw.headers })
  authRequest.headers.delete("x-api-key")
  authRequest.headers.delete("x-goog-api-key")
  try {
    authRequest.headers.set("authorization", `Bearer ${apiKey}`)
  } catch {
    return errorResponse(c, "invalid_request")
  }
  const auth = await resolveProtectedCredential(
    authRequest,
    async () => await resolveCredential(apiKey, ["user:inference"]),
    { trustClientIp: true },
  )
  if (auth.status !== "authorized")
    return verificationPage(c, issuer, {
      userCode: fields.user_code,
      message: "The gateway key was not accepted. Try again.",
      status: 401,
    })
  const result =
    await getDesktopGatewayAuthRepository().approveDeviceAuthorization({
      issuer,
      userCode: fields.user_code,
      issuerKey: apiKey,
      action: fields.action === "deny" ? "deny" : "approve",
    })
  if (result.status === "invalid_credential")
    return verificationPage(c, issuer, {
      userCode: fields.user_code,
      message: "The gateway key was not accepted. Try again.",
      status: 401,
    })
  if (result.status === "invalid_code")
    return verificationPage(c, issuer, {
      userCode: fields.user_code,
      message:
        "This code is invalid or has expired. Start sign-in again in Claude.",
      status: 400,
    })
  deleteCookie(c, CSRF_COOKIE, {
    path: `${new URL(issuer).pathname.replace(/\/+$/, "")}/gateway/oauth`,
  })
  return secureHtml(
    c,
    gatewayVerificationPage({
      actionUrl: "",
      csrfToken: "",
      userCode: "",
      complete: true,
      message:
        result.status === "approved" ?
          "Sign-in approved. Return to Claude Desktop to continue."
        : "Sign-in denied. You can close this tab.",
    }),
  )
}

async function token(c: Context, issuer: string): Promise<Response> {
  const form = await readForm(c.req.raw)
  if ("error" in form) return errorResponse(c, form.error, form.status)
  const { fields } = form
  const clientId = fields.client_id || undefined
  if (clientId && clientId.length > 256)
    return errorResponse(c, "invalid_request")
  const repository = getDesktopGatewayAuthRepository()
  const deviceCode = fields.device_code ?? ""
  const refreshToken = fields.refresh_token ?? ""
  if (
    fields.grant_type !== DEVICE_GRANT
    && fields.grant_type !== "refresh_token"
  )
    return errorResponse(c, "unsupported_grant_type")
  if (fields.grant_type === DEVICE_GRANT ? !deviceCode : !refreshToken)
    return errorResponse(c, "invalid_request")
  const result =
    fields.grant_type === DEVICE_GRANT ?
      await repository.exchangeDeviceCode({
        issuer,
        deviceCode,
        clientId,
      })
    : await repository.refresh({
        issuer,
        refreshToken,
        clientId,
      })
  if (result.status !== "ok") return errorResponse(c, result.status)
  noStore(c)
  return c.json({
    access_token: result.tokens.accessToken,
    refresh_token: result.tokens.refreshToken,
    expires_in: result.tokens.expiresIn,
    refresh_token_expires_in: result.tokens.refreshTokenExpiresIn,
    token_type: "Bearer",
    scope: result.tokens.scopes.join(" "),
  })
}

export const gatewayAuthRoutes = new Hono()

for (const prefix of ["", "/v1"]) {
  gatewayAuthRoutes.get(
    `${prefix}/.well-known/oauth-authorization-server`,
    (c) => {
      const issuer = desktopGatewayIssuer(c.req.raw, prefix)
      noStore(c)
      return c.json({
        issuer,
        device_authorization_endpoint: `${issuer}/gateway/oauth/device`,
        token_endpoint: `${issuer}/gateway/oauth/token`,
        revocation_endpoint: `${issuer}/gateway/oauth/revoke`,
        grant_types_supported: [DEVICE_GRANT, "refresh_token"],
        scopes_supported: ["user:inference"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
      })
    },
  )
  gatewayAuthRoutes.post(`${prefix}/gateway/oauth/device`, async (c) => {
    const form = await readForm(c.req.raw)
    if ("error" in form) return errorResponse(c, form.error, form.status)
    const clientId = form.fields.client_id || undefined
    if (clientId && clientId.length > 256)
      return errorResponse(c, "invalid_request")
    if (form.fields.scope && form.fields.scope !== "user:inference")
      return errorResponse(c, "invalid_scope")
    const issuer = desktopGatewayIssuer(c.req.raw, prefix)
    const device =
      await getDesktopGatewayAuthRepository().issueDeviceAuthorization({
        issuer,
        clientId,
      })
    const verificationUri = `${issuer}/gateway/oauth/verify`
    noStore(c)
    return c.json({
      device_code: device.deviceCode,
      user_code: device.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: device.userCode }).toString()}`,
      expires_in: device.expiresIn,
      interval: device.interval,
    })
  })
  gatewayAuthRoutes.get(`${prefix}/gateway/oauth/verify`, (c) => {
    const codes = new URL(c.req.url).searchParams.getAll("user_code")
    if (codes.length > 1 || (codes[0]?.length ?? 0) > 64)
      return errorResponse(c, "invalid_request")
    return verificationPage(c, desktopGatewayIssuer(c.req.raw, prefix), {
      userCode: codes[0] ?? "",
    })
  })
  gatewayAuthRoutes.post(`${prefix}/gateway/oauth/verify`, (c) =>
    verify(c, desktopGatewayIssuer(c.req.raw, prefix)),
  )
  gatewayAuthRoutes.post(`${prefix}/gateway/oauth/token`, (c) =>
    token(c, desktopGatewayIssuer(c.req.raw, prefix)),
  )
  gatewayAuthRoutes.post(`${prefix}/gateway/oauth/revoke`, async (c) => {
    const form = await readForm(c.req.raw)
    if ("error" in form) return errorResponse(c, form.error, form.status)
    if (!form.fields.token) return errorResponse(c, "invalid_request")
    await getDesktopGatewayAuthRepository().revoke({
      issuer: desktopGatewayIssuer(c.req.raw, prefix),
      token: form.fields.token,
      clientId: form.fields.client_id || undefined,
    })
    noStore(c)
    return c.json({})
  })
}
