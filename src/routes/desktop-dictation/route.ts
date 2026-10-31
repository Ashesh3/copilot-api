import { Hono } from "hono"

import { desktopGatewayIssuer } from "~/lib/desktop-gateway-url"

import { authorizeDictation, type DictationAdmission } from "./authorization"
import { createDictationSession, releaseDictationSession } from "./session"
import { issueDictationTicket, redeemDictationTicket } from "./tickets"

export { desktopDictationWebSocket } from "./session"
export type { DesktopDictationSession } from "./session"

const PROTOCOL = "claude.dictation.v1"
const TICKET_PREFIX = "ticket."
const TICKET_PATH = "/user/dictation/ticket"
const STREAM_PATH = "/user/dictation/stream"
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" }

function rejection(status: number, message: string, code?: string): Response {
  return Response.json(
    {
      error: {
        type: status >= 500 ? "server_error" : "invalid_request_error",
        message,
        ...(code ? { code } : {}),
      },
    },
    { status, headers: NO_STORE },
  )
}

function deniedAdmission(
  admission: Exclude<DictationAdmission, { status: "authorized" }>,
): Response {
  if (admission.status === "unavailable")
    return rejection(
      503,
      "Database storage is temporarily unavailable.",
      "storage_unavailable",
    )
  return rejection(
    admission.status === "blocked" ? 403 : 401,
    "Authentication failed",
  )
}

function permittedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  return origin === null || origin === "app://localhost"
}

async function issueTicket(
  request: Request,
  prefix: string,
): Promise<Response> {
  if (!permittedOrigin(request)) return rejection(403, "Origin is not allowed")
  const admission = await authorizeDictation(request)
  if (admission.status !== "authorized") return deniedAdmission(admission)
  const ticket = issueDictationTicket({
    authenticationRequest: new Request(request.url, {
      headers: request.headers,
    }),
    authority: admission.authority,
    streamDestination: `${desktopGatewayIssuer(request, prefix)}${STREAM_PATH}`,
  })
  return Response.json({ ticket }, { headers: NO_STORE })
}

export const desktopDictationRoutes = new Hono()
for (const prefix of ["", "/v1"])
  desktopDictationRoutes.post(`${prefix}${TICKET_PATH}`, (context) =>
    issueTicket(context.req.raw, prefix),
  )

function presentedTicket(request: Request): string | undefined {
  const header = request.headers.get("sec-websocket-protocol")
  if (!header) return undefined
  const protocols = header.split(",").map((value) => value.trim())
  if (
    protocols.length !== 2
    || new Set(protocols).size !== 2
    || !protocols.includes(PROTOCOL)
  ) {
    return undefined
  }
  const ticket = protocols
    .find((value) => value.startsWith(TICKET_PREFIX))
    ?.slice(TICKET_PREFIX.length)
  return ticket && /^[\w-]{43}$/.test(ticket) ? ticket : undefined
}

function recordingLanguage(url: URL): string | undefined {
  const parameters = [...url.searchParams]
  if (
    parameters.length !== 4
    || new Set(parameters.map(([key]) => key)).size !== 4
  )
    return undefined
  if (
    url.searchParams.get("encoding") !== "linear16"
    || url.searchParams.get("sample_rate") !== "16000"
    || url.searchParams.get("channels") !== "1"
  ) {
    return undefined
  }
  const language = url.searchParams.get("language")
  return (
      language
        && language.length <= 35
        && /^(?:auto|[a-z]{2,3}(?:-[A-Za-z\d]{2,8}){0,3})$/.test(language)
    ) ?
      language.split("-", 1)[0]
    : undefined
}

export async function tryUpgradeDesktopDictationWebSocket(
  request: Request,
  server: { upgrade(request: Request, options?: object): boolean },
): Promise<"upgraded" | "no_match" | Response> {
  const url = new URL(request.url)
  const prefix = ["", "/v1"].find(
    (value) => url.pathname === `${value}${STREAM_PATH}`,
  )
  if (prefix === undefined) return "no_match"
  if (request.method !== "GET")
    return rejection(405, "A WebSocket GET is required")
  if (!permittedOrigin(request)) return rejection(403, "Origin is not allowed")
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return rejection(426, "A WebSocket upgrade is required")
  const ticket = presentedTicket(request)
  const language = recordingLanguage(url)
  if (!ticket || !language) return rejection(400, "Invalid dictation protocol")
  const binding = redeemDictationTicket(
    ticket,
    `${desktopGatewayIssuer(request, prefix)}${STREAM_PATH}`,
  )
  if (!binding) return rejection(401, "Dictation ticket is invalid or expired")
  const admission = await authorizeDictation(
    binding.authenticationRequest,
    binding.authority,
  )
  if (admission.status !== "authorized") return deniedAdmission(admission)
  const session = createDictationSession(binding, language)
  try {
    if (
      server.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": PROTOCOL },
        data: { type: "desktop-dictation" as const, session },
      })
    )
      return "upgraded"
  } catch {
    releaseDictationSession(session)
    return rejection(400, "Dictation upgrade failed")
  }
  releaseDictationSession(session)
  return rejection(400, "Dictation upgrade failed")
}
