import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/Stack"
import { useRef } from "react"

import type { CodeDocumentLanguage } from "../lib/code-mirror-document"
import type { CodeMirrorDocumentHandle } from "./CodeMirrorDocument"

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
  const documentRef = useRef<CodeMirrorDocumentHandle>(null)

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
        <HStack gap={1} wrap="wrap">
          <Button
            label={`Find in ${label}`}
            variant="ghost"
            size="sm"
            onClick={() => documentRef.current?.find()}
          />
          <Button
            label={`Copy ${label}`}
            variant="ghost"
            size="sm"
            icon={<CopyIcon />}
            onClick={() => void copyDocument()}
          />
        </HStack>
      </HStack>
      <CodeMirrorDocument
        ref={documentRef}
        ariaLabel={label}
        language={language}
        readOnly
        value={value}
        wrap={wrap}
      />
    </div>
  )
}
