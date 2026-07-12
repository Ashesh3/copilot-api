import { expect, test } from "bun:test"
import { Hono } from "hono"

import { secureHtml } from "../src/lib/secure-html"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"

function formActionDirective(response: Response): string | undefined {
  return response.headers
    .get("content-security-policy")
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("form-action "))
}

function createApp(formActionOrigin?: URL, html = "<html></html>"): Hono {
  const app = new Hono()
  app.onError((error) => {
    throw error
  })
  app.get("/", (c) => secureHtml(c, html, formActionOrigin))
  return app
}

test("secureHtml defaults form actions to self", async () => {
  const response = await createApp().request("/")

  expect(formActionDirective(response)).toBe("form-action 'self'")
})

test("secureHtml allows only the exact HTTP origin and strips URL details", async () => {
  const response = await createApp(
    new URL("http://localhost:43123/callback?code=test#fragment"),
  ).request("/")

  expect(formActionDirective(response)).toBe(
    "form-action 'self' http://localhost:43123",
  )
})

test("secureHtml does not emit a localhost port wildcard", async () => {
  const response = await createApp(
    new URL("http://localhost:43123/callback"),
  ).request("/")
  const directive = formActionDirective(response)

  expect(directive).not.toContain("localhost:*")
  expect(directive).not.toContain("http://localhost ")
})

test("secureHtml rejects non-HTTP form action origins", () => {
  expect(() => createApp(new URL("javascript:alert(1)")).request("/")).toThrow(
    new TypeError("formActionOrigin must use HTTP or HTTPS"),
  )
})

test("secureHtml does not rewrite script or style text as HTML", async () => {
  const script = String.raw`const reactTemplate = "<script><\/script>";`
  const style = String.raw`.example::before { content: "<style>"; }`
  const response = await createApp(
    undefined,
    `<html><head><script type="module">${script}</script><style>${style}</style></head></html>`,
  ).request("/")
  const body = await response.text()
  const nonce = response.headers
    .get("content-security-policy")
    ?.match(/script-src 'nonce-([^']+)'/)?.[1]

  expect(nonce).toBeTruthy()
  expect(body).toContain(
    `<script nonce="${nonce}" type="module">${script}</script>`,
  )
  expect(body).toContain(`<style nonce="${nonce}">${style}</style>`)
  expect(body.match(/ nonce=/g)).toHaveLength(2)
})

test("secureHtml preserves the generated dashboard bundle byte-for-byte", async () => {
  const response = await createApp(undefined, DASHBOARD_HTML).request("/")
  const body = await response.text()
  const nonce = response.headers
    .get("content-security-policy")
    ?.match(/script-src 'nonce-([^']+)'/)?.[1]

  expect(nonce).toBeTruthy()
  expect(body).toBe(
    DASHBOARD_HTML.replace("<script", `<script nonce="${nonce}"`).replace(
      "<style",
      `<style nonce="${nonce}"`,
    ),
  )
  expect(body).toContain(String.raw`f.innerHTML="<script><\/script>"`)
  expect(body.match(/ nonce=/g)).toHaveLength(2)
})
