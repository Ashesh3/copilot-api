import consola from "consola"
import { Hono } from "hono"

import { authorizeCodexDesktopRequest } from "~/lib/codex-desktop-auth"
import { transcribe } from "~/routes/voice/groq-stt"

export const transcribeRoutes = new Hono()

const CODEX_TRANSCRIBE_TIMEOUT_MS = 30_000

function unauthorized(c: {
  header(name: string, value: string): void
  json(value: unknown, status: 401): Response
}): Response {
  c.header("Cache-Control", "no-store")
  c.header("WWW-Authenticate", "Be" + 'arer realm="copilot-api"')
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
 * Auth model: API key OR IP whitelist (see `authorizeCodexDesktopRequest`).
 * When `CODEX_API_BASE_URL` is spoofed to an `*.openai.com` host (e.g.
 * `https://voice.openai.com`), Codex Desktop's main process attaches
 * `Authorization: Bearer <token>` from `~/.codex/auth.json` and we accept it
 * if it matches an active gateway key. Otherwise we fall back to the IP
 * whitelist (populated by other authenticated clients or the dashboard).
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
  const auth = await authorizeCodexDesktopRequest(c, "transcribe")
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
      timeoutMs: CODEX_TRANSCRIBE_TIMEOUT_MS,
    })
    const preview =
      result.text.length > 60 ? `${result.text.slice(0, 60)}…` : result.text
    consola.info(
      `[transcribe] ${clientIp} → ${bytes.length}B ${contentType} → "${preview}"`,
    )
    return c.json({ text: result.text })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transcription failed"
    consola.error("[transcribe]", message)
    return c.json({ error: message }, 502)
  }
})
