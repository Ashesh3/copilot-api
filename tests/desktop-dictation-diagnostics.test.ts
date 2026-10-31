import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import consola from "consola"

import { setConfigForTest } from "../src/lib/config"
import { insertGatewayCredential } from "../src/lib/storage/credentials-repository"
import { authorizeDictation } from "../src/routes/desktop-dictation/authorization"
import {
  createDictationSession,
  desktopDictationWebSocket,
} from "../src/routes/desktop-dictation/session"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const originalFetch = globalThis.fetch
const key = "dictation-diagnostic-test-key"
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let entries: Array<Array<unknown>>
let restoreLog: () => void

function captureDiagnostic(...values: Array<unknown>) {
  entries.push(values)
}

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  setConfigForTest({ groqApiKey: "provider-credential-private" })
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: "diagnostic-key",
      credential: key,
      label: "diagnostic fixture",
      createdAt: 0,
    }),
  )
  entries = []
  const log = spyOn(consola, "error").mockImplementation(
    Object.assign(captureDiagnostic, { raw: captureDiagnostic }),
  )
  restoreLog = () => log.mockRestore()
})

afterEach(async () => {
  restoreLog()
  globalThis.fetch = originalFetch
  setConfigForTest(null)
  await fixture.close()
})

function upstream(reply: () => Promise<Response> | Response) {
  globalThis.fetch = Object.assign(() => Promise.resolve(reply()), {
    preconnect: originalFetch.preconnect,
  })
}

async function recording() {
  const request = new Request("https://gateway.test/user/dictation/ticket", {
    headers: { authorization: `Bearer ${key}` },
  })
  const admitted = await authorizeDictation(request)
  if (admitted.status !== "authorized")
    throw new Error("Fixture authorization failed")
  const session = createDictationSession(
    {
      authenticationRequest: request,
      authority: admitted.authority,
      streamDestination: "https://gateway.test/user/dictation/stream",
    },
    "en",
  )
  const done = Promise.withResolvers<number>()
  const frames: Array<string> = []
  const socket = {
    data: { session },
    send(value: string) {
      frames.push(value)
    },
    close(code = 1000) {
      done.resolve(code)
    },
  }
  desktopDictationWebSocket.message(socket, Uint8Array.of(0, 0, 1, 0))
  desktopDictationWebSocket.message(
    socket,
    JSON.stringify({ type: "CloseStream" }),
  )
  return { socket, done: done.promise, frames }
}

function assertPrivateValuesAbsent(frames: Array<string>) {
  const output = JSON.stringify({ entries, frames })
  for (const value of [
    key,
    "provider-credential-private",
    "upstream-body-private",
    "network-error-private",
  ])
    expect(output).not.toContain(value)
}

test("dictation logs only provider failure category and HTTP status", async () => {
  upstream(() => new Response("upstream-body-private", { status: 503 }))
  const run = await recording()
  expect(await run.done).toBe(1011)
  expect(entries).toEqual([
    [
      "[desktop-dictation] Transcription failed",
      { category: "upstream", status: 503 },
    ],
  ])
  assertPrivateValuesAbsent(run.frames)
})

test("dictation distinguishes missing stored Groq credentials without logging them", async () => {
  setConfigForTest({})
  upstream(() => {
    throw new Error("Provider must not be called")
  })
  const run = await recording()
  expect(await run.done).toBe(1011)
  expect(entries).toEqual([
    ["[desktop-dictation] Transcription failed", { category: "configuration" }],
  ])
  assertPrivateValuesAbsent(run.frames)
})

test("dictation does not log raw transport exceptions", async () => {
  upstream(() => {
    throw new TypeError("network-error-private")
  })
  const run = await recording()
  expect(await run.done).toBe(1011)
  expect(entries).toEqual([
    [
      "[desktop-dictation] Transcription failed",
      { category: "request_or_response" },
    ],
  ])
  assertPrivateValuesAbsent(run.frames)
})

test("dictation cancellation does not report an expected abort as a provider failure", async () => {
  const pending = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<undefined>()
  upstream(() => {
    entered.resolve(undefined)
    return pending.promise
  })
  const run = await recording()
  await entered.promise
  desktopDictationWebSocket.close(run.socket)
  pending.reject(new Error("network-error-private"))
  await Bun.sleep(20)
  expect(entries).toEqual([])
  assertPrivateValuesAbsent(run.frames)
})
