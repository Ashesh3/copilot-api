import type { HttpResponseExportSource } from "./http-export"
import type { ParsedResponsesBody } from "./responses-body"

import {
  buildAssistantOutputMarkdown,
  buildRawHttpResponse,
  buildResponseJson,
  exportErrorMessage,
} from "./http-export"
import { responseBodyLanguage } from "./response-inspector"

export interface ResponseExportSource {
  parsed: ParsedResponsesBody | null
  response?: HttpResponseExportSource
}

interface ResponseExportBuilders {
  buildAssistantOutputMarkdown: typeof buildAssistantOutputMarkdown
  buildRawHttpResponse: typeof buildRawHttpResponse
  buildResponseJson: typeof buildResponseJson
}

export interface ResponseExportAvailability {
  assistantOutput: boolean
  rawHttpResponse: boolean
  responseJson: boolean
}

export type ResponseExportExecutionResult =
  | { status: "success" }
  | { message: string; status: "error" }

export interface ResponseExportExecution {
  build: () => string | null
  download: (contents: string) => void
  emptyMessage: string
  onError: (message: string) => void
}

const defaultBuilders: ResponseExportBuilders = {
  buildAssistantOutputMarkdown,
  buildRawHttpResponse,
  buildResponseJson,
}

function hasJsonCandidate(response: HttpResponseExportSource): boolean {
  const body = response.body?.trimStart()
  if (!body) return false
  if (responseBodyLanguage(body, response.headers) === "json") return true
  return (
    body.startsWith('"')
    || /^(?:true|false|null)(?:\s|$)/.test(body)
    || /^-?\d/.test(body)
  )
}

export function responseExportAvailability({
  parsed,
  response,
}: ResponseExportSource): ResponseExportAvailability {
  return {
    assistantOutput:
      parsed !== null
      && (parsed.assistantText.length > 0 || parsed.toolCalls.length > 0),
    rawHttpResponse: response !== undefined,
    responseJson:
      parsed !== null || (response !== undefined && hasJsonCandidate(response)),
  }
}

export function createResponseExportActions(
  { parsed, response }: ResponseExportSource,
  builders: ResponseExportBuilders = defaultBuilders,
) {
  return {
    buildAssistantOutput: () => builders.buildAssistantOutputMarkdown(parsed),
    buildRawHttpResponse: () =>
      response ? builders.buildRawHttpResponse(response) : null,
    buildResponseJson: () => builders.buildResponseJson(response, parsed),
  }
}

export function executeResponseExport({
  build,
  download,
  emptyMessage,
  onError,
}: ResponseExportExecution): ResponseExportExecutionResult {
  try {
    const contents = build()
    if (contents === null) throw new Error(emptyMessage)
    download(contents)
    return { status: "success" }
  } catch (error) {
    const message = exportErrorMessage(error)
    onError(message)
    return { message, status: "error" }
  }
}
