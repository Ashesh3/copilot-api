import type { Extension } from "@codemirror/state"

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { lintGutter } from "@codemirror/lint"
import { searchKeymap } from "@codemirror/search"
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { tags } from "@lezer/highlight"

export type CodeDocumentLanguage = "json" | "text"

interface CodeDocumentAriaTarget {
  removeAttribute: (name: string) => void
  setAttribute: (name: string, value: string) => void
}

interface CodeDocumentNonceElement {
  getAttribute: (name: string) => string | null
  nonce?: string
}

interface CodeDocumentNonceDocument {
  querySelector: (selector: string) => CodeDocumentNonceElement | null
}

export const codeDocumentExternalSync = Annotation.define<boolean>()
export const codeDocumentAddToHistory = Transaction.addToHistory

export const codeDocumentHighlightStyle = HighlightStyle.define([
  { color: "var(--color-syntax-property)", tag: tags.propertyName },
  { color: "var(--color-syntax-string)", tag: tags.string },
  { color: "var(--color-syntax-number)", tag: tags.number },
  { color: "var(--color-syntax-keyword)", tag: tags.keyword },
  { color: "var(--color-syntax-comment)", tag: tags.comment },
  {
    color: "var(--color-syntax-punctuation)",
    tag: [tags.punctuation, tags.separator, tags.operator],
  },
  { color: "var(--color-syntax-variable)", tag: tags.variableName },
  { color: "var(--color-syntax-constant)", tag: [tags.bool, tags.null] },
])

const codeDocumentTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-syntax-background)",
    color: "var(--color-text-primary)",
    colorScheme: "inherit",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--color-accent-muted)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--color-accent-muted)",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "var(--color-error-muted)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--color-overlay-hover)",
  },
  ".cm-button": { backgroundImage: "none" },
  ".cm-content": { caretColor: "var(--color-text-primary)" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-text-primary)",
  },
  ".cm-diagnostic-error": { borderLeftColor: "var(--color-error)" },
  ".cm-diagnostic-hint, .cm-diagnostic-info": {
    borderLeftColor: "var(--color-text-secondary)",
  },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--color-warning)" },
  ".cm-diagnosticAction": {
    backgroundColor: "var(--color-accent-muted)",
    color: "var(--color-text-primary)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-syntax-background)",
    borderColor: "var(--color-border)",
    color: "var(--color-text-secondary)",
  },
  ".cm-lintPoint:after": { borderBottomColor: "var(--color-error)" },
  ".cm-lintPoint-hint:after, .cm-lintPoint-info:after": {
    borderBottomColor: "var(--color-text-secondary)",
  },
  ".cm-lintPoint-warning:after": {
    borderBottomColor: "var(--color-warning)",
  },
  ".cm-lintRange": {
    backgroundImage: "none",
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textUnderlineOffset: "2px",
  },
  ".cm-lintRange-active": {
    backgroundColor: "var(--color-warning-muted)",
  },
  ".cm-lintRange-error": { textDecorationColor: "var(--color-error)" },
  ".cm-lintRange-hint, .cm-lintRange-info": {
    textDecorationColor: "var(--color-text-secondary)",
  },
  ".cm-lintRange-warning": {
    textDecorationColor: "var(--color-warning)",
  },
  ".cm-panel.cm-panel-lint ul [aria-selected]": {
    backgroundColor: "var(--color-accent-muted)",
    color: "var(--color-text-primary)",
  },
  ".cm-panels": {
    backgroundColor: "var(--color-background-body)",
    color: "var(--color-text-primary)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--color-accent-muted)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--color-warning-muted)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--color-accent-muted)" },
  ".cm-specialChar": { color: "var(--color-error)" },
  ".cm-textfield, .cm-button": {
    backgroundColor: "var(--color-syntax-background)",
    borderColor: "var(--color-border)",
    color: "var(--color-text-primary)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--color-background-popover)",
    borderColor: "var(--color-border)",
    color: "var(--color-text-primary)",
  },
})

export interface CodeDocumentCompartments {
  contentAttributes: Compartment
  editable: Compartment
  history: Compartment
  language: Compartment
  readOnly: Compartment
  wrap: Compartment
}

export interface CreateCodeDocumentStateOptions {
  cspNonce?: string
  doc: string
  language: CodeDocumentLanguage
  onChange?: (value: string) => void
  readOnly: boolean
  wrap: boolean
}

export function codeDocumentCspNonce(
  documentRoot?: CodeDocumentNonceDocument,
): string {
  const script = documentRoot?.querySelector("script[nonce]")
  return script?.nonce ?? script?.getAttribute("nonce") ?? ""
}

export function createCodeDocumentCompartments(): CodeDocumentCompartments {
  return {
    contentAttributes: new Compartment(),
    editable: new Compartment(),
    history: new Compartment(),
    language: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
  }
}

export function codeDocumentLanguageExtension(
  language: CodeDocumentLanguage,
): Extension {
  return language === "json" ? json() : []
}

export function codeDocumentWrapExtension(wrap: boolean): Extension {
  return wrap ? EditorView.lineWrapping : []
}

export function codeDocumentContentAttributes(readOnly: boolean): Extension {
  return EditorView.contentAttributes.of(readOnly ? { tabindex: "0" } : {})
}

export function codeDocumentHistoryExtension(readOnly: boolean): Extension {
  return readOnly ? [] : [history(), keymap.of(historyKeymap)]
}

export function codeDocumentExternalSyncAnnotations(): ReadonlyArray<
  Annotation<unknown>
> {
  return [codeDocumentExternalSync.of(true), codeDocumentAddToHistory.of(false)]
}

export function isCodeDocumentExternalSync(transaction: Transaction): boolean {
  return transaction.annotation(codeDocumentExternalSync) === true
}

export function shouldNotifyCodeDocumentChange(
  docChanged: boolean,
  transactions: ReadonlyArray<Transaction>,
): boolean {
  return (
    docChanged
    && !transactions.some((transaction) =>
      isCodeDocumentExternalSync(transaction),
    )
  )
}

export function syncCodeDocumentAriaAttributes(
  target: CodeDocumentAriaTarget,
  ariaLabel: string,
  ariaDescribedBy: string | undefined,
): void {
  target.setAttribute("aria-label", ariaLabel)
  if (ariaDescribedBy) {
    target.setAttribute("aria-describedby", ariaDescribedBy)
  } else {
    target.removeAttribute("aria-describedby")
  }
}

export function createCodeDocumentState(
  options: CreateCodeDocumentStateOptions,
  compartments = createCodeDocumentCompartments(),
): EditorState {
  const extensions: Array<Extension> = [
    lineNumbers(),
    highlightActiveLineGutter(),
    lintGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.cspNonce.of(options.cspNonce ?? ""),
    codeDocumentTheme,
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(codeDocumentHighlightStyle, { fallback: true }),
    highlightActiveLine(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap]),
    compartments.contentAttributes.of(
      codeDocumentContentAttributes(options.readOnly),
    ),
    compartments.editable.of(EditorView.editable.of(!options.readOnly)),
    compartments.history.of(codeDocumentHistoryExtension(options.readOnly)),
    compartments.language.of(codeDocumentLanguageExtension(options.language)),
    compartments.readOnly.of(EditorState.readOnly.of(options.readOnly)),
    compartments.wrap.of(codeDocumentWrapExtension(options.wrap)),
  ]

  if (options.onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (
          shouldNotifyCodeDocumentChange(update.docChanged, update.transactions)
        ) {
          options.onChange?.(update.state.doc.toString())
        }
      }),
    )
  }

  return EditorState.create({ doc: options.doc, extensions })
}
