import { expect, test } from "bun:test"

import { highlightingFor } from "../ui/node_modules/@codemirror/language"
import { EditorView } from "../ui/node_modules/@codemirror/view"
import { tags } from "../ui/node_modules/@lezer/highlight"
import {
  codeDocumentAddToHistory,
  codeDocumentCspNonce,
  codeDocumentExternalSyncAnnotations,
  codeDocumentHighlightStyle,
  createCodeDocumentCompartments,
  createCodeDocumentState,
  isCodeDocumentExternalSync,
  shouldNotifyCodeDocumentChange,
  syncCodeDocumentAriaAttributes,
} from "../ui/src/lib/code-mirror-document"

test("passes the dashboard CSP nonce to CodeMirror styles", () => {
  const cspNonce = codeDocumentCspNonce({
    querySelector: () => ({
      getAttribute: () => null,
      nonce: "dashboard-nonce",
    }),
  })
  const state = createCodeDocumentState({
    cspNonce,
    doc: "response body",
    language: "text",
    readOnly: true,
    wrap: false,
  })

  expect(cspNonce).toBe("dashboard-nonce")
  expect(state.facet(EditorView.cspNonce)).toBe("dashboard-nonce")
})

test("reads the CSP nonce attribute when the DOM property is unavailable", () => {
  expect(
    codeDocumentCspNonce({
      querySelector: () => ({
        getAttribute: (name) => (name === "nonce" ? "attribute-nonce" : null),
      }),
    }),
  ).toBe("attribute-nonce")
  expect(codeDocumentCspNonce({ querySelector: () => null })).toBe("")
})

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

test("makes read-only documents focusable without retaining edit history", () => {
  const compartments = createCodeDocumentCompartments()
  const state = createCodeDocumentState(
    {
      doc: "response body",
      language: "text",
      readOnly: true,
      wrap: false,
    },
    compartments,
  )
  const hasTabIndex = state
    .facet(EditorView.contentAttributes)
    .some(
      (attributes) =>
        typeof attributes !== "function" && attributes.tabindex === "0",
    )

  expect(hasTabIndex).toBe(true)
  expect(compartments.history.get(state)).toEqual([])
})

test("keeps editable documents in normal tab flow with edit history", () => {
  const compartments = createCodeDocumentCompartments()
  const state = createCodeDocumentState(
    {
      doc: "request body",
      language: "text",
      readOnly: false,
      wrap: false,
    },
    compartments,
  )
  const hasForcedTabIndex = state
    .facet(EditorView.contentAttributes)
    .some(
      (attributes) =>
        typeof attributes !== "function" && attributes.tabindex === "0",
    )

  expect(hasForcedTabIndex).toBe(false)
  expect(compartments.history.get(state)).not.toEqual([])
})

test("identifies controlled document synchronization transactions", () => {
  const state = createCodeDocumentState({
    doc: "before",
    language: "text",
    readOnly: false,
    wrap: false,
  })
  const transaction = state.update({
    annotations: codeDocumentExternalSyncAnnotations(),
    changes: { from: 0, insert: "after", to: state.doc.length },
  })

  expect(isCodeDocumentExternalSync(transaction)).toBe(true)
  expect(transaction.annotation(codeDocumentAddToHistory)).toBe(false)
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

test("uses theme syntax tokens for JSON highlighting", () => {
  const state = createCodeDocumentState({
    doc: '{"model":"gpt-test","count":2}',
    language: "json",
    readOnly: true,
    wrap: false,
  })

  expect(highlightingFor(state, [tags.propertyName])).not.toBeNull()
  expect(highlightingFor(state, [tags.string])).not.toBeNull()
  expect(highlightingFor(state, [tags.number])).not.toBeNull()
  expect(codeDocumentHighlightStyle.style(tags.propertyName.set)).not.toBeNull()
  expect(codeDocumentHighlightStyle.specs[0]?.color).toBe(
    "var(--color-syntax-property)",
  )
  expect(codeDocumentHighlightStyle.specs[1]?.color).toBe(
    "var(--color-syntax-string)",
  )
  expect(codeDocumentHighlightStyle.specs[2]?.color).toBe(
    "var(--color-syntax-number)",
  )
})
