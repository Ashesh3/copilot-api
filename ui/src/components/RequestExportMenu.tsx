import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import type { LlmDebugLogRequest } from "../lib/types"

import { CopyIcon, DownloadIcon, TerminalIcon } from "../icons"
import {
  buildCurlRequest,
  buildRawHttpRequest,
  downloadTextFile,
  formatRequestJson,
  reportExportError,
} from "../lib/http-export"

interface RequestExportMenuProps {
  body?: string | null
  id: string
  isJsonValid?: boolean
  request?: LlmDebugLogRequest
  onError?: (message: string) => void
  onExport: (format: string) => void
}

interface RequestExportFile {
  contents: string
  extension: "curl" | "http" | "json"
  format: string
  type: string
}

export function RequestExportMenu({
  body,
  id,
  isJsonValid,
  request,
  onError,
  onExport,
}: RequestExportMenuProps) {
  const exportRequest =
    request && body !== undefined ? { ...request, body } : request
  const requestJson =
    isJsonValid === false ? null : (
      formatRequestJson(exportRequest?.body ?? null)
    )

  function save(file: RequestExportFile): void {
    try {
      downloadTextFile(
        `llm-request-${id}.${file.extension}`,
        file.contents,
        file.type,
      )
      onExport(file.format)
    } catch (error) {
      reportExportError(onError, error)
    }
  }

  return (
    <DropdownMenu
      button={{
        label: "Export request",
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
          if (exportRequest) {
            save({
              contents: `${buildCurlRequest(exportRequest)}\n`,
              extension: "curl",
              format: "cURL",
              type: "text/plain",
            })
          }
        }}
      />
      <DropdownMenuItem
        label="Request JSON"
        description="Formatted request body"
        icon={<DownloadIcon />}
        isDisabled={requestJson === null}
        onClick={() => {
          if (requestJson !== null) {
            save({
              contents: requestJson,
              extension: "json",
              format: "JSON",
              type: "application/json",
            })
          }
        }}
      />
      <DropdownMenuItem
        label="Raw HTTP request"
        description="Request line, headers, and body"
        icon={<CopyIcon />}
        onClick={() => {
          if (exportRequest) {
            save({
              contents: buildRawHttpRequest(exportRequest),
              extension: "http",
              format: "HTTP",
              type: "message/http",
            })
          }
        }}
      />
    </DropdownMenu>
  )
}
