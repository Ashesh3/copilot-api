import { forwardRef, useId } from "react"

import type { JsonDocumentDiagnostic } from "../lib/json-document"
import type { CodeMirrorDocumentHandle } from "./CodeMirrorDocument"

import { CodeMirrorDocument } from "./CodeMirrorDocument"

interface JsonCodeEditorProps {
  diagnostic: JsonDocumentDiagnostic | null
  label: string
  onChange: (value: string) => void
  value: string
  wrap: boolean
}

function clampOffset(offset: number, length: number): number {
  return Math.min(Math.max(offset, 0), length)
}

// eslint-disable-next-line @eslint-react/no-forward-ref -- The public component API intentionally supports forwarded refs.
export const JsonCodeEditor = forwardRef<
  CodeMirrorDocumentHandle,
  JsonCodeEditorProps
>(function JsonCodeEditor({ diagnostic, label, onChange, value, wrap }, ref) {
  const diagnosticId = useId()
  const from = diagnostic ? clampOffset(diagnostic.from, value.length) : 0
  const diagnostics =
    diagnostic ?
      [
        {
          from,
          message: diagnostic.message,
          to: Math.max(from, clampOffset(diagnostic.to, value.length)),
        },
      ]
    : []

  return (
    <div className="json-code-editor">
      <div className="code-document-label">{label}</div>
      <CodeMirrorDocument
        ref={ref}
        ariaDescribedBy={diagnosticId}
        ariaLabel={label}
        diagnostics={diagnostics}
        language="json"
        readOnly={false}
        value={value}
        wrap={wrap}
        onChange={onChange}
      />
      <div
        id={diagnosticId}
        role="status"
        aria-live="polite"
        className={`json-code-diagnostic${diagnostic ? " is-visible" : ""}`}
      >
        {diagnostic ? diagnostic.message : "Valid JSON"}
      </div>
    </div>
  )
})
