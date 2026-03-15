import { getConfig } from "~/lib/config"

export interface TranscriptionResult {
  text: string
}

/**
 * Sends a WAV audio buffer to Groq's Whisper API for transcription.
 */
export async function transcribe(
  wavData: Uint8Array,
  language?: string,
): Promise<TranscriptionResult> {
  const config = getConfig()
  const apiKey = config.groqApiKey ?? process.env.GROQ_API_KEY

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured")
  }

  const model = config.groqModel ?? "whisper-large-v3-turbo"
  const url = "https://api.groq.com/openai/v1/audio/transcriptions"

  const formData = new FormData()
  formData.append(
    "file",
    new Blob([wavData], { type: "audio/wav" }),
    "audio.wav",
  )
  formData.append("model", model)
  formData.append("response_format", "json")

  if (language && language !== "auto") {
    formData.append("language", language)
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Groq API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as { text?: string }
  return { text: data.text?.trim() ?? "" }
}
