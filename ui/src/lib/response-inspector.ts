import type { CodeDocumentLanguage } from "./code-mirror-document"

export type ResponseInspectorTab = "output" | "details" | "events" | "raw"

export interface ResponseInspectorViewState {
  responseId: string
  selectedEvent: number
  tab: ResponseInspectorTab
}

export function initialResponseInspectorViewState(
  responseId: string,
): ResponseInspectorViewState {
  return { responseId, selectedEvent: 0, tab: "output" }
}

export function responseInspectorViewState(
  state: ResponseInspectorViewState,
  responseId: string,
): ResponseInspectorViewState {
  return state.responseId === responseId ?
      state
    : initialResponseInspectorViewState(responseId)
}

export function metadataItemKey(
  source: string,
  label: string,
  index: number,
): string {
  return `${source}:${index}:${label}`
}

function contentType(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return value.toLowerCase()
  }
  return null
}

export function responseBodyLanguage(
  body: string,
  headers: Record<string, string>,
): CodeDocumentLanguage {
  const type = contentType(headers)
  if (type?.includes("/json") || type?.includes("+json")) return "json"

  const first = body.trimStart()[0]
  return first === "{" || first === "[" ? "json" : "text"
}
