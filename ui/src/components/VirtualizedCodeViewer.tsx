import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/Stack"

import type { CodeDocumentLanguage } from "../lib/code-mirror-document"

import { CopyIcon } from "../icons"
import { jsonCopyErrorMessage } from "../lib/json-tree"
import { CodeMirrorDocument } from "./CodeMirrorDocument"

interface VirtualizedCodeViewerProps {
  label: string
  language: CodeDocumentLanguage
  value: string
  wrap: boolean
  onCopyError: (message: string) => void
  onCopySuccess: () => void
}

export function VirtualizedCodeViewer({
  label,
  language,
  value,
  wrap,
  onCopyError,
  onCopySuccess,
}: VirtualizedCodeViewerProps) {
  async function copyDocument(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      onCopySuccess()
    } catch (error) {
      onCopyError(jsonCopyErrorMessage(error))
    }
  }

  return (
    <div className="virtualized-code-viewer">
      <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
        <div className="code-document-label">{label}</div>
        <Button
          label="Copy"
          variant="ghost"
          size="sm"
          icon={<CopyIcon />}
          onClick={() => void copyDocument()}
        />
      </HStack>
      <CodeMirrorDocument
        ariaLabel={label}
        language={language}
        readOnly
        value={value}
        wrap={wrap}
      />
    </div>
  )
}
