import { expect, test } from "bun:test"

import { EditorView } from "../ui/node_modules/@codemirror/view"
import {
  codeDocumentExternalSync,
  createCodeDocumentState,
  isCodeDocumentExternalSync,
  shouldNotifyCodeDocumentChange,
  syncCodeDocumentAriaAttributes,
} from "../ui/src/lib/code-mirror-document"

test("creates a wrapped read-only JSON document state", () => {
  const document = '{"model":"gpt-test"}'
  const state = createCodeDocumentState({
    doc: document,
    language: "json",
    readOnly: true,
    wrap: true,
  })

  expect(state.doc.toString()).toBe(document)
  expect(state.readOnly).toBe(true)
  expect(state.facet(EditorView.editable)).toBe(false)
})

test("identifies controlled document synchronization transactions", () => {
  const state = createCodeDocumentState({
    doc: "before",
    language: "text",
    readOnly: false,
    wrap: false,
  })
  const transaction = state.update({
    annotations: codeDocumentExternalSync.of(true),
    changes: { from: 0, insert: "after", to: state.doc.length },
  })

  expect(isCodeDocumentExternalSync(transaction)).toBe(true)
  expect(shouldNotifyCodeDocumentChange(true, [transaction])).toBe(false)

  const userTransaction = state.update({
    changes: { from: 0, insert: "user edit", to: state.doc.length },
  })
  expect(shouldNotifyCodeDocumentChange(true, [userTransaction])).toBe(true)
})

test("syncs accessible naming attributes on the editor target", () => {
  const attributes = new Map<string, string>()
  attributes.set("contenteditable", "true")
  attributes.set("role", "textbox")
  const target = {
    removeAttribute: (name: string) => attributes.delete(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  }

  syncCodeDocumentAriaAttributes(target, "Replay body", "diagnostic-id")

  expect(attributes.get("aria-label")).toBe("Replay body")
  expect(attributes.get("aria-describedby")).toBe("diagnostic-id")
  expect(attributes.get("contenteditable")).toBe("true")
  expect(attributes.get("role")).toBe("textbox")

  syncCodeDocumentAriaAttributes(target, "Replay body", undefined)
  expect(attributes.has("aria-describedby")).toBe(false)
})
