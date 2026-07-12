import type { Context } from "hono"

import { randomBytes } from "node:crypto"

const NONCE_ATTRIBUTE = /\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null

  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ">") return index
  }

  return -1
}

function findRawTextClosingTag(
  html: string,
  start: number,
  tagName: "script" | "style",
): { start: number; end: number } | null {
  const pattern = new RegExp(`</${tagName}(?=[\\t\\n\\f\\r />])`, "gi")
  pattern.lastIndex = start
  const match = pattern.exec(html)
  if (!match) return null

  const end = findTagEnd(html, match.index + match[0].length)
  return end === -1 ? null : { start: match.index, end }
}

function addNonceToOpeningTag(openingTag: string, nonce: string): string {
  if (NONCE_ATTRIBUTE.test(openingTag)) {
    return openingTag.replace(NONCE_ATTRIBUTE, ` nonce="${nonce}"`)
  }

  return openingTag.replace(
    /^<(script|style)(?=[\t\n\f\r />])/i,
    `<$1 nonce="${nonce}"`,
  )
}

/**
 * Add a nonce only to real script/style elements. Their contents are HTML
 * raw-text, so strings such as React's `"<script><\\/script>"` must never be
 * interpreted as markup and rewritten.
 */
function nonceExecutableElements(html: string, nonce: string): string {
  const openingTag = /<(script|style)(?=[\t\n\f\r />])/gi
  let cursor = 0
  let secured = ""

  while (cursor < html.length) {
    openingTag.lastIndex = cursor
    const match = openingTag.exec(html)
    if (!match) {
      secured += html.slice(cursor)
      break
    }

    const tagName = match[1].toLowerCase() as "script" | "style"
    const openingEnd = findTagEnd(html, openingTag.lastIndex)
    if (openingEnd === -1) {
      secured += html.slice(cursor)
      break
    }

    secured += html.slice(cursor, match.index)
    secured += addNonceToOpeningTag(
      html.slice(match.index, openingEnd + 1),
      nonce,
    )

    const closingTag = findRawTextClosingTag(html, openingEnd + 1, tagName)
    if (!closingTag) {
      secured += html.slice(openingEnd + 1)
      break
    }

    secured += html.slice(openingEnd + 1, closingTag.end + 1)
    cursor = closingTag.end + 1
  }

  return secured
}

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
  const secured = nonceExecutableElements(html, nonce)
  const formAction =
    formActionOrigin ? `'self' ${formActionOrigin.origin}` : "'self'"

  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'; object-src 'none'`,
  )
  c.header("Cache-Control", "no-store")
  return c.html(secured)
}
