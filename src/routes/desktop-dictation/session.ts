import consola from "consola"

import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { GroqTranscriptionError, transcribe } from "~/routes/voice/groq-stt"
import { pcmToWav } from "~/routes/voice/pcm-to-wav"

import type { DictationTicketBinding } from "./tickets"

import { authorizeDictation, type DictationAdmission } from "./authorization"

export interface DesktopDictationSession {
  binding?: DictationTicketBinding
  language: string
  phase: "recording" | "finalizing" | "released"
  pcmChunks: Array<Uint8Array>
  totalBytes: number
  transcriptionAbort?: AbortController
}

interface DictationSocket {
  data: { session: DesktopDictationSession }
  send(data: string): unknown
  close(code?: number, reason?: string): unknown
}

export function createDictationSession(
  binding: DictationTicketBinding,
  language: string,
): DesktopDictationSession {
  return {
    binding,
    language,
    phase: "recording",
    pcmChunks: [],
    totalBytes: 0,
  }
}

export function releaseDictationSession(
  session: DesktopDictationSession,
): void {
  if (session.phase === "released") return
  session.phase = "released"
  session.transcriptionAbort?.abort()
  session.binding = undefined
  session.pcmChunks = []
  session.totalBytes = 0
}

function isReleased(session: DesktopDictationSession): boolean {
  return session.phase === "released"
}

function closeSession(ws: DictationSocket, code: number, reason: string): void {
  releaseDictationSession(ws.data.session)
  ws.close(code, reason)
}

function rejectSession(
  ws: DictationSocket,
  code: number,
  description: string,
): void {
  if (isReleased(ws.data.session)) return
  try {
    ws.send(JSON.stringify({ type: "TranscriptError", description }))
  } finally {
    closeSession(ws, code, description)
  }
}

function rejectAdmission(
  ws: DictationSocket,
  admission: Exclude<DictationAdmission, { status: "authorized" }>,
): void {
  const unavailable = admission.status === "unavailable"
  rejectSession(
    ws,
    unavailable ? 1011 : 1008,
    unavailable ?
      "Database storage is temporarily unavailable."
    : "Authentication failed",
  )
}

function takeWav(session: DesktopDictationSession): Uint8Array {
  const pcm = new Uint8Array(session.totalBytes)
  let offset = 0
  for (const chunk of session.pcmChunks) {
    pcm.set(chunk, offset)
    offset += chunk.byteLength
  }
  session.pcmChunks = []
  session.totalBytes = 0
  return pcmToWav(pcm)
}

async function finalize(ws: DictationSocket): Promise<void> {
  const session = ws.data.session
  if (session.phase !== "recording" || !session.binding) return
  session.phase = "finalizing"
  const binding = session.binding
  session.transcriptionAbort = new AbortController()
  try {
    const admission = await authorizeDictation(
      binding.authenticationRequest,
      binding.authority,
    )
    if (isReleased(session)) return
    if (admission.status !== "authorized") {
      rejectAdmission(ws, admission)
      return
    }
    if (session.totalBytes > 0) {
      const wav = takeWav(session)
      const result = await withRequestSnapshot(admission.snapshot, () =>
        transcribe(wav, session.language, {
          signal: session.transcriptionAbort?.signal,
        }),
      )
      if (isReleased(session)) return
      const current = await authorizeDictation(
        binding.authenticationRequest,
        binding.authority,
      )
      if (isReleased(session)) return
      if (current.status !== "authorized") {
        rejectAdmission(ws, current)
        return
      }
      if (result.text)
        ws.send(JSON.stringify({ type: "TranscriptText", data: result.text }))
    }
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    closeSession(ws, 1000, "Dictation complete")
  } catch (error) {
    if (isReleased(session)) return
    const diagnostic =
      error instanceof GroqTranscriptionError ?
        {
          category: error.category,
          ...(error.status === undefined ? {} : { status: error.status }),
        }
      : { category: "request_or_response" }
    consola.error("[desktop-dictation] Transcription failed", diagnostic)
    rejectSession(ws, 1011, "Transcription failed")
  }
}

function appendAudio(ws: DictationSocket, audio: Uint8Array): void {
  const session = ws.data.session
  if (session.phase !== "recording" || audio.byteLength % 2 !== 0) {
    rejectSession(ws, 1003, "Invalid dictation audio")
    return
  }
  if (audio.byteLength === 0) return
  session.pcmChunks.push(Uint8Array.from(audio))
  session.totalBytes += audio.byteLength
}

function controlType(message: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(message)
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || !("type" in parsed)
      || typeof parsed.type !== "string"
    ) {
      return undefined
    }
    return parsed.type
  } catch {
    return undefined
  }
}

export const desktopDictationWebSocket = {
  open(_ws: DictationSocket): void {},
  message(ws: DictationSocket, message: string | Buffer | Uint8Array): void {
    const session = ws.data.session
    if (isReleased(session)) return
    if (typeof message !== "string") {
      appendAudio(ws, message)
      return
    }
    const type = controlType(message)
    if (type === "KeepAlive") {
      ws.send(JSON.stringify({ type: "KeepAliveAck" }))
    } else if (type === "CloseStream") {
      void finalize(ws)
    } else {
      rejectSession(ws, 1003, "Invalid dictation control message")
    }
  },
  close(ws: { data: { session: DesktopDictationSession } }): void {
    releaseDictationSession(ws.data.session)
  },
}
