import { afterEach, beforeEach, expect, test } from "bun:test"

import type { DesktopDictationSession } from "../src/routes/desktop-dictation/route"

import { mergeConfigWithDefaults } from "../src/lib/config"
import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { insertGatewayCredential } from "../src/lib/storage/credentials-repository"
import { server } from "../src/server"
import { combinedWebSocket, handleStartFetch } from "../src/start"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const origin = "http://127.0.0.1:4141"
const originalApiKeyAuth = state.apiKeyAuth
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  await mergeConfigWithDefaults()
  resetIpSecurityForTest()
  state.apiKeyAuth = "desktop-start-fixture"
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: "desktop-start-key",
      credential: "desktop-start-fixture",
      label: "start fixture",
      createdAt: 0,
    }),
  )
})

afterEach(async () => {
  state.apiKeyAuth = originalApiKeyAuth
  resetIpSecurityForTest()
  await fixture.close()
})

for (const prefix of ["", "/v1"]) {
  test(`start dispatches the native ${prefix || "root"} dictation handshake and close`, async () => {
    const ticketResponse = await server.request(
      `${origin}${prefix}/user/dictation/ticket`,
      {
        method: "POST",
        headers: { authorization: "Bearer desktop-start-fixture" },
      },
    )
    expect(ticketResponse.status).toBe(200)
    const { ticket } = (await ticketResponse.json()) as { ticket: string }
    let data: { type: string; session: DesktopDictationSession } | undefined
    const selected = { protocol: "" }
    const upgrade = await handleStartFetch(
      new Request(
        `${origin}${prefix}/user/dictation/stream?encoding=linear16&sample_rate=16000&channels=1&language=en`,
        {
          headers: {
            upgrade: "websocket",
            origin: "app://localhost",
            "sec-websocket-protocol": `claude.dictation.v1, ticket.${ticket}`,
          },
        },
      ),
      {
        requestIP: () => ({ address: "127.0.0.1" }),
        upgrade(_request, options) {
          const value = options as {
            data: typeof data
            headers: Record<string, string>
          }
          data = value.data
          selected.protocol =
            new Headers(value.headers).get("sec-websocket-protocol") ?? ""
          return true
        },
      },
    )
    expect(upgrade).toBeUndefined()
    expect(selected.protocol).toBe("claude.dictation.v1")
    if (!data) throw new Error("Native dictation was not upgraded")
    expect(data.type).toBe("desktop-dictation")
    const messages: Array<string> = []
    const completion = Promise.withResolvers<number>()
    const socket = {
      data,
      send(message: string | ArrayBuffer | Uint8Array) {
        if (typeof message === "string") messages.push(message)
      },
      close(code = 1000) {
        completion.resolve(code)
      },
    }
    combinedWebSocket.open(socket)
    combinedWebSocket.message(socket, JSON.stringify({ type: "CloseStream" }))
    expect(await completion.promise).toBe(1000)
    expect(messages.map((message) => JSON.parse(message) as unknown)).toEqual([
      { type: "TranscriptEndpoint" },
    ])
    combinedWebSocket.close(socket)
    expect(data.session.phase).toBe("released")
  })
}

test("start preserves native dictation protocol errors before ordinary inference routing", async () => {
  const response = await handleStartFetch(
    new Request(`${origin}/user/dictation/stream?encoding=bad`, {
      headers: { upgrade: "websocket", origin: "app://localhost" },
    }),
    {
      requestIP: () => ({ address: "127.0.0.1" }),
      upgrade: () => {
        throw new Error("Malformed stream must not upgrade")
      },
    },
  )
  expect(response.status).toBe(400)
  expect(response.headers.get("cache-control")).toBe("no-store")
})
