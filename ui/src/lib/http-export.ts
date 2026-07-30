import type { ParsedToolCall } from "./response-tool-calls"
import type { ParsedResponsesBody } from "./responses-body"
import type { LlmDebugLogRequest } from "./types"

export interface HttpResponseExportSource {
  body: string | null
  headers: Record<string, string>
  status: number
  statusText: string
}

interface FormattedToolArguments {
  language: "json" | "text"
  value: string
}

function formattedToolArguments(
  toolCall: ParsedToolCall,
): FormattedToolArguments {
  if (toolCall.argumentsJson !== null) {
    return {
      language: "json",
      value: JSON.stringify(toolCall.argumentsJson, null, 2),
    }
  }
  return { language: "text", value: toolCall.arguments }
}

export function buildCurlRequest(request: LlmDebugLogRequest): string {
  const lines = [
    `curl -X ${request.method.toUpperCase()} ${JSON.stringify(request.url)}`,
  ]
  for (const [key, value] of Object.entries(request.headers)) {
    lines.push(`  -H ${JSON.stringify(`${key}: ${value}`)}`)
  }
  if (request.body !== null) {
    lines.push(`  --data-raw ${JSON.stringify(request.body)}`)
  }
  return lines.join(" \\\n")
}

export function buildRawHttpRequest(request: LlmDebugLogRequest): string {
  let target = request.path
  let host: string | undefined
  try {
    const url = new URL(request.url)
    target = `${url.pathname}${url.search}`
    host = url.host
  } catch {
    // Preserve the captured path when the captured URL cannot be parsed.
  }

  const headers = Object.entries(request.headers)
  const hasHost = headers.some(([key]) => key.toLowerCase() === "host")
  const lines = [`${request.method.toUpperCase()} ${target} HTTP/1.1`]
  if (host && !hasHost) lines.push(`Host: ${host}`)
  for (const [key, value] of headers) lines.push(`${key}: ${value}`)
  lines.push("", request.body ?? "")
  return lines.join("\r\n")
}

export function formatRequestJson(body: string | null): string | null {
  if (body === null) return null
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`
  } catch {
    return null
  }
}

function toolCallMarkdown(toolCall: ParsedToolCall, index: number): string {
  const title = toolCall.name || `Tool call ${index + 1}`
  const metadata = [
    toolCall.callId ? `Call ID: \`${toolCall.callId}\`` : null,
    toolCall.id ? `Item ID: \`${toolCall.id}\`` : null,
  ].filter((line): line is string => line !== null)
  const formatted = formattedToolArguments(toolCall)
  return [
    `### ${title}`,
    ...metadata,
    `\`\`\`${formatted.language}\n${formatted.value}\n\`\`\``,
  ].join("\n\n")
}

export function buildAssistantOutputMarkdown(
  parsed: ParsedResponsesBody | null,
): string | null {
  if (!parsed || (!parsed.assistantText && parsed.toolCalls.length === 0)) {
    return null
  }

  const sections = ["# Assistant output"]
  if (parsed.assistantText) {
    sections.push(parsed.assistantText)
  } else {
    const count = parsed.toolCalls.length
    const noun = count === 1 ? "tool call" : "tool calls"
    sections.push(
      `The model returned ${count} ${noun} and no assistant message.`,
    )
  }

  if (parsed.toolCalls.length > 0) {
    sections.push(
      "## Tool calls",
      parsed.toolCalls
        .map((toolCall, index) => toolCallMarkdown(toolCall, index))
        .join("\n\n"),
    )
  }
  return `${sections.join("\n\n")}\n`
}

function formattedJson(body: string | null): string | null {
  if (body === null) return null
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`
  } catch {
    return null
  }
}

export function buildResponseJson(
  response: HttpResponseExportSource | undefined,
  parsed: ParsedResponsesBody | null,
): string | null {
  const direct = formattedJson(response?.body ?? null)
  if (direct !== null) return direct
  if (!parsed) return null

  return `${JSON.stringify(
    {
      status: parsed.status,
      assistantText: parsed.assistantText,
      toolCalls: parsed.toolCalls,
      reasoningText: parsed.reasoningText,
      errorMessage: parsed.errorMessage,
      usage: parsed.usage,
      copilotUsage: parsed.copilotUsage,
      response: parsed.response,
      events: parsed.events,
    },
    null,
    2,
  )}\n`
}

export function buildRawHttpResponse(
  response: HttpResponseExportSource,
): string {
  const statusLine =
    `HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd()
  const lines = [statusLine]
  for (const [key, value] of Object.entries(response.headers)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push("")
  return `${lines.join("\r\n")}\r\n${response.body ?? ""}`
}

export function downloadTextFile(
  filename: string,
  contents: string,
  type: string,
): void {
  const objectUrl = URL.createObjectURL(new Blob([contents], { type }))
  try {
    const anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = filename
    document.body.append(anchor)
    try {
      anchor.click()
    } finally {
      anchor.remove()
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function reportExportError(
  onError: ((message: string) => void) | undefined,
  error: unknown,
): void {
  if (onError) {
    onError(
      error instanceof Error && error.message ? error.message : "Export failed",
    )
    return
  }
  console.error("LLM export failed", error)
}
