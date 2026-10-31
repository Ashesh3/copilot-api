import { resolvePublicOrigin } from "./public-origin"

export function desktopGatewayIssuer(request: Request, prefix: string): string {
  const publicBase = resolvePublicOrigin(request)
  const path = publicBase.pathname.replace(/\/+$/, "")
  return `${publicBase.origin}${path}${prefix}`
}
