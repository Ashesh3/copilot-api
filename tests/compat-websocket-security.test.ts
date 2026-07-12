import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  authenticateAdminRequest,
  setAdminAuthTestMode,
  setupAdminAuth,
} from "../src/lib/admin-auth"
import { state } from "../src/lib/state"
import {
  addClientEvents,
  createSession,
  getClientEvents,
  SESSION_EVENT_HISTORY_MAX_EVENTS,
} from "../src/routes/code-sessions/session-store"
import { directConnectRoutes } from "../src/routes/direct-connect/route"
import {
  createDirectConnectSession,
  handleDirectConnectWebSocket,
  releaseDirectConnectConnection,
  reserveDirectConnectConnection,
  resetDirectConnectForTest,
} from "../src/routes/direct-connect/ws-handler"
import { healthRoutes } from "../src/routes/health/route"
import {
  mintRemoteWebSocketTicket,
  resetRemoteWebSocketSecurityForTest,
  tryUpgradeRemoteWebSocket,
} from "../src/routes/remote/ws-security"
import {
  resetVoiceConnectionsForTest,
  tryUpgradeVoiceWebSocket,
  type VoiceSession,
  VOICE_MAX_AUDIO_BYTES,
  voiceWebSocket,
} from "../src/routes/voice/route"

const originalGatewayKey = state.apiKeyAuth
const originalDirectConnect = process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
const originalAdminOrigin = process.env.COPILOT_ADMIN_ORIGIN
const TEST_ADMIN_ORIGIN = "https://admin.example.test"
let adminCookie = ""

function voiceUpgradeRequest(): Request {
  return new Request("http://localhost/api/ws/speech_to_text/voice_stream", {
    headers: { authorization: "Bearer gateway-secret" },
  })
}

beforeEach(async () => {
  state.apiKeyAuth = "gateway-secret"
  process.env.COPILOT_ADMIN_ORIGIN = TEST_ADMIN_ORIGIN
  setAdminAuthTestMode(true)
  const setup = await setupAdminAuth(
    "gateway-secret",
    "correct horse battery staple",
  )
  if ("error" in setup) throw new Error(setup.error)
  adminCookie = `__Host-copilot_admin=${setup.session.token}; __Host-copilot_admin_csrf=${setup.session.csrfToken}`
  resetRemoteWebSocketSecurityForTest()
  resetVoiceConnectionsForTest()
  resetDirectConnectForTest()
  delete process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
})

afterEach(() => {
  state.apiKeyAuth = originalGatewayKey
  setAdminAuthTestMode(false)
  if (originalDirectConnect === undefined) {
    delete process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
  } else {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = originalDirectConnect
  }
  if (originalAdminOrigin === undefined) {
    delete process.env.COPILOT_ADMIN_ORIGIN
  } else {
    process.env.COPILOT_ADMIN_ORIGIN = originalAdminOrigin
  }
})

describe("health and Direct Connect exposure", () => {
  test("health exposes only the exact liveness response", async () => {
    const response = await healthRoutes.request("http://localhost/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(
      (await healthRoutes.request("http://localhost/api/sessions")).status,
    ).toBe(404)
    expect(
      (
        await healthRoutes.request("http://localhost/health", {
          method: "HEAD",
        })
      ).status,
    ).toBe(404)
  })

  test("Direct Connect is unavailable unless explicitly enabled", async () => {
    expect(
      (await directConnectRoutes.request("http://localhost/api/sessions"))
        .status,
    ).toBe(404)
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    expect(
      (
        await directConnectRoutes.request("http://localhost/api/sessions", {
          headers: { authorization: "Bearer gateway-secret" },
        })
      ).status,
    ).toBe(200)
  })

  test("Direct Connect reserves only existing sessions and caps controllers", () => {
    expect(reserveDirectConnectConnection("dc_missing")).toBe(false)
    const session = createDirectConnectSession()
    expect(reserveDirectConnectConnection(session.session_id)).toBe(true)
    expect(reserveDirectConnectConnection(session.session_id)).toBe(false)
    releaseDirectConnectConnection(session.session_id)
    expect(reserveDirectConnectConnection(session.session_id)).toBe(true)
  })

  test("Direct Connect closes binary frames without logging their contents", () => {
    const session = createDirectConnectSession()
    expect(reserveDirectConnectConnection(session.session_id)).toBe(true)
    const close = mock(() => {})
    const handlers = handleDirectConnectWebSocket(
      { send: () => {}, close },
      session.session_id,
    )
    handlers.onMessage(new Uint8Array([1, 2, 3]))
    expect(close).toHaveBeenCalledWith(4007, "Binary frames not supported")
    handlers.onClose()
  })
})

describe("voice WebSocket security", () => {
  test("rejects missing credentials before allocating a session", async () => {
    const upgrade = mock(() => true)
    const result = await tryUpgradeVoiceWebSocket(
      new Request("http://localhost/api/ws/speech_to_text/voice_stream"),
      { upgrade },
    )
    expect(result).toBe("auth_failed")
    expect(upgrade).not.toHaveBeenCalled()
  })

  test("accepts a scoped gateway principal and applies the connection cap", async () => {
    const upgrade = mock(() => true)
    expect(
      await tryUpgradeVoiceWebSocket(voiceUpgradeRequest(), { upgrade }),
    ).toBe("upgraded")
    expect(
      await tryUpgradeVoiceWebSocket(voiceUpgradeRequest(), { upgrade }),
    ).toBe("upgraded")
    expect(
      await tryUpgradeVoiceWebSocket(voiceUpgradeRequest(), { upgrade }),
    ).toBe("limit_reached")
    expect(upgrade).toHaveBeenCalledTimes(2)
  })

  test("closes and clears a stream that exceeds the aggregate audio cap", () => {
    const close = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [new Uint8Array(VOICE_MAX_AUDIO_BYTES)],
      totalBytes: VOICE_MAX_AUDIO_BYTES,
      language: "en",
      principalId: "test",
      startedAt: Date.now(),
      finalized: false,
      released: false,
    }
    voiceWebSocket.message(
      { data: { session }, send: () => {}, close },
      new Uint8Array(1),
    )
    expect(close).toHaveBeenCalledWith(4009, "Voice stream size limit exceeded")
    expect(session.totalBytes).toBe(0)
  })

  test("finalizes an empty stream only once and closes it", () => {
    const close = mock(() => {})
    const send = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
      principalId: "test-finalize",
      startedAt: Date.now(),
      finalized: false,
      released: false,
    }
    const socket = { data: { session }, send, close }
    voiceWebSocket.message(socket, JSON.stringify({ type: "CloseStream" }))
    voiceWebSocket.message(socket, JSON.stringify({ type: "CloseStream" }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(1000, "Voice stream complete")
  })
})

describe("Remote Control WebSocket tickets", () => {
  test("tickets are session-bound and single-use", async () => {
    const codeSession = createSession("Audit", [])
    const admin = await authenticateAdminRequest(
      new Request(`${TEST_ADMIN_ORIGIN}/dashboard`, {
        headers: { cookie: adminCookie },
      }),
    )
    if (!admin) throw new Error("Expected authenticated admin session")
    const { ticket } = mintRemoteWebSocketTicket(
      admin.tokenHash,
      codeSession.id,
    )
    const upgrade = mock(() => true)
    const request = () =>
      new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
        headers: {
          cookie: adminCookie,
          origin: TEST_ADMIN_ORIGIN,
          "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
        },
      })
    expect(await tryUpgradeRemoteWebSocket(request(), { upgrade })).toBe(
      "upgraded",
    )
    expect(await tryUpgradeRemoteWebSocket(request(), { upgrade })).toBe(
      "auth_failed",
    )
    expect(upgrade).toHaveBeenCalledTimes(1)
  })

  test("does not expose raw admin session identifiers in minted tickets", () => {
    const codeSession = createSession("Audit", [])
    const result = mintRemoteWebSocketTicket(
      "admin-session-hash",
      codeSession.id,
    )
    expect(result.ticket).toHaveLength(43)
    expect(result.ticket).not.toContain("admin-session-hash")
  })

  test("session replay history retains only the newest bounded events", () => {
    const codeSession = createSession("Bounded history", [])
    const events = Array.from(
      { length: SESSION_EVENT_HISTORY_MAX_EVENTS + 25 },
      (_, index) => ({
        event_type: "client_event",
        source: "worker",
        payload: { type: "message", index },
        created_at: new Date(index).toISOString(),
      }),
    )
    addClientEvents(codeSession.id, events)
    const retained = getClientEvents(codeSession.id, 0)
    expect(retained).toHaveLength(SESSION_EVENT_HISTORY_MAX_EVENTS)
    expect(retained[0]?.payload.index).toBe(25)
  })
})
