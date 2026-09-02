import { afterEach, expect, mock, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { resolveCopilotOAuth } from "../src/services/github/resolve-copilot-oauth"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("resolves public OAuth through Copilot user discovery and reuses the bearer", async () => {
  const requests: Array<Request> = []
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ?
          new Request(input, init)
        : new Request(input.toString(), init)
      requests.push(request)
      if (request.url === "https://api.github.com/copilot_internal/user") {
        return Promise.resolve(
          Response.json({
            endpoints: { api: "https://api.enterprise.githubcopilot.com" },
            login: "public-user",
          }),
        )
      }
      return Promise.resolve(
        Response.json({ data: [{ id: "gpt-test" }], object: "list" }),
      )
    },
  ) as unknown as typeof fetch

  const result = await resolveCopilotOAuth({
    accountType: "individual",
    githubToken: "gho_public",
    instanceDomain: "github.com",
  })

  expect(requests.map(({ url }) => url)).toEqual([
    "https://api.github.com/copilot_internal/user",
    "https://api.enterprise.githubcopilot.com/models",
  ])
  expect(
    requests.map((request) => request.headers.get("authorization")),
  ).toEqual(["Bearer gho_public", "Bearer gho_public"])
  expect(requests[1]?.headers.get("copilot-integration-id")).toBe(
    "copilot-developer-cli",
  )
  expect(requests[1]?.headers.get("copilot-harness-id")).toBe("copilot-sdk")
  expect(result).toMatchObject({
    baseUrl: "https://api.enterprise.githubcopilot.com",
    login: "public-user",
    token: "gho_public",
  })
})

test("does not fall back to the legacy token exchange after a public 403", async () => {
  const urls: Array<string> = []
  globalThis.fetch = mock((input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : input.toString())
    return Promise.resolve(new Response("forbidden", { status: 403 }))
  }) as unknown as typeof fetch

  const error = await resolveCopilotOAuth({
    accountType: "individual",
    githubToken: "gho_public",
    instanceDomain: "github.com",
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as Error).message).toBe(
    "Failed to get Copilot user information (HTTP 403)",
  )
  expect(urls).toEqual(["https://api.github.com/copilot_internal/user"])
})

test("ignores an untrusted discovered endpoint before sending the bearer", async () => {
  const requests: Array<Request> = []
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ?
          new Request(input, init)
        : new Request(input.toString(), init)
      requests.push(request)
      if (request.url === "https://api.github.com/copilot_internal/user") {
        return Promise.resolve(
          Response.json({
            endpoints: { api: "https://credential-stealer.example" },
          }),
        )
      }
      return Promise.resolve(Response.json({ data: [], object: "list" }))
    },
  ) as unknown as typeof fetch

  await resolveCopilotOAuth({
    accountType: "business",
    githubToken: "ghu_public",
    instanceDomain: "github.com",
  })

  expect(requests[1]?.url).toBe("https://api.business.githubcopilot.com/models")
  expect(requests.some(({ url }) => url.includes("credential-stealer"))).toBe(
    false,
  )
})
