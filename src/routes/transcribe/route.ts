import consola from "consola"
import { Hono } from "hono"

import {
  extractClientIp,
  isIpAllowedForWhitelistedRoute,
} from "~/lib/ip-blocker"
import { transcribe } from "~/routes/voice/groq-stt"

export const transcribeRoutes = new Hono()

const CODEX_TRANSCRIBE_TIMEOUT_MS = 30_000

function silentDrop(): Response {
  return new Response(null, { status: 404 })
}

/**
 * Codex Desktop dictation endpoint.
 *
 * Codex (in API-key auth mode) posts `multipart/form-data` audio to
 * `${CODEX_API_BASE_URL}/transcribe` with fields:
 *   - file       (audio blob, typically audio/webm)
 *   - language   (optional, e.g. "en")
 *
 * Auth model: IP whitelist only. The whitelist is populated when an IP
 * successfully authenticates against this gateway, including model endpoints
 * protected by configured API keys, and can also be managed from the dashboard.
 * So a machine that already has Claude Code / another client authenticated
 * against this gateway can dictate via Codex without sending an API key.
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
  const clientIp = extractClientIp(c)
  const isAllowed =
    clientIp !== null && (await isIpAllowedForWhitelistedRoute(clientIp))

  if (!isAllowed) {
    consola.warn(
      `[transcribe] Rejected: IP ${clientIp ?? "(unknown)"} not whitelisted`,
    )
    return silentDrop()
  }

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
