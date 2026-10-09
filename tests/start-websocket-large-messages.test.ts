import { expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { combinedWebSocket } from "~/start"

// Request sizes Codex Desktop sent after long chats grew past Bun's default
// 16 MiB WebSocket message limit. Bun dropped both with close code 1006
// before the gateway saw them, so Codex retried 5 times and fell back to HTTP.
test.each([16_918_411, 17_150_321])(
  "Responses WebSocket handles a %d-byte request frame",
  async (bytes) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const data: ResponsesWebSocketData = {
          activeTurns: new Map(),
          closed: false,
          nextTurnSequence: 0,
          type: "responses",
          requestId: "req-large-frame",
          nativeMessagesOptions: {},
          effectiveNativeMessagesOptions: {},
          responseSnapshots: new Map(),
        }
        return srv.upgrade(req, { data }) ? undefined : (
            new Response("Upgrade failed", { status: 400 })
          )
      },
      websocket: combinedWebSocket,
    })
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/responses`)
    try {
      const outcome = await new Promise<unknown>((resolve) => {
        socket.addEventListener("open", () => {
          socket.send(createUnsupportedFrame(bytes))
        })
        socket.addEventListener("message", (event) => {
          resolve(JSON.parse(String(event.data)))
        })
        socket.addEventListener("close", (event) => {
          resolve({ closeCode: event.code })
        })
      })

      expect(outcome).toEqual({
        type: "error",
        status: 400,
        error: {
          code: "bad_request",
          message: "Unsupported message type",
          type: "invalid_request_error",
          request_id: "req-large-frame",
        },
      })
    } finally {
      socket.close()
      await server.stop(true)
    }
  },
)

function createUnsupportedFrame(bytes: number): string {
  const prefix = '{"type":"response.unsupported","padding":"'
  const suffix = '"}'
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`
}
