import consola from "consola"

import { transcribe } from "./groq-stt"
import { pcmToWav } from "./pcm-to-wav"

// Minimum audio length to send to Groq (0.1s at 16kHz, 16-bit, mono = 3200 bytes)
const MIN_AUDIO_BYTES = 3200

interface VoiceSession {
  pcmChunks: Array<Uint8Array>
  totalBytes: number
  language: string
}

function createSession(language: string): VoiceSession {
  return {
    pcmChunks: [],
    totalBytes: 0,
    language,
  }
}

function appendAudio(session: VoiceSession, data: Uint8Array): void {
  session.pcmChunks.push(data)
  session.totalBytes += data.length
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

async function finalizeAudio(
  session: VoiceSession,
  ws: { send(data: string | ArrayBuffer | Uint8Array): void },
): Promise<void> {
  if (session.totalBytes < MIN_AUDIO_BYTES) {
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    clearAudio(session)
    return
  }

  const pcm = getAudioBuffer(session)
  clearAudio(session)

  try {
    const wav = pcmToWav(pcm)
    const result = await transcribe(wav, session.language)

    if (result.text) {
      ws.send(JSON.stringify({ type: "TranscriptText", data: result.text }))
    }
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transcription failed"
    consola.error("[voice]", message)
    ws.send(JSON.stringify({ type: "TranscriptError", description: message }))
  }
}

// WebSocket handlers for Bun.serve
export const voiceWebSocket = {
  open(_ws: { data: { session: VoiceSession } }) {
    consola.debug("[voice] WebSocket connected")
  },

  message(
    ws: {
      data: { session: VoiceSession }
      send(data: string | ArrayBuffer | Uint8Array): void
    },
    message: string | Buffer | Uint8Array,
  ) {
    const session = ws.data.session

    // Binary frame: audio data
    if (typeof message !== "string") {
      const audio =
        message instanceof Uint8Array ? message : new Uint8Array(message)
      appendAudio(session, audio)
      return
    }

    // Text frame: JSON control message
    let parsed: { type: string }
    try {
      parsed = JSON.parse(message) as { type: string }
    } catch {
      return
    }

    switch (parsed.type) {
      case "KeepAlive": {
        break
      }
      case "CloseStream": {
        void finalizeAudio(session, ws)
        break
      }
      default: {
        break
      }
    }
  },

  close(_ws: { data: { session: VoiceSession } }) {
    consola.debug("[voice] WebSocket closed")
  },
}

// Path that Claude Code connects to
export const VOICE_WS_PATH = "/api/ws/speech_to_text/voice_stream"

/**
 * Check if a request is a voice WebSocket upgrade and handle it.
 * Returns true if the upgrade was handled.
 */
export function tryUpgradeVoiceWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): boolean {
  const url = new URL(req.url)
  if (url.pathname !== VOICE_WS_PATH) return false

  const language = url.searchParams.get("language") ?? "en"
  const session = createSession(language)

  return server.upgrade(req, { data: { type: "voice" as const, session } })
}
