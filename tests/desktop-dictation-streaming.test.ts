import { afterEach, beforeEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import { setConfigForTest } from "~/lib/config"
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

interface Frame {
  type: string
  data?: string
  description?: string
}

interface Client {
  socket: WebSocket
  frames: Array<Frame>
  closed: Promise<CloseEvent>
}

const originalFetch = globalThis.fetch
const originalBase = process.env.COPILOT_PUBLIC_BASE_URL
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let server: ReturnType<typeof Bun.serve<{ session: DesktopDictationSession }>>
let key: string
let clients: Array<Client>
let sessions: Array<DesktopDictationSession>
let requests: Array<RequestInit>
let provider: (init: RequestInit) => Response | Promise<Response>

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  key = `streaming-dictation-${randomUUID()}`
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: randomUUID(),
      credential: key,
      label: "Streaming fixture",
      createdAt: Date.now(),
    }),
  )
  setConfigForTest({ groqApiKey: "fixture-groq" })
  delete process.env.COPILOT_PUBLIC_BASE_URL
  clients = []
  sessions = []
  requests = []
  provider = () => Response.json({ text: "Recognized words." })
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        requests.push(init ?? {})
        return Promise.resolve(provider(init ?? {}))
      }
      return originalFetch(input, init)
    },
    { preconnect: originalFetch.preconnect },
  )
  server = Bun.serve<{ session: DesktopDictationSession }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, http) {
      const upgrade = await tryUpgradeDesktopDictationWebSocket(request, http)
      if (upgrade === "upgraded") return
      if (upgrade instanceof Response) return upgrade
      return desktopDictationRoutes.fetch(request)
    },
    websocket: {
      ...desktopDictationWebSocket,
      open(ws) {
        sessions.push(ws.data.session)
        desktopDictationWebSocket.open(ws)
      },
    },
  })
})

afterEach(async () => {
  for (const client of clients) client.socket.close()
  await server.stop(true)
  await Promise.all(clients.map((client) => client.closed))
  globalThis.fetch = originalFetch
  setConfigForTest(null)
  if (originalBase === undefined) delete process.env.COPILOT_PUBLIC_BASE_URL
  else process.env.COPILOT_PUBLIC_BASE_URL = originalBase
  await fixture.close()
})

async function connect(): Promise<Client> {
  const response = await desktopDictationRoutes.request(
    `${server.url.origin}/user/dictation/ticket`,
    { method: "POST", headers: { authorization: `Bearer ${key}` } },
  )
  expect(response.status).toBe(200)
  const { ticket } = (await response.json()) as { ticket: string }
  const socket = new WebSocket(
    `${server.url.origin.replace("http:", "ws:")}/user/dictation/stream?encoding=linear16&sample_rate=16000&channels=1&language=en`,
    ["claude.dictation.v1", `ticket.${ticket}`],
  )
  const frames: Array<Frame> = []
  socket.addEventListener("message", (event) =>
    frames.push(JSON.parse(String(event.data)) as Frame),
  )
  const closed = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  )
  const client = { socket, frames, closed }
  clients.push(client)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  return client
}

async function framesReceived(client: Client, count: number): Promise<void> {
  if (client.frames.length >= count) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      client.socket.removeEventListener("message", received)
    }
    const received = () => {
      if (client.frames.length < count) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Expected ${count} transcript frames before Stop`))
    }, 2_000)
    client.socket.addEventListener("message", received)
  })
}

function audio(seconds: number, marker = 1): Uint8Array {
  return new Uint8Array(seconds * 32_000).fill(marker)
}

async function providerAudio(index: number): Promise<Uint8Array> {
  const file = (requests[index].body as FormData).get("file") as File
  return new Uint8Array(await file.arrayBuffer()).slice(44)
}

function draft(frames: Array<Frame>): string {
  const committed: Array<string> = []
  let interim = ""
  for (const frame of frames) {
    if (frame.type === "TranscriptText" || frame.type === "TranscriptInterim") {
      // The exact native controller ignores empty transcript callbacks.
      if (frame.data) interim = frame.data
    } else if (frame.type === "TranscriptEndpoint") {
      if (interim) committed.push(interim)
      interim = ""
    }
  }
  return [...committed, interim].filter(Boolean).join(" ")
}

test("30 seconds of captured audio publishes words before Stop, not at 29 seconds", async () => {
  const client = await connect()
  client.socket.send(audio(29))
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 1)
  expect(requests).toHaveLength(0)
  client.socket.send(audio(1))
  await framesReceived(client, 2)
  expect(client.frames[1]).toEqual({
    type: "TranscriptInterim",
    data: "Recognized words.",
  })
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  expect((await providerAudio(0)).byteLength).toBe(960_000)
  const form = requests[0].body as FormData
  expect(form.get("response_format")).toBe("verbose_json")
  expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"])
})

test("65 seconds of speech updates twice and preserves overlapping words when Stop flushes", async () => {
  const responses = [
    {
      text: "First words. Next phrase",
      segments: [
        { start: 0, end: 26, text: "First words." },
        { start: 28, end: 30, text: " Next phrase" },
      ],
    },
    {
      text: "Next phrase keeps going. Last few",
      segments: [
        { start: 0, end: 26, text: "Next phrase keeps going." },
        { start: 28, end: 33, text: " Last few" },
      ],
    },
    { text: "Last few words finish." },
  ]
  provider = () => Response.json(responses[requests.length - 1])
  const client = await connect()
  client.socket.send(audio(30, 1))
  await framesReceived(client, 3)
  expect(draft(client.frames)).toBe("First words. Next phrase")
  client.socket.send(audio(30, 2))
  await framesReceived(client, 6)
  expect(draft(client.frames)).toBe(
    "First words. Next phrase keeps going. Last few",
  )
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  client.socket.send(audio(5, 3))
  client.socket.send('{"type":"CloseStream"}')
  expect((await client.closed).code).toBe(1000)
  expect(draft(client.frames)).toBe(
    "First words. Next phrase keeps going. Last few words finish.",
  )
  const second = await providerAudio(1)
  expect(second.byteLength).toBe(1_056_000)
  expect(second.subarray(0, 96_000).every((byte) => byte === 1)).toBe(true)
  expect(second.subarray(96_000).every((byte) => byte === 2)).toBe(true)
  const tail = await providerAudio(2)
  expect(tail.byteLength).toBe(352_000)
  expect(tail.subarray(0, 192_000).every((byte) => byte === 2)).toBe(true)
  expect(tail.subarray(192_000).every((byte) => byte === 3)).toBe(true)
})

const segmented = {
  text: "Keep this. Still speaking",
  segments: [
    { start: 0, end: 26, text: "Keep this." },
    { start: 28, end: 30, text: " Still speaking" },
  ],
}

test("retained context does not shorten the next 30-second fresh-audio interval", async () => {
  provider = () => Response.json(segmented)
  const client = await connect()
  client.socket.send(audio(30))
  await framesReceived(client, 3)
  client.socket.send(audio(27))
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 4)
  expect(requests).toHaveLength(1)
  client.socket.send(audio(3))
  await framesReceived(client, 7)
  expect(requests).toHaveLength(2)
})

test("a batch boundary inside a PCM frame retains every remaining sample", async () => {
  const client = await connect()
  client.socket.send(audio(29, 1))
  client.socket.send(audio(2, 2))
  await framesReceived(client, 1)
  const first = await providerAudio(0)
  expect(first.byteLength).toBe(960_000)
  expect(first.subarray(0, 928_000).every((byte) => byte === 1)).toBe(true)
  expect(first.subarray(928_000).every((byte) => byte === 2)).toBe(true)
  client.socket.send('{"type":"CloseStream"}')
  await client.closed
  const final = await providerAudio(1)
  expect(final.byteLength).toBe(992_000)
  expect(final.subarray(0, 928_000).every((byte) => byte === 1)).toBe(true)
  expect(final.subarray(928_000).every((byte) => byte === 2)).toBe(true)
})

test("Stop during a pending batch commits stable words but keeps the socket open for its short tail", async () => {
  const entered = Promise.withResolvers<undefined>()
  const first = Promise.withResolvers<Response>()
  const tailEntered = Promise.withResolvers<undefined>()
  const tail = Promise.withResolvers<Response>()
  provider = () => {
    if (requests.length === 1) {
      entered.resolve(undefined)
      return first.promise
    }
    tailEntered.resolve(undefined)
    return tail.promise
  }
  const client = await connect()
  client.socket.send(audio(30, 1))
  await entered.promise
  client.socket.send(audio(5, 2))
  client.socket.send('{"type":"CloseStream"}')
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 1)
  first.resolve(Response.json(segmented))
  await tailEntered.promise
  const pcm = await providerAudio(1)
  expect(pcm.byteLength).toBe(256_000)
  expect(pcm.subarray(0, 96_000).every((byte) => byte === 1)).toBe(true)
  expect(pcm.subarray(96_000).every((byte) => byte === 2)).toBe(true)
  await framesReceived(client, 4)
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  expect(draft(client.frames)).toBe("Keep this. Still speaking")
  tail.resolve(Response.json({ text: "Still speaking until the end." }))
  await client.closed
  expect(draft(client.frames)).toBe("Keep this. Still speaking until the end.")
  expect(
    client.frames.filter((frame) => frame.type === "TranscriptEndpoint"),
  ).toHaveLength(2)
})

test("Stop with no new audio uses the in-flight full result only once", async () => {
  const entered = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<Response>()
  provider = () => {
    entered.resolve(undefined)
    return result.promise
  }
  const client = await connect()
  client.socket.send(audio(30))
  await entered.promise
  client.socket.send('{"type":"CloseStream"}')
  client.socket.send('{"type":"CloseStream"}')
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 1)
  result.resolve(Response.json(segmented))
  expect((await client.closed).code).toBe(1000)
  expect(draft(client.frames)).toBe("Keep this. Still speaking")
  expect(requests).toHaveLength(1)
  expect(
    client.frames.filter((frame) => frame.type === "TranscriptEndpoint"),
  ).toHaveLength(1)
})

test("queued recording audio starts its next batch only after the previous request completes", async () => {
  const entered = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<Response>()
  provider = () => {
    if (requests.length > 1) return Response.json({ text: "Continued speech." })
    entered.resolve(undefined)
    return result.promise
  }
  const client = await connect()
  client.socket.send(audio(30, 1))
  await entered.promise
  client.socket.send(audio(30, 2))
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 1)
  expect(requests).toHaveLength(1)
  result.resolve(Response.json(segmented))
  await framesReceived(client, 5)
  expect(requests).toHaveLength(2)
  expect((await providerAudio(1)).byteLength).toBe(1_056_000)
})

test("intentional repeated words across the retained seam are not deduplicated", async () => {
  provider = () =>
    Response.json(
      requests.length === 1 ?
        {
          text: "Yes. Yes, yes",
          segments: [
            { start: 0, end: 26, text: "Yes." },
            { start: 28, end: 30, text: " Yes, yes" },
          ],
        }
      : { text: "Yes, yes, please continue." },
    )
  const client = await connect()
  client.socket.send(audio(30))
  await framesReceived(client, 3)
  client.socket.send(audio(2))
  client.socket.send('{"type":"CloseStream"}')
  await client.closed
  expect(draft(client.frames)).toBe("Yes. Yes, yes, please continue.")
})

for (const segments of [
  undefined,
  [{ start: 0, end: 30, text: "First words." }],
  [
    { start: -1, end: 26, text: "First" },
    { start: 28, end: 30, text: " words." },
  ],
  [
    { start: 0, end: 29, text: "First" },
    { start: 28, end: 30, text: " words." },
  ],
  [
    { start: 0, end: 26, text: "First" },
    { start: 28, end: 31, text: " words." },
  ],
  [
    { start: 0, end: 26, text: "Different" },
    { start: 28, end: 30, text: " words." },
  ],
]) {
  test(`unusable segment boundaries preserve the full audio: ${JSON.stringify(segments)}`, async () => {
    provider = () =>
      Response.json(
        requests.length === 1 ?
          {
            text: "First words.",
            segments,
          }
        : { text: "First words. More words." },
      )
    const client = await connect()
    client.socket.send(audio(30, 1))
    await framesReceived(client, 1)
    expect(client.frames).toEqual([
      { type: "TranscriptInterim", data: "First words." },
    ])
    client.socket.send(audio(30, 2))
    await framesReceived(client, 2)
    expect(draft(client.frames)).toBe("First words. More words.")
    expect((await providerAudio(1)).byteLength).toBe(1_920_000)
  })
}

test("empty recognition preserves native provisional text without empty or fabricated updates", async () => {
  const secondEntered = Promise.withResolvers<undefined>()
  provider = () =>
    requests.length === 1 ?
      Response.json({ text: "Recognized phrase" })
    : (secondEntered.resolve(undefined), Response.json({ text: "" }))
  const client = await connect()
  client.socket.send(audio(30))
  await framesReceived(client, 1)
  client.socket.send(audio(30, 0))
  await secondEntered.promise
  await pumpSettled()
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 2)
  expect(client.frames).toEqual([
    { type: "TranscriptInterim", data: "Recognized phrase" },
    { type: "KeepAliveAck" },
  ])
  expect(draft(client.frames)).toBe("Recognized phrase")
  client.socket.send('{"type":"CloseStream"}')
  await client.closed
  expect(client.frames.filter((frame) => frame.data)).toHaveLength(1)
  expect(draft(client.frames)).toBe("Recognized phrase")
})

async function pumpSettled(): Promise<void> {
  for (
    let attempt = 0;
    sessions.some((session) => session.processing);
    attempt += 1
  ) {
    if (attempt === 2_000) throw new Error("Transcription pump did not settle")
    await Bun.sleep(1)
  }
}

test("recognizing only the same retained words does not manufacture fresh speech activity", async () => {
  const secondEntered = Promise.withResolvers<undefined>()
  provider = () => {
    if (requests.length === 1) return Response.json(segmented)
    secondEntered.resolve(undefined)
    return Response.json({ text: "Still speaking" })
  }
  const client = await connect()
  client.socket.send(audio(30))
  await framesReceived(client, 3)
  client.socket.send(audio(30, 0))
  await secondEntered.promise
  // Wait for the real server pump to settle before placing a wire barrier.
  await pumpSettled()
  client.socket.send('{"type":"KeepAlive"}')
  await framesReceived(client, 4)
  expect(client.frames.filter((frame) => frame.data)).toEqual([
    { type: "TranscriptText", data: "Keep this." },
    { type: "TranscriptInterim", data: "Still speaking" },
  ])
})

test("identical words recognized in fresh audio still refresh the native speech watchdog", async () => {
  provider = () =>
    Response.json(
      requests.length === 1 ?
        segmented
      : {
          text: "Still speaking",
          segments: [{ start: 20, end: 21, text: "Still speaking" }],
        },
    )
  const client = await connect()
  client.socket.send(audio(30))
  await framesReceived(client, 3)
  client.socket.send(audio(30))
  await framesReceived(client, 4)
  expect(client.frames[3]).toEqual({
    type: "TranscriptInterim",
    data: "Still speaking",
  })
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
})

async function revoke(): Promise<void> {
  await fixture.storage.transaction((session) =>
    session.execute({
      sql: "UPDATE capi_gateway_credentials SET revoked_at = ? WHERE digest = ?",
      args: [Date.now(), credentialDigest(key)],
    }),
  )
}

test("revocation between periodic batches prevents the next provider request", async () => {
  const client = await connect()
  client.socket.send(audio(30))
  await framesReceived(client, 1)
  await revoke()
  client.socket.send(audio(30))
  expect((await client.closed).code).toBe(1008)
  expect(requests).toHaveLength(1)
  expect(client.frames.at(-1)?.type).toBe("TranscriptError")
})

test("revocation while a periodic request is pending suppresses its result", async () => {
  const entered = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<Response>()
  provider = () => {
    entered.resolve(undefined)
    return result.promise
  }
  const client = await connect()
  client.socket.send(audio(30))
  await entered.promise
  await revoke()
  result.resolve(Response.json(segmented))
  expect((await client.closed).code).toBe(1008)
  expect(client.frames).toEqual([
    { type: "TranscriptError", description: "Authentication failed" },
  ])
})

test("disconnect aborts periodic work and suppresses queued batches and late words", async () => {
  const entered = Promise.withResolvers<RequestInit>()
  const result = Promise.withResolvers<Response>()
  provider = (init) => {
    entered.resolve(init)
    return result.promise
  }
  const client = await connect()
  client.socket.send(audio(30))
  const request = await entered.promise
  const signal = request.signal
  if (!signal) throw new Error("Expected a cancellable transcription request")
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
  client.socket.send(audio(30))
  client.socket.close()
  await Promise.all([client.closed, aborted])
  expect(request.signal?.aborted).toBe(true)
  result.resolve(Response.json(segmented))
  await Bun.sleep(10)
  expect(requests).toHaveLength(1)
  expect(client.frames).toEqual([])
})
