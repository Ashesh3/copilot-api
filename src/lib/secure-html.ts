import type { Context } from "hono"

import { randomBytes } from "node:crypto"

export function secureHtml(c: Context, html: string): Response {
  const nonce = randomBytes(18).toString("base64url")
  const nonceAttribute = ` nonce="${nonce}"`
  const secured = html
    .replaceAll("<script", `<script${nonceAttribute}`)
    .replaceAll("<style", `<style${nonceAttribute}`)

  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
  )
  c.header("Cache-Control", "no-store")
  return c.html(secured)
}
