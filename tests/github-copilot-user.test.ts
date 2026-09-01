import { afterEach, expect, mock, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { getCopilotUsage } from "../src/services/github/get-copilot-usage"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("fetches enterprise Copilot user metadata with an OAuth bearer", async () => {
  let request: Request | undefined
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      request =
        input instanceof Request ?
          new Request(input, init)
        : new Request(input.toString(), init)
      return Promise.resolve(
        Response.json({
          login: "enterprise-user",
          endpoints: { api: "https://copilot-api.msft.ghe.com" },
        }),
      )
    },
  ) as unknown as typeof fetch

  const result = await getCopilotUsage("gho_enterprise", "msft.ghe.com")

  expect(request?.url).toBe("https://api.msft.ghe.com/copilot_internal/user")
  expect(request?.headers.get("authorization")).toBe("Bearer gho_enterprise")
  expect(result.login).toBe("enterprise-user")
  expect(result.endpoints?.api).toBe("https://copilot-api.msft.ghe.com")
})

test("includes the safe HTTP status when Copilot user discovery fails", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("private response", { status: 403 })),
  ) as unknown as typeof fetch

  const error = await getCopilotUsage("gho_enterprise", "msft.ghe.com").catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as Error).message).toBe(
    "Failed to get Copilot user information (HTTP 403)",
  )
  expect((error as Error).message).not.toContain("private response")
})
