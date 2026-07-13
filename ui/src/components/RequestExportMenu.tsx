import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import type { LlmDebugLogRequest } from "../lib/types"

import { CopyIcon, DownloadIcon, TerminalIcon } from "../icons"

function buildCurl(request: LlmDebugLogRequest): string {
  const lines = [
    `curl -X ${request.method.toUpperCase()} ${JSON.stringify(request.url)}`,
  ]
  for (const [key, value] of Object.entries(request.headers)) {
    lines.push(`  -H ${JSON.stringify(`${key}: ${value}`)}`)
  }
  if (request.body) lines.push(`  --data-raw ${JSON.stringify(request.body)}`)
  return lines.join(" \\\n")
}

function buildRawHttpRequest(request: LlmDebugLogRequest): string {
  let target = request.path
  let host: string | undefined
  try {
    const url = new URL(request.url)
    target = `${url.pathname}${url.search}`
    host = url.host
  } catch {
    // The captured path remains a useful request target for malformed URLs.
  }
  const headers = Object.entries(request.headers)
  const hasHost = headers.some(([key]) => key.toLowerCase() === "host")
  const lines = [`${request.method.toUpperCase()} ${target} HTTP/1.1`]
  if (host && !hasHost) lines.push(`Host: ${host}`)
  for (const [key, value] of headers) lines.push(`${key}: ${value}`)
  lines.push("", request.body ?? "")
  return lines.join("\r\n")
}

function formatRequestJson(body: string | null): string | null {
  if (body === null) return null
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`
  } catch {
    return null
  }
}

function downloadText(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function RequestExportMenu({
  id,
  request,
  onExport,
}: {
  id: string
  request?: LlmDebugLogRequest
  onExport: (format: string) => void
}) {
  const requestJson = formatRequestJson(request?.body ?? null)

  function exportRequest(
    extension: "curl" | "http" | "json",
    contents: string,
    type = "text/plain;charset=utf-8",
  ) {
    downloadText(`llm-request-${id}.${extension}`, contents, type)
    onExport(extension.toUpperCase())
  }

  return (
    <DropdownMenu
      button={{
        label: "Export",
        variant: "secondary",
        size: "sm",
        icon: <DownloadIcon />,
        isDisabled: !request,
      }}
      menuWidth={260}
      placement="below"
    >
      <DropdownMenuItem
        label="cURL command"
        description="Portable shell command"
        icon={<TerminalIcon />}
        onClick={() => {
          if (request) exportRequest("curl", `${buildCurl(request)}\n`)
        }}
      />
      <DropdownMenuItem
        label="Request JSON"
        description="Formatted request body"
        icon={<DownloadIcon />}
        isDisabled={requestJson === null}
        onClick={() => {
          if (requestJson) {
            exportRequest("json", requestJson, "application/json;charset=utf-8")
          }
        }}
      />
      <DropdownMenuItem
        label="Raw HTTP request"
        description="Request line, headers, and body"
        icon={<CopyIcon />}
        onClick={() => {
          if (request) exportRequest("http", buildRawHttpRequest(request))
        }}
      />
    </DropdownMenu>
  )
}
