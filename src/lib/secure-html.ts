import type { Context } from "hono"

import { randomBytes } from "node:crypto"

export function secureHtml(
  c: Context,
  html: string,
  formActionOrigin?: URL,
): Response {
  if (
    formActionOrigin
    && formActionOrigin.protocol !== "http:"
    && formActionOrigin.protocol !== "https:"
  ) {
    throw new TypeError("formActionOrigin must use HTTP or HTTPS")
  }

  const nonce = randomBytes(18).toString("base64url")
  const nonceAttribute = ` nonce="${nonce}"`
  const secured = html
    .replaceAll("<script", `<script${nonceAttribute}`)
    .replaceAll("<style", `<style${nonceAttribute}`)
  const formAction =
    formActionOrigin ? `'self' ${formActionOrigin.origin}` : "'self'"

  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'; object-src 'none'`,
  )
  c.header("Cache-Control", "no-store")
  return c.html(secured)
}
