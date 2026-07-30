import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import type { ParsedResponsesBody } from "../lib/responses-body"
import type { LlmDebugLogResponse } from "../lib/types"

import { CopyIcon, DownloadIcon } from "../icons"
import {
  buildAssistantOutputMarkdown,
  buildRawHttpResponse,
  buildResponseJson,
  downloadTextFile,
  reportExportError,
} from "../lib/http-export"

interface ResponseExportMenuProps {
  id: string
  parsed: ParsedResponsesBody | null
  response?: LlmDebugLogResponse
  onError?: (message: string) => void
  onExport: (format: string) => void
}

interface ResponseExportFile {
  contents: string
  extension: "http" | "json" | "md"
  format: string
  type: string
}

export function ResponseExportMenu({
  id,
  parsed,
  response,
  onError,
  onExport,
}: ResponseExportMenuProps) {
  const markdown = buildAssistantOutputMarkdown(parsed)
  const responseJson = buildResponseJson(response, parsed)

  function save(file: ResponseExportFile): void {
    try {
      downloadTextFile(
        `llm-response-${id}.${file.extension}`,
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
        label: "Export response",
        variant: "secondary",
        size: "sm",
        icon: <DownloadIcon />,
        isDisabled: !response,
      }}
      menuWidth={260}
      placement="below"
    >
      <DropdownMenuItem
        label="Assistant output"
        description="Markdown output and tool calls"
        icon={<DownloadIcon />}
        isDisabled={markdown === null}
        onClick={() => {
          if (markdown !== null) {
            save({
              contents: markdown,
              extension: "md",
              format: "Markdown",
              type: "text/markdown",
            })
          }
        }}
      />
      <DropdownMenuItem
        label="Response JSON"
        description="Formatted or normalized response"
        icon={<DownloadIcon />}
        isDisabled={responseJson === null}
        onClick={() => {
          if (responseJson !== null) {
            save({
              contents: responseJson,
              extension: "json",
              format: "JSON",
              type: "application/json",
            })
          }
        }}
      />
      <DropdownMenuItem
        label="Raw HTTP response"
        description="Status, headers, and exact body"
        icon={<CopyIcon />}
        onClick={() => {
          if (response) {
            save({
              contents: buildRawHttpResponse(response),
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
