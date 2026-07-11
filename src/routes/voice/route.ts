import consola from "consola"

import { resolveRequestCredential } from "~/lib/credential-resolver"

import { transcribe } from "./groq-stt"
import { pcmToWav } from "./pcm-to-wav"

const MIN_AUDIO_BYTES = 3200
export const VOICE_MAX_FRAME_BYTES = 64 * 1024
export const VOICE_MAX_AUDIO_BYTES = 4 * 1024 * 1024
export const VOICE_MAX_DURATION_MS = 120_000
export const VOICE_IDLE_TIMEOUT_MS = 20_000
export const VOICE_MAX_CONNECTIONS_PER_PRINCIPAL = 2
export const VOICE_MAX_CONNECTIONS_GLOBAL = 20
export const VOICE_DEFAULT_BUDGET_BYTES_PER_HOUR = 32 * 1024 * 1024

const activeVoiceConnections = new Map<string, number>()
const voiceBudgets = new Map<
  string,
  { windowStartedAt: number; consumedBytes: number }
>()
let activeVoiceConnectionCount = 0

export interface VoiceSession {
  pcmChunks: Array<Uint8Array>
  totalBytes: number
  language: string
  principalId: string
  startedAt: number
  finalized: boolean
  released: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  lifetimeTimer?: ReturnType<typeof setTimeout>
  transcriptionAbort?: AbortController
}

export type VoiceUpgradeResult =
  | "upgraded"
  | "auth_failed"
  | "no_match"
  | "limit_reached"

function createSession(language: string, principalId: string): VoiceSession {
  return {
    pcmChunks: [],
    totalBytes: 0,
    language,
    principalId,
    startedAt: Date.now(),
    finalized: false,
    released: false,
  }
}

function getBudgetBytesPerHour(): number {
  const configured = Number.parseInt(
    process.env.COPILOT_VOICE_BUDGET_BYTES_PER_HOUR ?? "",
    10,
  )
  return Number.isSafeInteger(configured) && configured > 0 ?
      configured
    : VOICE_DEFAULT_BUDGET_BYTES_PER_HOUR
}

function consumeVoiceBudget(principalId: string, bytes: number): boolean {
  const now = Date.now()
  let budget = voiceBudgets.get(principalId)
  if (!budget || now - budget.windowStartedAt >= 60 * 60 * 1000) {
    budget = { windowStartedAt: now, consumedBytes: 0 }
    voiceBudgets.set(principalId, budget)
  }
  if (budget.consumedBytes + bytes > getBudgetBytesPerHour()) return false
  budget.consumedBytes += bytes
  return true
}

function appendAudio(session: VoiceSession, data: Uint8Array): boolean {
  if (
    data.length > VOICE_MAX_FRAME_BYTES
    || session.totalBytes + data.length > VOICE_MAX_AUDIO_BYTES
    || !consumeVoiceBudget(session.principalId, data.length)
  ) {
    return false
  }
  session.pcmChunks.push(data)
  session.totalBytes += data.length
  return true
}

function getAudioBuffer(session: VoiceSession): Uint8Array {
  const buffer = new Uint8Array(session.totalBytes)
  let offset = 0
  for (const chunk of session.pcmChunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  return buffer
}

function clearAudio(session: VoiceSession): void {
  session.pcmChunks = []
  session.totalBytes = 0
}

function isSessionReleased(session: VoiceSession): boolean {
  return session.released
}

function releaseSession(session: VoiceSession): void {
  if (session.released) return
  session.released = true
  if (session.idleTimer) clearTimeout(session.idleTimer)
  if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer)
  session.transcriptionAbort?.abort()
  clearAudio(session)
  const activeForPrincipal =
    activeVoiceConnections.get(session.principalId) ?? 0
  if (activeForPrincipal <= 1)
    activeVoiceConnections.delete(session.principalId)
  else activeVoiceConnections.set(session.principalId, activeForPrincipal - 1)
  activeVoiceConnectionCount = Math.max(0, activeVoiceConnectionCount - 1)
}

function closeAndRelease(
  ws: { close(code?: number, reason?: string): void },
  session: VoiceSession,
  close: { code: number; reason: string },
): void {
  releaseSession(session)
  ws.close(close.code, close.reason)
}

function resetIdleTimer(
  ws: { close(code?: number, reason?: string): void },
  session: VoiceSession,
): void {
  if (session.idleTimer) clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(() => {
    closeAndRelease(ws, session, {
      code: 4008,
      reason: "Voice stream idle timeout",
    })
  }, VOICE_IDLE_TIMEOUT_MS)
}

async function finalizeAudio(
  session: VoiceSession,
  ws: {
    send(data: string | ArrayBuffer | Uint8Array): void
    close(code?: number, reason?: string): void
  },
): Promise<void> {
  if (session.finalized || session.released) return
  session.finalized = true
  if (session.idleTimer) clearTimeout(session.idleTimer)

  if (session.totalBytes < MIN_AUDIO_BYTES) {
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    clearAudio(session)
    ws.close(1000, "Voice stream complete")
    return
  }

  const pcm = getAudioBuffer(session)
  clearAudio(session)

  try {
    const wav = pcmToWav(pcm)
    session.transcriptionAbort = new AbortController()
    const result = await transcribe(wav, session.language, {
      timeoutMs: 30_000,
      signal: session.transcriptionAbort.signal,
    })
    if (isSessionReleased(session)) return
    if (result.text) {
      ws.send(JSON.stringify({ type: "TranscriptText", data: result.text }))
    }
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    ws.close(1000, "Voice stream complete")
  } catch (error) {
    if (isSessionReleased(session)) return
    const message =
      error instanceof Error ? error.message : "Transcription failed"
    consola.error("[voice]", message)
    ws.send(
      JSON.stringify({
        type: "TranscriptError",
        description: "Transcription failed",
      }),
    )
    ws.close(1011, "Transcription failed")
  }
}

export const voiceWebSocket = {
  open(ws: {
    data: { session: VoiceSession }
    close(code?: number, reason?: string): void
  }) {
    const { session } = ws.data
    session.lifetimeTimer = setTimeout(() => {
      closeAndRelease(ws, session, {
        code: 4008,
        reason: "Voice stream duration exceeded",
      })
    }, VOICE_MAX_DURATION_MS)
    resetIdleTimer(ws, session)
    consola.debug("[voice] WebSocket connected")
  },

  message(
    ws: {
      data: { session: VoiceSession }
      send(data: string | ArrayBuffer | Uint8Array): void
      close(code?: number, reason?: string): void
    },
    message: string | Buffer | Uint8Array,
  ) {
    const session = ws.data.session
    if (session.finalized || session.released) return
    resetIdleTimer(ws, session)

    if (typeof message !== "string") {
      const audio =
        message instanceof Uint8Array ? message : new Uint8Array(message)
      if (!appendAudio(session, audio)) {
        closeAndRelease(ws, session, {
          code: 4009,
          reason: "Voice stream size limit exceeded",
        })
      }
      return
    }

    if (new TextEncoder().encode(message).length > VOICE_MAX_FRAME_BYTES) {
      closeAndRelease(ws, session, {
        code: 4009,
        reason: "Voice control frame too large",
      })
      return
    }

    let parsed: { type?: unknown }
    try {
      parsed = JSON.parse(message) as { type?: unknown }
    } catch {
      closeAndRelease(ws, session, {
        code: 4007,
        reason: "Invalid voice control message",
      })
      return
    }

    if (parsed.type === "CloseStream") {
      void finalizeAudio(session, ws)
    } else if (parsed.type !== "KeepAlive") {
      closeAndRelease(ws, session, {
        code: 4007,
        reason: "Invalid voice control message",
      })
    }
  },

  close(ws: { data: { session: VoiceSession } }) {
    releaseSession(ws.data.session)
    consola.debug("[voice] WebSocket closed")
  },
}

export const VOICE_WS_PATH = "/api/ws/speech_to_text/voice_stream"

export async function tryUpgradeVoiceWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): Promise<VoiceUpgradeResult> {
  const url = new URL(req.url)
  if (url.pathname !== VOICE_WS_PATH) return "no_match"

  const credential = await resolveRequestCredential(req, ["voice:transcribe"])
  if (!credential) return "auth_failed"

  const origin = req.headers.get("origin")
  const configuredOrigin = process.env.COPILOT_VOICE_ORIGIN?.trim()
  if (origin && (!configuredOrigin || origin !== configuredOrigin)) {
    return "auth_failed"
  }

  const activeForPrincipal =
    activeVoiceConnections.get(credential.principalId) ?? 0
  if (
    activeForPrincipal >= VOICE_MAX_CONNECTIONS_PER_PRINCIPAL
    || activeVoiceConnectionCount >= VOICE_MAX_CONNECTIONS_GLOBAL
  ) {
    return "limit_reached"
  }

  const session = createSession(
    url.searchParams.get("language") ?? "en",
    credential.principalId,
  )
  activeVoiceConnections.set(credential.principalId, activeForPrincipal + 1)
  activeVoiceConnectionCount += 1
  const upgraded = server.upgrade(req, {
    data: { type: "voice" as const, session },
  })
  if (!upgraded) {
    releaseSession(session)
    return "no_match"
  }
  return "upgraded"
}

export function resetVoiceConnectionsForTest(): void {
  activeVoiceConnections.clear()
  voiceBudgets.clear()
  activeVoiceConnectionCount = 0
}
