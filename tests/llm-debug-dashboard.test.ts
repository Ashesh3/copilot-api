import { afterAll, beforeEach, expect, test } from "bun:test"

import { clearLlmDebugLogs, startLlmDebugLog } from "../src/lib/llm-debug-log"
import { state } from "../src/lib/state"
import { getDashboardPage } from "../src/routes/dashboard/page"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth

beforeEach(() => {
  clearLlmDebugLogs()
  state.apiKeyAuth = undefined
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
})

test("serves LLM debug logs through dashboard API", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ input: "dashboard lookup", model: "gpt-ui" }),
    requestHeaders: { authorization: "Bearer raw-token" },
    requestId: "req-dashboard",
    url: "https://example.test/responses",
  })

  const listResponse = await server.request("/dashboard/api/llm-debug")
  expect(listResponse.status).toBe(200)
  const listBody = (await listResponse.json()) as {
    entries: Array<{ id: string; requestPreview: string }>
  }
  expect(listBody.entries[0]?.id).toBe(id)
  expect(listBody.entries[0]?.requestPreview).toContain("dashboard lookup")

  const detailResponse = await server.request(`/dashboard/api/llm-debug/${id}`)
  expect(detailResponse.status).toBe(200)
  const detailBody = (await detailResponse.json()) as {
    request: { headers: Record<string, string> }
  }
  expect(detailBody.request.headers.authorization).toBe("Bearer raw-token")

  const clearResponse = await server.request("/dashboard/api/llm-debug", {
    method: "DELETE",
  })
  expect(clearResponse.status).toBe(200)

  const afterClearResponse = await server.request("/dashboard/api/llm-debug")
  const afterClearBody = (await afterClearResponse.json()) as { count: number }
  expect(afterClearBody.count).toBe(0)
})

test("renders LLM debug copy helper without an inline script syntax break", () => {
  const page = getDashboardPage()

  expect(page).toContain("rows.join(String.fromCharCode(10))")
  expect(page).not.toContain("rows.join('\n')")
})
