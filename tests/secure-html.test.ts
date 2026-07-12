import { expect, test } from "bun:test"
import { Hono } from "hono"

import { secureHtml } from "../src/lib/secure-html"

function formActionDirective(response: Response): string | undefined {
  return response.headers
    .get("content-security-policy")
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("form-action "))
}

function createApp(formActionOrigin?: URL): Hono {
  const app = new Hono()
  app.onError((error) => {
    throw error
  })
  app.get("/", (c) => secureHtml(c, "<html></html>", formActionOrigin))
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
