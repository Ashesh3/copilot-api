import consola from "consola"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { authorizeCodexDesktopRequest } from "~/lib/codex-desktop-auth"
import { getCodexCleanupModel } from "~/lib/config"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type Message,
} from "~/services/copilot/create-chat-completions"

export const codexResponsesRoutes = new Hono()

interface CodexResponsesContent {
  type?: string
  text?: string
}

interface CodexResponsesInput {
  type?: string
  role?: string
  content?: Array<CodexResponsesContent>
}

interface CodexResponsesBody {
  model?: string
  instructions?: string
  input?: Array<CodexResponsesInput>
}

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

function extractUserText(body: CodexResponsesBody): string {
  const parts: Array<string> = []
  for (const item of body.input ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.length > 0) {
        parts.push(content.text)
      }
    }
  }
  return parts.join("\n").trim()
}

/**
 * Codex Desktop dictation cleanup endpoint.
 *
 * Codex (`use-recording-waveform.js`, function `g`) POSTs a Responses-API
 * request here with model `gpt-5.4-mini` and `stream: true`, containing the
 * raw transcript in `input[0].content[0].text` and the cleanup prompt in
 * `instructions`. It expects SSE events shaped like one of:
 *   {"type":"response.output_text.delta","delta":"..."}
 *   {"type":"response.output_text.done","text":"..."}
 *   {"response":{"output":[{"content":[{"text":"..."}]}]}}
 *   {"error":"..."}
 *
 * We forward the cleanup to Copilot via the configured small model and emit
 * one `response.output_text.done` event with the cleaned text. On failure we
 * emit an error event — Codex's renderer wraps this in try/catch and falls
 * back to the raw transcript, so dictation still works.
 *
 * Auth: API key OR IP whitelist (same model as /transcribe — see
 * `authorizeCodexDesktopRequest`).
 */
codexResponsesRoutes.post("/", async (c) => {
  const auth = await authorizeCodexDesktopRequest(c, "codex-responses")
  if (!auth.allowed) {
    return unauthorized(c)
  }
  const clientIp = auth.clientIp

  let body: CodexResponsesBody
  try {
    body = await c.req.json<CodexResponsesBody>()
  } catch (error) {
    consola.error("[codex-responses] Failed to parse JSON body", error)
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const instructions =
    typeof body.instructions === "string" ? body.instructions : ""
  const userText = extractUserText(body)

  if (userText.length === 0) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ type: "response.output_text.done", text: "" }),
      })
    })
  }

  const model = getCodexCleanupModel()
  const messages: Array<Message> = []
  if (instructions.length > 0) {
    messages.push({ role: "system", content: instructions })
  }
  messages.push({ role: "user", content: userText })

  return streamSSE(c, async (stream) => {
    try {
      const result = (await createChatCompletions({
        model,
        messages,
        stream: false,
      })) as ChatCompletionResponse

      const cleaned = result.choices[0]?.message.content?.trim() ?? ""
      const text = cleaned.length > 0 ? cleaned : userText

      consola.info(
        `[codex-responses] ${clientIp} → cleanup ${userText.length}→${text.length} chars via ${model}`,
      )

      await stream.writeSSE({
        data: JSON.stringify({
          type: "response.output_text.done",
          text,
        }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cleanup failed"
      consola.error("[codex-responses]", message)
      await stream.writeSSE({
        data: JSON.stringify({ error: message }),
      })
    }
  })
})
