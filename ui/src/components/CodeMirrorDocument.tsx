import { setDiagnostics } from "@codemirror/lint"
import { openSearchPanel } from "@codemirror/search"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"

import type {
  CodeDocumentCompartments,
  CodeDocumentLanguage,
} from "../lib/code-mirror-document"

import {
  codeDocumentContentAttributes,
  codeDocumentExternalSyncAnnotations,
  codeDocumentHistoryExtension,
  codeDocumentLanguageExtension,
  codeDocumentWrapExtension,
  createCodeDocumentCompartments,
  createCodeDocumentState,
  syncCodeDocumentAriaAttributes,
} from "../lib/code-mirror-document"

export interface CodeMirrorDocumentDiagnostic {
  from: number
  message: string
  to: number
}

export interface CodeMirrorDocumentHandle {
  find: () => void
  focus: () => void
}

interface CodeMirrorDocumentProps {
  ariaDescribedBy?: string
  ariaLabel: string
  className?: string
  diagnostics?: ReadonlyArray<CodeMirrorDocumentDiagnostic>
  language: CodeDocumentLanguage
  onChange?: (value: string) => void
  readOnly: boolean
  value: string
  wrap: boolean
}

interface InitialCodeMirrorOptions {
  language: CodeDocumentLanguage
  readOnly: boolean
  value: string
  wrap: boolean
}

const NO_DIAGNOSTICS: ReadonlyArray<CodeMirrorDocumentDiagnostic> = []

function clampOffset(offset: number, length: number): number {
  return Math.min(Math.max(offset, 0), length)
}

// eslint-disable-next-line @eslint-react/no-forward-ref -- The public component API intentionally supports forwarded refs.
export const CodeMirrorDocument = forwardRef<
  CodeMirrorDocumentHandle,
  CodeMirrorDocumentProps
>(function CodeMirrorDocument(
  {
    ariaDescribedBy,
    ariaLabel,
    className,
    diagnostics = NO_DIAGNOSTICS,
    language,
    onChange,
    readOnly,
    value,
    wrap,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const documentValueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const initialOptionsRef = useRef<InitialCodeMirrorOptions>({
    language,
    readOnly,
    value,
    wrap,
  })
  const compartmentsRef = useRef<CodeDocumentCompartments>(
    createCodeDocumentCompartments(),
  )

  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = initialOptionsRef.current
    const view = new EditorView({
      parent: host,
      state: createCodeDocumentState(
        {
          doc: initial.value,
          language: initial.language,
          onChange: (nextValue) => {
            documentValueRef.current = nextValue
            onChangeRef.current?.(nextValue)
          },
          readOnly: initial.readOnly,
          wrap: initial.wrap,
        },
        compartmentsRef.current,
      ),
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    syncCodeDocumentAriaAttributes(view.contentDOM, ariaLabel, ariaDescribedBy)
  }, [ariaDescribedBy, ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (!view || documentValueRef.current === value) return

    view.dispatch({
      annotations: codeDocumentExternalSyncAnnotations(),
      changes: { from: 0, insert: value, to: view.state.doc.length },
    })
    documentValueRef.current = value
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const compartments = compartmentsRef.current

    view.dispatch({
      effects: [
        compartments.contentAttributes.reconfigure(
          codeDocumentContentAttributes(readOnly),
        ),
        compartments.editable.reconfigure(EditorView.editable.of(!readOnly)),
        compartments.history.reconfigure(
          codeDocumentHistoryExtension(readOnly),
        ),
        compartments.language.reconfigure(
          codeDocumentLanguageExtension(language),
        ),
        compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
        compartments.wrap.reconfigure(codeDocumentWrapExtension(wrap)),
      ],
    })
  }, [language, readOnly, wrap])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const documentLength = view.state.doc.length
    const editorDiagnostics = diagnostics.map((diagnostic) => {
      const from = clampOffset(diagnostic.from, documentLength)
      const to = Math.max(from, clampOffset(diagnostic.to, documentLength))
      return {
        from,
        message: diagnostic.message,
        severity: "error" as const,
        to,
      }
    })

    view.dispatch(setDiagnostics(view.state, editorDiagnostics))
  }, [diagnostics, value])

  useImperativeHandle(
    ref,
    () => ({
      find: () => {
        const view = viewRef.current
        if (view) openSearchPanel(view)
      },
      focus: () => viewRef.current?.focus(),
    }),
    [],
  )

  const classes = [
    "code-document",
    readOnly ? "is-read-only" : "is-editable",
    className,
  ]
    .filter(Boolean)
    .join(" ")

  return <div ref={hostRef} className={classes} />
})
