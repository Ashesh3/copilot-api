import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  authenticateAdminRequest,
  setAdminAuthTestMode,
  setupAdminAuth,
} from "../src/lib/admin-auth"
import {
  isIpBlocked,
  leaseIp,
  recordFailedAttempt,
  resetIpSecurityForTest,
} from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import {
  addClientEvents,
  createSession,
  getClientEvents,
} from "../src/routes/code-sessions/session-store"
import { directConnectRoutes } from "../src/routes/direct-connect/route"
import {
  createDirectConnectSession,
  handleDirectConnectWebSocket,
  listDirectConnectSessions,
  resetDirectConnectForTest,
} from "../src/routes/direct-connect/ws-handler"
import { healthRoutes } from "../src/routes/health/route"
import { remoteWebSocket } from "../src/routes/remote/websocket"
import {
  mintRemoteWebSocketTicket,
  resetRemoteWebSocketSecurityForTest,
  tryUpgradeRemoteWebSocket,
} from "../src/routes/remote/ws-security"
import {
  tryUpgradeVoiceWebSocket,
  type VoiceSession,
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
  resetDirectConnectForTest()
  resetIpSecurityForTest()
  delete process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
})

afterEach(() => {
  state.apiKeyAuth = originalGatewayKey
  setAdminAuthTestMode(false)
  resetIpSecurityForTest()
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

  test("Direct Connect HTTP auth failures count toward the shared ban", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const clientIp = "198.51.100.92"
    const headers = { "x-copilot-peer-ip": clientIp }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (
          await directConnectRoutes.request("http://localhost/api/sessions", {
            headers,
          })
        ).status,
      ).toBe(401)
    }
    expect(isIpBlocked(clientIp)).toBe(true)
  })

  test("Direct Connect WebSocket auth rejects banned IPs", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const clientIp = "198.51.100.93"
    const startModule = (await import("../src/start")) as Record<
      string,
      unknown
    >
    const authorize = startModule.isDirectConnectUpgradeAuthorized
    expect(typeof authorize).toBe("function")
    if (typeof authorize !== "function") return

    const request = new Request("http://localhost/ws/direct/dc_test", {
      headers: {
        "x-api-key": "gateway-secret",
        "x-copilot-peer-ip": clientIp,
      },
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await (authorize as (request: Request) => Promise<string>)(
          new Request("http://localhost/ws/direct/dc_test", {
            headers: { "x-copilot-peer-ip": clientIp },
          }),
        ),
      ).toBe("unauthorized")
    }
    expect(isIpBlocked(clientIp)).toBe(true)
    expect(
      await (authorize as (request: Request) => Promise<string>)(request),
    ).toBe("blocked")
  })

  test("start fetch returns uniform Direct Connect upgrade denials without breaking authorized upgrades", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const clientIp = "198.51.100.95"
    const session = createDirectConnectSession()
    const startModule = (await import("../src/start")) as Record<
      string,
      unknown
    >
    const handleStartFetch = startModule.handleStartFetch
    expect(typeof handleStartFetch).toBe("function")
    if (typeof handleStartFetch !== "function") return

    const upgrade = mock(() => true)
    const bunServer = {
      requestIP: () => ({ address: clientIp }),
      upgrade,
    }
    const fetchUpgrade = (apiKey?: string) => {
      const headers = new Headers({ upgrade: "websocket" })
      if (apiKey) headers.set("x-api-key", apiKey)
      return (
        handleStartFetch as (
          request: Request,
          server: typeof bunServer,
        ) => Promise<Response>
      )(
        new Request(`http://localhost/ws/direct/${session.session_id}`, {
          headers,
        }),
        bunServer,
      )
    }

    expect((await fetchUpgrade()).status).toBe(401)
    expect((await fetchUpgrade("wrong-key")).status).toBe(401)
    expect(await fetchUpgrade("gateway-secret")).toBeUndefined()
    expect(upgrade).toHaveBeenCalledTimes(1)

    expect((await fetchUpgrade()).status).toBe(401)
    expect(isIpBlocked(clientIp)).toBe(true)
    expect((await fetchUpgrade("gateway-secret")).status).toBe(401)
    expect(upgrade).toHaveBeenCalledTimes(1)
  })

  test("Direct Connect allows multiple handlers for one session", () => {
    const session = createDirectConnectSession()
    const firstSend = mock(() => {})
    const secondSend = mock(() => {})
    const firstClose = mock(() => {})
    const secondClose = mock(() => {})

    handleDirectConnectWebSocket(
      { send: firstSend, close: firstClose },
      session.session_id,
    )
    handleDirectConnectWebSocket(
      { send: secondSend, close: secondClose },
      session.session_id,
    )

    expect(firstSend).toHaveBeenCalledTimes(1)
    expect(secondSend).toHaveBeenCalledTimes(1)
    expect(firstClose).not.toHaveBeenCalled()
    expect(secondClose).not.toHaveBeenCalled()
  })

  test("Direct Connect retains sessions without count eviction", () => {
    const first = createDirectConnectSession()
    for (let index = 0; index < 20; index += 1) {
      createDirectConnectSession()
    }
    expect(listDirectConnectSessions()).toHaveLength(21)
    expect(
      listDirectConnectSessions().some(
        (session) => session.id === first.session_id,
      ),
    ).toBe(true)
  })

  test("Direct Connect closes binary frames without logging their contents", () => {
    const session = createDirectConnectSession()
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

  test("records missing and invalid voice upgrade credentials", async () => {
    const clientIp = "198.51.100.94"
    const upgrade = mock(() => true)
    for (const apiKey of [undefined, undefined, "wrong-key"]) {
      const headers = new Headers({ "x-copilot-peer-ip": clientIp })
      if (apiKey) headers.set("x-api-key", apiKey)
      expect(
        await tryUpgradeVoiceWebSocket(
          new Request("http://localhost/api/ws/speech_to_text/voice_stream", {
            headers,
          }),
          { upgrade },
        ),
      ).toBe("auth_failed")
    }
    expect(isIpBlocked(clientIp)).toBe(true)
    expect(upgrade).not.toHaveBeenCalled()
  })

  test("accepts multiple voice connections for one gateway principal", async () => {
    const upgrade = mock(() => true)
    for (let index = 0; index < 5; index += 1) {
      expect(
        await tryUpgradeVoiceWebSocket(voiceUpgradeRequest(), { upgrade }),
      ).toBe("upgraded")
    }
    expect(upgrade).toHaveBeenCalledTimes(5)
  })

  test("accepts audio beyond the former aggregate boundary", () => {
    const close = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
      finalized: false,
      released: false,
    }
    const audio = new Uint8Array(4 * 1024 * 1024 + 1)
    voiceWebSocket.message({ data: { session }, send: () => {}, close }, audio)
    expect(close).not.toHaveBeenCalled()
    expect(session.totalBytes).toBe(audio.length)
  })

  test("accepts large voice control frames", () => {
    const close = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
      finalized: false,
      released: false,
    }
    voiceWebSocket.message(
      { data: { session }, send: () => {}, close },
      JSON.stringify({ type: "KeepAlive", padding: "x".repeat(70_000) }),
    )
    expect(close).not.toHaveBeenCalled()
  })

  test("finalizes an empty stream only once and closes it", () => {
    const close = mock(() => {})
    const send = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
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

  test("retains pending tickets and allows multiple controllers", async () => {
    const codeSession = createSession("Many controllers", [])
    const admin = await authenticateAdminRequest(
      new Request(`${TEST_ADMIN_ORIGIN}/dashboard`, {
        headers: { cookie: adminCookie },
      }),
    )
    if (!admin) throw new Error("Expected authenticated admin session")

    const first = mintRemoteWebSocketTicket(admin.tokenHash, codeSession.id)
    for (let index = 0; index < 520; index += 1) {
      mintRemoteWebSocketTicket(admin.tokenHash, codeSession.id)
    }

    const upgrade = mock(() => true)
    const requestFor = (ticket: string) =>
      new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
        headers: {
          cookie: adminCookie,
          origin: TEST_ADMIN_ORIGIN,
          "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
        },
      })

    expect(
      await tryUpgradeRemoteWebSocket(requestFor(first.ticket), { upgrade }),
    ).toBe("upgraded")
    for (let index = 0; index < 4; index += 1) {
      const { ticket } = mintRemoteWebSocketTicket(
        admin.tokenHash,
        codeSession.id,
      )
      expect(
        await tryUpgradeRemoteWebSocket(requestFor(ticket), { upgrade }),
      ).toBe("upgraded")
    }
    expect(upgrade).toHaveBeenCalledTimes(5)
  })

  test("Remote Control sends complete catchup and accepts large messages", () => {
    const codeSession = createSession("Complete catchup", [])
    addClientEvents(
      codeSession.id,
      Array.from({ length: 600 }, (_, index) => ({
        event_type: "client_event",
        source: "worker",
        payload: { index },
        created_at: new Date(index).toISOString(),
      })),
    )
    const sent: Array<string> = []
    const close = mock(() => {})
    const socket = {
      data: {
        type: "remote-control" as const,
        sessionId: codeSession.id,
      },
      send: (data: string) => sent.push(data),
      close,
    }

    remoteWebSocket.open(socket)
    expect(sent).toHaveLength(600)
    remoteWebSocket.message(
      socket,
      JSON.stringify({
        type: "user",
        session_id: codeSession.id,
        message: { role: "user", content: "x".repeat(70_000) },
      }),
    )
    expect(close).not.toHaveBeenCalled()
    expect(getClientEvents(codeSession.id, 0)).toHaveLength(601)
    remoteWebSocket.close(socket)
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

  test("rejects a valid admin session from a banned IP", async () => {
    const codeSession = createSession("Banned admin", [])
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
    const clientIp = "198.51.100.96"
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordFailedAttempt(clientIp)
    }
    const upgrade = mock(() => true)

    expect(
      await tryUpgradeRemoteWebSocket(
        new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
          headers: {
            cookie: adminCookie,
            origin: TEST_ADMIN_ORIGIN,
            "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
            "x-copilot-peer-ip": clientIp,
          },
        }),
        { upgrade },
      ),
    ).toBe("auth_failed")
    expect(upgrade).not.toHaveBeenCalled()
  })

  test("accepts a valid admin session from a leased banned IP", async () => {
    const codeSession = createSession("Leased admin", [])
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
    const clientIp = "198.51.100.97"
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordFailedAttempt(clientIp)
    }
    expect(leaseIp(clientIp, 60_000)).toBe(true)
    const upgrade = mock(() => true)

    expect(
      await tryUpgradeRemoteWebSocket(
        new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
          headers: {
            cookie: adminCookie,
            origin: TEST_ADMIN_ORIGIN,
            "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
            "x-copilot-peer-ip": clientIp,
          },
        }),
        { upgrade },
      ),
    ).toBe("upgraded")
    expect(upgrade).toHaveBeenCalledTimes(1)
  })

  test("session replay history retains all events", () => {
    const codeSession = createSession("Complete history", [])
    const events = Array.from({ length: 2025 }, (_, index) => ({
      event_type: "client_event",
      source: "worker",
      payload: { type: "message", index },
      created_at: new Date(index).toISOString(),
    }))
    addClientEvents(codeSession.id, events)
    const retained = getClientEvents(codeSession.id, 0)
    expect(retained).toHaveLength(2025)
    expect(retained[0]?.payload.index).toBe(0)
  })
})
