import consola from "consola"
import { Hono } from "hono"

import { authorizeCodexDesktopTranscriptionRequest } from "~/lib/codex-desktop-auth"
import { transcribe } from "~/routes/voice/groq-stt"

export const transcribeRoutes = new Hono()

function unauthorized(c: {
  header(name: string, value: string): void
  json(value: unknown, status: 401): Response
}): Response {
  c.header("Cache-Control", "no-store")
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}

/**
 * Codex Desktop dictation endpoint.
 *
 * Codex (in API-key auth mode) posts `multipart/form-data` audio to
 * `${CODEX_API_BASE_URL}/transcribe` with fields:
 *   - file       (audio blob, typically audio/webm)
 *   - language   (optional, e.g. "en")
 *
 * Auth model: a valid inference-capable bearer/API key, with a managed/session
 * IP allowlist fallback for older Desktop builds that omit credentials. A
 * successful credential also persists the resolved client IP for subsequent
 * credential-free compatibility requests.
 *
 * Codex MAY or MAY NOT attach `originator: Codex Desktop` and a
 * `User-Agent: Codex Desktop/...` header depending on whether the gateway
 * hostname matches Codex's auth allowlist (`localhost`, `*.openai.com`,
 * `*.chatgpt.com`). Both are logged at debug level for visibility but are
 * NOT required.
 *
 * Response shape required by Codex's renderer: { "text": "..." }
 */
transcribeRoutes.post("/", async (c) => {
  const auth = await authorizeCodexDesktopTranscriptionRequest(c, "transcribe")
  if (!auth.allowed) {
    return unauthorized(c)
  }
  const clientIp = auth.clientIp

  consola.debug(
    `[transcribe] ${clientIp} originator=${c.req.header("originator") ?? "(none)"} ua=${c.req.header("user-agent") ?? "(none)"}`,
  )

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch (error) {
    consola.error("[transcribe] Failed to parse multipart body", error)
    return c.json({ error: "Invalid multipart body" }, 400)
  }

  const file = formData.get("file")
  if (!(file instanceof Blob)) {
    return c.json({ error: "Missing 'file' field" }, 400)
  }

  const languageRaw = formData.get("language")
  const language =
    typeof languageRaw === "string" && languageRaw.trim().length > 0 ?
      languageRaw.trim()
    : undefined

  const bytes = new Uint8Array(await file.arrayBuffer())
  const contentType = file.type || "audio/webm"
  const filename = "name" in file && file.name ? file.name : "codex.webm"

  try {
    const result = await transcribe(bytes, language, {
      contentType,
      filename,
      signal: c.req.raw.signal,
    })
    consola.info(
      `[transcribe] ${clientIp} → ${bytes.length}B ${contentType} → "${result.text}"`,
    )
    return c.json({ text: result.text })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transcription failed"
    consola.error("[transcribe]", message)
    return c.json({ error: message }, 502)
  }
})
