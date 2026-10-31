import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import { randomUUID } from "node:crypto"

import { setConfigForTest } from "~/lib/config"
import { state } from "~/lib/state"
import {
  credentialDigest,
  insertGatewayCredential,
} from "~/lib/storage/credentials-repository"
import {
  desktopDictationRoutes,
  desktopDictationWebSocket,
  type DesktopDictationSession,
  tryUpgradeDesktopDictationWebSocket,
} from "~/routes/desktop-dictation/route"

import { createAuthStorageFixture } from "./helpers/auth-storage"

let gatewayKey: string
const originalFetch = globalThis.fetch
const originalPublicBase = process.env.COPILOT_PUBLIC_BASE_URL
const originalApiKeyAuth = state.apiKeyAuth
const protocol = "claude.dictation.v1"
const pcm = Uint8Array.of(0, 128, 255, 127, 0, 0, 1, 0)
const query = "encoding=linear16&sample_rate=16000&channels=1&language=en"
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let listener: ReturnType<typeof Bun.serve<SocketData>>
let providerCalls: Array<RequestInit>
let provider: (init: RequestInit) => Response | Promise<Response>
let clients: Array<NativeClient>

interface SocketData {
  type: "desktop-dictation"
  session: DesktopDictationSession
}

interface TranscriptFrame {
  type: string
  data?: string
  description?: string
}

interface NativeClient {
  socket: WebSocket
  frames: Array<TranscriptFrame>
  closed: Promise<CloseEvent>
}

interface Ticket {
  ticket: string
  max_seconds?: number
}

beforeEach(async () => {
  gatewayKey = `native-dictation-fixture-${randomUUID()}`
  fixture = await createAuthStorageFixture()
  setConfigForTest({ groqApiKey: "fixture-groq-key" })
  delete process.env.COPILOT_PUBLIC_BASE_URL
  providerCalls = []
  clients = []
  provider = () => Response.json({ text: "A native microphone transcript." })
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        providerCalls.push(init ?? {})
        return Promise.resolve(provider(init ?? {}))
      }
      return originalFetch(input, init)
    },
    { preconnect: originalFetch.preconnect },
  )
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: randomUUID(),
      credential: gatewayKey,
      label: "Native dictation test",
      createdAt: Date.now(),
    }),
  )
  listener = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, http) {
      const result = await tryUpgradeDesktopDictationWebSocket(request, http)
      if (result === "upgraded") return
      if (result instanceof Response) return result
      return desktopDictationRoutes.fetch(request)
    },
    websocket: {
      ...desktopDictationWebSocket,
      maxPayloadLength: 20 * 1024 * 1024,
    },
  })
})

afterEach(async () => {
  for (const client of clients) client.socket.close()
  await listener.stop(true)
  await Promise.all(
    clients.map((client) => Promise.race([client.closed, Bun.sleep(500)])),
  )
  globalThis.fetch = originalFetch
  setSystemTime()
  state.apiKeyAuth = originalApiKeyAuth
  if (originalPublicBase === undefined)
    delete process.env.COPILOT_PUBLIC_BASE_URL
  else process.env.COPILOT_PUBLIC_BASE_URL = originalPublicBase
  setConfigForTest(null)
  await fixture.close()
})

function ticketRequest(prefix = "", headers: Record<string, string> = {}) {
  return desktopDictationRoutes.request(
    `${listener.url.origin}${prefix}/user/dictation/ticket`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${gatewayKey}`, ...headers },
    },
  )
}

async function issueTicket(prefix = ""): Promise<Ticket> {
  const response = await ticketRequest(prefix)
  expect(response.status).toBe(200)
  return (await response.json()) as Ticket
}

async function openNative(
  ticket: string,
  prefix = "",
  language = "en",
): Promise<NativeClient> {
  const parameters = new URLSearchParams(query)
  parameters.set("language", language)
  const url = `${listener.url.origin.replace("http:", "ws:")}${prefix}/user/dictation/stream?${parameters.toString()}`
  // Claude Desktop 4.4212.0 offers the ticket as a second subprotocol, never
  // as a URL parameter, Authorization header, or initial application frame.
  const socket = new WebSocket(url, {
    protocols: [protocol, `ticket.${ticket}`],
    headers: { origin: "app://localhost" },
  })
  const frames: Array<TranscriptFrame> = []
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true })
  })
  const client = { socket, frames, closed }
  clients.push(client)
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as TranscriptFrame)
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener(
      "error",
      () => reject(new Error("Upgrade refused")),
      {
        once: true,
      },
    )
  })
  return client
}

function upgradeRequest(
  ticket: string,
  options: {
    path?: string
    query?: string
    headers?: Record<string, string>
  } = {},
) {
  const request = new Request(
    `${listener.url.origin}${options.path ?? "/user/dictation/stream"}?${options.query ?? query}`,
    {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "YXVkaXQtdGVzdC1rZXkwMA==",
        "sec-websocket-protocol": `${protocol}, ticket.${ticket}`,
        ...options.headers,
      },
    },
  )
  return originalFetch(request)
}

async function revokeGateway(): Promise<void> {
  await fixture.storage.transaction((session) =>
    session.execute({
      sql: "UPDATE capi_gateway_credentials SET revoked_at = ? WHERE digest = ?",
      args: [Date.now(), credentialDigest(gatewayKey)],
    }),
  )
}

for (const [locale, language] of [
  ["en-US", "en"],
  ["en-IN", "en"],
  ["zh-TW", "zh"],
  ["zh-HK", "zh"],
  ["nl-BE", "nl"],
  ["de-CH", "de"],
  ["auto", null],
] as const) {
  test(`native Desktop locale ${locale} uses the provider language code`, async () => {
    const ticket = await issueTicket()
    const client = await openNative(ticket.ticket, "", locale)
    client.socket.send(pcm)
    client.socket.send(JSON.stringify({ type: "CloseStream" }))
    expect((await client.closed).code).toBe(1000)
    expect(providerCalls).toHaveLength(1)
    const form = providerCalls[0].body as FormData
    expect(form.get("language")).toBe(language)
  })
}

for (const prefix of ["", "/v1"]) {
  test(`native Desktop receives a token-safe ticket and negotiated PCM stream at ${prefix || "root"}`, async () => {
    const response = await ticketRequest(prefix)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as Ticket
    expect(body.ticket).toMatch(/^[\w-]{43}$/)
    expect(body.max_seconds).toBeUndefined()

    const client = await openNative(body.ticket, prefix)
    expect(client.socket.protocol).toBe(protocol)
    client.socket.send(pcm)
    client.socket.send(JSON.stringify({ type: "CloseStream" }))
    expect((await client.closed).code).toBe(1000)
    expect(client.frames).toEqual([
      { type: "TranscriptText", data: "A native microphone transcript." },
      { type: "TranscriptEndpoint" },
    ])
    expect(providerCalls).toHaveLength(1)
    const form = providerCalls[0].body as FormData
    expect(form.get("language")).toBe("en")
    const audio = form.get("file") as File
    expect(audio.type).toBe("audio/wav")
    const bytes = new Uint8Array(await audio.arrayBuffer())
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF")
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000)
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(1)
    expect(new DataView(bytes.buffer).getUint16(34, true)).toBe(16)
    expect(bytes.subarray(44)).toEqual(pcm)
  })
}

test("ticket issuance requires a current inference credential even with gateway auth disabled", async () => {
  state.apiKeyAuth = undefined
  const response = await desktopDictationRoutes.request(
    `${listener.url.origin}/user/dictation/ticket`,
    { method: "POST", headers: { "x-forwarded-for": "127.0.0.1" } },
  )
  expect(response.status).toBe(401)
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("inference-only credentials can dictate without the CLI-only voice scope", async () => {
  await fixture.storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,enabled,scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [
        credentialDigest("fixture-inference-only"),
        randomUUID(),
        "managed",
        `inference-managed:${randomUUID()}`,
        1,
        '["user:inference"]',
        Date.now(),
        Date.now(),
      ],
    }),
  )
  const response = await ticketRequest("", {
    authorization: "Bearer fixture-inference-only",
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as Ticket
  const client = await openNative(body.ticket)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
  expect(client.frames[0].data).toBe("A native microphone transcript.")
})

test("ticket issuance and redemption fail closed during a storage outage", async () => {
  const ticket = await issueTicket()
  fixture.failReads()
  expect((await ticketRequest()).status).toBe(503)
  const response = await upgradeRequest(ticket.ticket)
  expect(response.status).toBe(503)
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("a ticket cannot be replayed after its first successful socket", async () => {
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send('{"type":"CloseStream"}')
  await client.closed
  expect((await upgradeRequest(ticket.ticket)).status).toBe(401)
})

test("concurrent redemption admits exactly one socket", async () => {
  const ticket = await issueTicket()
  const attempts = await Promise.allSettled([
    openNative(ticket.ticket),
    openNative(ticket.ticket),
  ])
  expect(
    attempts.filter((attempt) => attempt.status === "fulfilled"),
  ).toHaveLength(1)
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled") {
      attempt.value.socket.send('{"type":"CloseStream"}')
      await attempt.value.closed
    }
  }
})

test("a ticket expires exactly sixty seconds after issuance", async () => {
  const now = Date.now()
  setSystemTime(now)
  const ticket = await issueTicket()
  setSystemTime(now + 60_000)
  expect((await upgradeRequest(ticket.ticket)).status).toBe(401)
})

test("a ticket is bound to the public base and root or v1 path", async () => {
  const ticket = await issueTicket()
  expect(
    (await upgradeRequest(ticket.ticket, { path: "/v1/user/dictation/stream" }))
      .status,
  ).toBe(401)
  process.env.COPILOT_PUBLIC_BASE_URL = "https://other-gateway.test/edge"
  expect((await upgradeRequest(ticket.ticket)).status).toBe(401)
})

test("an unchanged trusted public prefix works with a stripped internal route", async () => {
  process.env.COPILOT_PUBLIC_BASE_URL = "https://public-gateway.test/edge"
  const ticket = await issueTicket("/v1")
  const client = await openNative(ticket.ticket, "/v1")
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
})

for (const origin of ["https://hostile.test", "null", "app://other"]) {
  test(`the stream rejects Origin ${origin}`, async () => {
    const ticket = await issueTicket()
    expect(
      (await upgradeRequest(ticket.ticket, { headers: { origin } })).status,
    ).toBe(403)
  })
}

test("the stream rejects ambiguous protocol offers and bearer or query ticket fallbacks", async () => {
  const ticket = await issueTicket()
  for (const offered of [
    protocol,
    `ticket.${ticket.ticket}`,
    `${protocol}, ${protocol}, ticket.${ticket.ticket}`,
    `${protocol}, ticket.${ticket.ticket}, ticket.second-ticket`,
    `${protocol}, ticket.${ticket.ticket}, unexpected`,
  ]) {
    expect(
      (
        await upgradeRequest(ticket.ticket, {
          headers: { "sec-websocket-protocol": offered },
        })
      ).status,
    ).toBe(400)
  }
  expect(
    (
      await upgradeRequest(ticket.ticket, {
        query: `${query}&ticket=${ticket.ticket}`,
        headers: {
          authorization: `Bearer ${gatewayKey}`,
          "sec-websocket-protocol": protocol,
        },
      })
    ).status,
  ).toBe(400)
})

for (const invalidQuery of [
  "encoding=opus&sample_rate=16000&channels=1&language=en",
  "encoding=linear16&sample_rate=48000&channels=1&language=en",
  "encoding=linear16&sample_rate=16000&channels=2&language=en",
  "encoding=linear16&sample_rate=16000&channels=1",
  `${query}&language=fr`,
  `${query}&arbitrary=1`,
]) {
  test(`the stream refuses an unsupported or ambiguous audio query: ${invalidQuery}`, async () => {
    const ticket = await issueTicket()
    expect(
      (await upgradeRequest(ticket.ticket, { query: invalidQuery })).status,
    ).toBe(400)
  })
}

test("revoking the ticket issuer prevents the socket from opening", async () => {
  const ticket = await issueTicket()
  await revokeGateway()
  expect((await upgradeRequest(ticket.ticket)).status).toBe(401)
})

for (const unavailable of [false, true]) {
  test(`provider work is refused after ${unavailable ? "storage failure" : "credential revocation"}`, async () => {
    const ticket = await issueTicket()
    const client = await openNative(ticket.ticket)
    client.socket.send(pcm)
    if (unavailable) fixture.failReads()
    else await revokeGateway()
    client.socket.send('{"type":"CloseStream"}')
    await client.closed
    expect(client.frames).toHaveLength(1)
    expect(client.frames[0].type).toBe("TranscriptError")
    expect(providerCalls).toHaveLength(0)
  })
}

test("keepalive is acknowledged and an empty stream completes without provider work", async () => {
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send('{"type":"KeepAlive"}')
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
  expect(client.frames).toEqual([
    { type: "KeepAliveAck" },
    { type: "TranscriptEndpoint" },
  ])
  expect(providerCalls).toHaveLength(0)
})

test("duplicate stop messages do not duplicate transcription", async () => {
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  client.socket.send('{"type":"CloseStream"}')
  await client.closed
  expect(providerCalls).toHaveLength(1)
  expect(
    client.frames.filter((frame) => frame.type === "TranscriptText"),
  ).toHaveLength(1)
})

test("malformed control frames and incomplete PCM samples fail without transcription", async () => {
  for (const message of [
    "{",
    "null",
    '{"type":"Unknown"}',
    new Uint8Array(3),
  ]) {
    const ticket = await issueTicket()
    const client = await openNative(ticket.ticket)
    client.socket.send(message)
    const close = await client.closed
    expect(close.code).not.toBe(1000)
    expect(client.frames[0].type).toBe("TranscriptError")
  }
  expect(providerCalls).toHaveLength(0)
})

test("large legitimate PCM is transcribed intact without a gateway audio cap", async () => {
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(new Uint8Array(20_000_000))
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
  expect(client.frames[0].data).toBe("A native microphone transcript.")
  const form = providerCalls[0].body as FormData
  expect((form.get("file") as File).size).toBe(20_000_044)
})

test("one authorized principal can obtain tickets and open multiple simultaneous streams", async () => {
  const tickets = await Promise.all(
    Array.from({ length: 12 }, () => issueTicket()),
  )
  const connections = await Promise.all(
    tickets.map((ticket) => openNative(ticket.ticket)),
  )
  for (const client of connections) client.socket.send('{"type":"CloseStream"}')
  const closed = await Promise.all(connections.map((client) => client.closed))
  expect(closed.every((event) => event.code === 1000)).toBe(true)
})

test("large recognized control frames remain valid", async () => {
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(
    JSON.stringify({ type: "KeepAlive", padding: "x".repeat(1_100_000) }),
  )
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
  expect(client.frames).toEqual([
    { type: "KeepAliveAck" },
    { type: "TranscriptEndpoint" },
  ])
})

test("an admitted stream has no gateway recording-duration deadline", async () => {
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  setSystemTime(Date.now() + 3_600_000)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
  expect(client.frames[0].data).toBe("A native microphone transcript.")
})

test("disconnect aborts provider work and suppresses a late transcript", async () => {
  const entered = Promise.withResolvers<RequestInit>()
  const completed = Promise.withResolvers<Response>()
  provider = (init) => {
    entered.resolve(init)
    return completed.promise
  }
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  const request = await entered.promise
  client.socket.close()
  await client.closed
  await Bun.sleep(0)
  expect(request.signal?.aborted).toBe(true)
  completed.resolve(Response.json({ text: "late provider response" }))
  await Bun.sleep(10)
  expect(client.frames).toEqual([])
})

test("revocation while transcription is pending prevents transcript delivery", async () => {
  const entered = Promise.withResolvers<undefined>()
  const completed = Promise.withResolvers<Response>()
  provider = () => {
    entered.resolve(undefined)
    return completed.promise
  }
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  await entered.promise
  await revokeGateway()
  completed.resolve(Response.json({ text: "must not be delivered" }))
  await client.closed
  expect(client.frames).toHaveLength(1)
  expect(client.frames[0].type).toBe("TranscriptError")
})

test("provider failures expose no upstream body or transcript in the error frame", async () => {
  provider = () => new Response("secret upstream diagnostic", { status: 500 })
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1011)
  expect(client.frames).toEqual([
    { type: "TranscriptError", description: "Transcription failed" },
  ])
})

test("the native two-second stop deadline cancels a late batch instead of delivering partial text", async () => {
  const entered = Promise.withResolvers<RequestInit>()
  const completed = Promise.withResolvers<Response>()
  provider = (init) => {
    entered.resolve(init)
    return completed.promise
  }
  const ticket = await issueTicket()
  const client = await openNative(ticket.ticket)
  client.socket.send(pcm)
  client.socket.send('{"type":"CloseStream"}')
  const request = await entered.promise
  const deadline = setTimeout(() => client.socket.close(), 2_000)
  await client.closed
  clearTimeout(deadline)
  await Bun.sleep(0)
  expect(request.signal?.aborted).toBe(true)
  completed.resolve(Response.json({ text: "too late" }))
  await Bun.sleep(10)
  expect(client.frames).toEqual([])
})
