import consola from "consola"

import type { RuntimeSnapshot } from "~/lib/storage/types"
import type { TranscriptionResult } from "~/routes/voice/groq-stt"

import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { GroqTranscriptionError, transcribe } from "~/routes/voice/groq-stt"
import { pcmToWav } from "~/routes/voice/pcm-to-wav"

import type { DictationTicketBinding } from "./tickets"

import { authorizeDictation, type DictationAdmission } from "./authorization"
import {
  DICTATION_BATCH_BYTES,
  hasFreshSpeech,
  partitionTranscript,
} from "./transcript"

export interface DesktopDictationSession {
  binding?: DictationTicketBinding
  language: string
  phase: "recording" | "finalizing" | "released"
  pcmChunks: Array<Uint8Array>
  totalBytes: number
  retainedAudio: Uint8Array
  interimText: string
  processing: boolean
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
    retainedAudio: new Uint8Array(),
    interimText: "",
    processing: false,
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
  session.retainedAudio = new Uint8Array()
  session.interimText = ""
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

function takeAudio(
  session: DesktopDictationSession,
  bytes: number,
): Uint8Array {
  const pcm = new Uint8Array(session.retainedAudio.byteLength + bytes)
  pcm.set(session.retainedAudio)
  let offset = session.retainedAudio.byteLength
  let remaining = bytes
  session.retainedAudio = new Uint8Array()
  session.totalBytes -= bytes
  while (remaining > 0) {
    const chunk = session.pcmChunks.shift()
    if (!chunk) throw new Error("Invalid dictation audio buffer")
    const length = Math.min(chunk.byteLength, remaining)
    pcm.set(chunk.subarray(0, length), offset)
    offset += length
    remaining -= length
    if (length < chunk.byteLength)
      session.pcmChunks.unshift(chunk.subarray(length))
  }
  return pcm
}

async function admitBatch(ws: DictationSocket) {
  const session = ws.data.session
  if (isReleased(session) || !session.binding) return
  const binding = session.binding
  const admission = await authorizeDictation(
    binding.authenticationRequest,
    binding.authority,
  )
  if (isReleased(session)) return
  if (admission.status !== "authorized") {
    rejectAdmission(ws, admission)
    return
  }
  return admission
}

function sendInterim(ws: DictationSocket, text: string, fresh = false): void {
  // Native Desktop ignores empty updates; keep its last recognized words.
  if (!text || (!fresh && text === ws.data.session.interimText)) return
  ws.send(JSON.stringify({ type: "TranscriptInterim", data: text }))
  ws.data.session.interimText = text
}

function finish(ws: DictationSocket, text: string): void {
  if (text) ws.send(JSON.stringify({ type: "TranscriptText", data: text }))
  ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
  closeSession(ws, 1000, "Dictation complete")
}

function transcribeAudio(
  session: DesktopDictationSession,
  pcm: Uint8Array,
  options: { snapshot: RuntimeSnapshot; final: boolean },
): Promise<TranscriptionResult> {
  const controller = new AbortController()
  session.transcriptionAbort = controller
  return withRequestSnapshot(options.snapshot, () =>
    transcribe(pcmToWav(pcm), session.language, {
      signal: controller.signal,
      segmentTimestamps: !options.final,
    }),
  )
}

async function processBatch(ws: DictationSocket): Promise<void> {
  const session = ws.data.session
  const admission = await admitBatch(ws)
  if (!admission || isReleased(session)) return
  const final = session.phase === "finalizing"
  const retainedBytes = session.retainedAudio.byteLength
  const pcm = takeAudio(
    session,
    final ? session.totalBytes : DICTATION_BATCH_BYTES,
  )
  if (pcm.byteLength === 0) {
    finish(ws, "")
    return
  }
  const result = await transcribeAudio(session, pcm, {
    snapshot: admission.snapshot,
    final,
  })
  if (!(await admitBatch(ws))) return
  session.transcriptionAbort = undefined
  if (final || (session.phase === "finalizing" && session.totalBytes === 0)) {
    finish(ws, result.text)
    return
  }
  const fresh = hasFreshSpeech(result, retainedBytes, pcm.byteLength)
  if (result.text && result.text === session.interimText && !fresh) {
    // Re-recognizing only retained context is not fresh speech activity.
    session.retainedAudio = pcm
    return
  }
  const partition = partitionTranscript(result, pcm.byteLength)
  session.retainedAudio = pcm.slice(partition.retainFrom)
  if (partition.stableText) {
    ws.send(
      JSON.stringify({ type: "TranscriptText", data: partition.stableText }),
    )
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    session.interimText = ""
  }
  sendInterim(ws, partition.interimText, fresh)
}

async function processAudio(ws: DictationSocket): Promise<void> {
  const session = ws.data.session
  try {
    while (
      !isReleased(session)
      && (session.phase === "finalizing"
        || session.totalBytes >= DICTATION_BATCH_BYTES)
    )
      await processBatch(ws)
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
  } finally {
    session.processing = false
  }
}

function startProcessing(ws: DictationSocket): void {
  const session = ws.data.session
  if (session.processing || isReleased(session)) return
  if (
    session.phase === "recording"
    && session.totalBytes < DICTATION_BATCH_BYTES
  )
    return
  session.processing = true
  void processAudio(ws)
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
  startProcessing(ws)
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
      if (session.phase !== "recording") return
      session.phase = "finalizing"
      startProcessing(ws)
    } else {
      rejectSession(ws, 1003, "Invalid dictation control message")
    }
  },
  close(ws: { data: { session: DesktopDictationSession } }): void {
    releaseDictationSession(ws.data.session)
  },
}
