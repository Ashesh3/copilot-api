import { afterAll, beforeAll, expect, test } from "bun:test"

import { interceptEngine } from "~/lib/intercept/engine"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

let session: TestAdminSession

beforeAll(async () => {
  session = await createTestAdminSession()
})

afterAll(async () => {
  interceptEngine.resetForTest()
  await resetTestAdminSession()
})

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes(marker)) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

async function readToEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
}

test("the event stream stops delivering once its session logs out", async () => {
  const response = await server.request("/dashboard/api/intercept/events", {
    headers: adminHeaders(session, false),
  })
  expect(response.status).toBe(200)
  const body = response.body
  if (!body) throw new Error("No event stream")
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  expect(await readUntil(reader, "event: snapshot")).toContain(
    "event: snapshot",
  )

  const logout = await server.request("/dashboard/auth/logout", {
    method: "POST",
    headers: adminHeaders(session),
  })
  expect(logout.ok).toBe(true)
  interceptEngine.updateConfig({ direction: "response" })

  const timeout = Bun.sleep(3000).then(() => "timed out")
  const rest = await Promise.race([readToEnd(reader), timeout])
  expect(rest).not.toBe("timed out")
  expect(rest).not.toContain("event: config")
})
