import type { Extension, Transaction } from "@codemirror/state"

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { lintGutter } from "@codemirror/lint"
import { searchKeymap } from "@codemirror/search"
import { Annotation, Compartment, EditorState } from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"

export type CodeDocumentLanguage = "json" | "text"

interface CodeDocumentAriaTarget {
  removeAttribute: (name: string) => void
  setAttribute: (name: string, value: string) => void
}

export const codeDocumentExternalSync = Annotation.define<boolean>()

export interface CodeDocumentCompartments {
  editable: Compartment
  language: Compartment
  readOnly: Compartment
  wrap: Compartment
}

export interface CreateCodeDocumentStateOptions {
  doc: string
  language: CodeDocumentLanguage
  onChange?: (value: string) => void
  readOnly: boolean
  wrap: boolean
}

export function createCodeDocumentCompartments(): CodeDocumentCompartments {
  return {
    editable: new Compartment(),
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
    history(),
    lintGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    highlightActiveLine(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
    ]),
    compartments.editable.of(EditorView.editable.of(!options.readOnly)),
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
