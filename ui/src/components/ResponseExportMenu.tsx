import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"
import { Text } from "@astryxdesign/core/Text"
import { useState } from "react"

import type { HttpResponseExportSource } from "../lib/http-export"
import type { ParsedResponsesBody } from "../lib/responses-body"

import { CopyIcon, DownloadIcon } from "../icons"
import {
  RESPONSE_EXPORT_MEDIA_TYPES,
  downloadTextFile,
  reportExportError,
} from "../lib/http-export"
import {
  createResponseExportActions,
  responseExportAvailability,
} from "../lib/response-export-actions"

interface ResponseExportMenuProps {
  id: string
  parsed: ParsedResponsesBody | null
  response?: HttpResponseExportSource
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
  const [exportError, setExportError] = useState<string | null>(null)
  const source = { parsed, response }
  const availability = responseExportAvailability(source)
  const actions = createResponseExportActions(source)

  function save(file: ResponseExportFile): void {
    try {
      downloadTextFile(
        `llm-response-${id}.${file.extension}`,
        file.contents,
        file.type,
      )
    } catch (error) {
      const message = reportExportError(undefined, error)
      setExportError(message)
      onError?.(message)
      return
    }
    setExportError(null)
    onExport(file.format)
  }

  return (
    <div style={{ minWidth: 0 }}>
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
          isDisabled={!availability.assistantOutput}
          onClick={() => {
            const markdown = actions.buildAssistantOutput()
            if (markdown !== null) {
              save({
                contents: markdown,
                extension: "md",
                format: "Markdown",
                type: RESPONSE_EXPORT_MEDIA_TYPES.markdown,
              })
            }
          }}
        />
        <DropdownMenuItem
          label="Response JSON"
          description="Formatted or normalized response"
          icon={<DownloadIcon />}
          isDisabled={!availability.responseJson}
          onClick={() => {
            const responseJson = actions.buildResponseJson()
            if (responseJson !== null) {
              save({
                contents: responseJson,
                extension: "json",
                format: "JSON",
                type: RESPONSE_EXPORT_MEDIA_TYPES.json,
              })
            }
          }}
        />
        <DropdownMenuItem
          label="Raw HTTP response"
          description="Status, headers, and exact body"
          icon={<CopyIcon />}
          isDisabled={!availability.rawHttpResponse}
          onClick={() => {
            const rawResponse = actions.buildRawHttpResponse()
            if (rawResponse !== null) {
              save({
                contents: rawResponse,
                extension: "http",
                format: "HTTP",
                type: RESPONSE_EXPORT_MEDIA_TYPES.http,
              })
            }
          }}
        />
      </DropdownMenu>
      {exportError ?
        <div
          role="alert"
          style={{ color: "var(--color-error)", overflowWrap: "anywhere" }}
        >
          <Text type="supporting" color="inherit">
            {exportError}
          </Text>
        </div>
      : null}
    </div>
  )
}
