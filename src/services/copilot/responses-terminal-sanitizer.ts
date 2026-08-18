import type { ServerSentEventMessage } from "fetch-event-stream"

export const SAFE_RESPONSES_STREAM_ERROR_MESSAGE =
  "Upstream Responses stream failed."

const SAFE_ERROR_CODES = new Set([
  "content_filter",
  "internal_error",
  "invalid_request_body",
  "invalid_request_error",
  "model_error",
  "overloaded_error",
  "rate_limit_exceeded",
  "rate_limited",
  "server_error",
  "service_unavailable",
  "timeout",
  "upstream_error",
])
const SAFE_ERROR_PARAMS = new Set([
  "background",
  "body",
  "input",
  "max_output_tokens",
  "model",
  "previous_response_id",
  "reasoning",
  "service_tier",
  "store",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
])
const TERMINAL_EVENT_TYPES = new Set([
  "error",
  "response.completed",
  "response.failed",
  "response.incomplete",
])
const SAFE_OBJECT = "response"
const SAFE_STATUSES = new Set([
  "completed",
  "failed",
  "in_progress",
  "incomplete",
])
const SAFE_OUTPUT_STATUSES = new Set([
  "calling",
  "completed",
  "failed",
  "in_progress",
  "incomplete",
  "searching",
])
const SAFE_COMPUTER_BUTTONS = new Set([
  "back",
  "forward",
  "left",
  "right",
  "wheel",
])
const SAFE_INCOMPLETE_REASONS = new Set(["content_filter", "max_output_tokens"])
const REQUIRED_COMPLETED_FIELDS = [
  "error",
  "id",
  "incomplete_details",
  "object",
  "output",
  "output_text",
  "status",
  "usage",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ?
      value
    : undefined
}

function safeStringArray(value: unknown): Array<string> | undefined {
  return Array.isArray(value) ?
      value.filter((item) => typeof item === "string")
    : undefined
}

function sequenceNumber(value: unknown): number {
  return nonNegativeInteger(value) ?? 0
}

function safeErrorParam(value: unknown): string | null {
  if (value === null) return null
  return typeof value === "string" && SAFE_ERROR_PARAMS.has(value) ?
      value
    : null
}

function safeError(value: unknown): Record<string, unknown> {
  const code = readRecordValue(value, "code")
  const param = readRecordValue(value, "param")
  const status = readRecordValue(value, "status")
  return {
    code:
      typeof code === "string" && SAFE_ERROR_CODES.has(code) ?
        code
      : "server_error",
    message: SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
    param: safeErrorParam(param),
    status:
      (
        typeof status === "number"
        && Number.isInteger(status)
        && status >= 400
        && status <= 599
      ) ?
        status
      : 502,
  }
}

function safeUsage(value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  const inputTokens = nonNegativeInteger(readRecordValue(value, "input_tokens"))
  const outputTokens = nonNegativeInteger(
    readRecordValue(value, "output_tokens"),
  )
  const totalTokens = nonNegativeInteger(readRecordValue(value, "total_tokens"))
  if (inputTokens === undefined || totalTokens === undefined) return null
  const cachedTokens = nonNegativeInteger(
    readRecordValue(
      readRecordValue(value, "input_tokens_details"),
      "cached_tokens",
    ),
  )
  const reasoningTokens = nonNegativeInteger(
    readRecordValue(
      readRecordValue(value, "output_tokens_details"),
      "reasoning_tokens",
    ),
  )
  return {
    input_tokens: inputTokens,
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    total_tokens: totalTokens,
    ...(cachedTokens === undefined ?
      {}
    : { input_tokens_details: { cached_tokens: cachedTokens } }),
    ...(reasoningTokens === undefined ?
      {}
    : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
  }
}

function safeAnnotation(value: unknown): Record<string, unknown> | undefined {
  const type = readRecordValue(value, "type")
  if (
    type !== "container_file_citation"
    && type !== "file_citation"
    && type !== "file_path"
    && type !== "url_citation"
  ) {
    return undefined
  }
  const annotation: Record<string, unknown> = { type }
  for (const key of ["container_id", "file_id", "filename", "title", "url"]) {
    const field = nonEmptyString(readRecordValue(value, key))
    if (field !== undefined) annotation[key] = field
  }
  for (const key of ["end_index", "index", "start_index"]) {
    const field = nonNegativeInteger(readRecordValue(value, key))
    if (field !== undefined) annotation[key] = field
  }
  return annotation
}

function safeContent(value: unknown): Record<string, unknown> | undefined {
  const type = readRecordValue(value, "type")
  if (type === "output_text") {
    const outputText = text(readRecordValue(value, "text"))
    if (outputText === undefined) return undefined
    const annotations = readRecordValue(value, "annotations")
    return {
      type,
      text: outputText,
      annotations:
        Array.isArray(annotations) ?
          annotations.flatMap((annotation) => {
            const sanitized = safeAnnotation(annotation)
            return sanitized ? [sanitized] : []
          })
        : [],
    }
  }
  if (type === "refusal") {
    const refusal = text(readRecordValue(value, "refusal"))
    return refusal === undefined ? undefined : { type, refusal }
  }
  return undefined
}

function safeReasoningBlock(
  value: unknown,
  expectedType: "reasoning_text" | "summary_text",
): Record<string, unknown> | undefined {
  if (readRecordValue(value, "type") !== expectedType) return undefined
  const blockText = text(readRecordValue(value, "text"))
  return blockText === undefined ? undefined : (
      { type: expectedType, text: blockText }
    )
}

function commonOutputFields(
  value: unknown,
  type: string,
): Record<string, unknown> {
  const id = nonEmptyString(readRecordValue(value, "id"))
  const status = readRecordValue(value, "status")
  const outputIndex = nonNegativeInteger(readRecordValue(value, "output_index"))
  return {
    type,
    ...(id === undefined ? {} : { id }),
    ...(typeof status === "string" && SAFE_OUTPUT_STATUSES.has(status) ?
      { status }
    : {}),
    ...(outputIndex === undefined ? {} : { output_index: outputIndex }),
  }
}

function safeMessage(value: unknown): Record<string, unknown> {
  const role = readRecordValue(value, "role")
  const content = readRecordValue(value, "content")
  return {
    ...commonOutputFields(value, "message"),
    ...(role === "assistant" ? { role } : {}),
    ...(Array.isArray(content) ?
      {
        content: content.flatMap((block) => {
          const sanitized = safeContent(block)
          return sanitized ? [sanitized] : []
        }),
      }
    : {}),
  }
}

function safeReasoning(value: unknown): Record<string, unknown> {
  const summary = readRecordValue(value, "summary")
  const content = readRecordValue(value, "content")
  const encryptedContent = text(readRecordValue(value, "encrypted_content"))
  return {
    ...commonOutputFields(value, "reasoning"),
    ...(Array.isArray(summary) ?
      {
        summary: summary.flatMap((block) => {
          const sanitized = safeReasoningBlock(block, "summary_text")
          return sanitized ? [sanitized] : []
        }),
      }
    : {}),
    ...(Array.isArray(content) ?
      {
        content: content.flatMap((block) => {
          const sanitized = safeReasoningBlock(block, "reasoning_text")
          return sanitized ? [sanitized] : []
        }),
      }
    : {}),
    ...(encryptedContent === undefined ?
      {}
    : { encrypted_content: encryptedContent }),
  }
}

function safeFunctionCall(value: unknown): Record<string, unknown> | undefined {
  const callId = nonEmptyString(readRecordValue(value, "call_id"))
  const name = nonEmptyString(readRecordValue(value, "name"))
  const argumentsValue = text(readRecordValue(value, "arguments"))
  if (
    callId === undefined
    || name === undefined
    || argumentsValue === undefined
  ) {
    return undefined
  }
  return {
    ...commonOutputFields(value, "function_call"),
    call_id: callId,
    name,
    arguments: argumentsValue,
  }
}

function safeComputerKeys(value: unknown): Array<string> | null | undefined {
  if (value === null) return null
  return safeStringArray(value)
}

function safeComputerPointAction(
  value: unknown,
  type: "double_click" | "move",
): Record<string, unknown> | undefined {
  const x = safeInteger(readRecordValue(value, "x"))
  const y = safeInteger(readRecordValue(value, "y"))
  if (x === undefined || y === undefined) return undefined
  const keys = safeComputerKeys(readRecordValue(value, "keys"))
  return { type, x, y, ...(keys === undefined ? {} : { keys }) }
}

function safeComputerClick(
  value: unknown,
): Record<string, unknown> | undefined {
  const button = readRecordValue(value, "button")
  const point = safeComputerPointAction(value, "move")
  if (
    typeof button !== "string"
    || !SAFE_COMPUTER_BUTTONS.has(button)
    || !point
  ) {
    return undefined
  }
  const { type: _type, ...position } = point
  return { type: "click", button, ...position }
}

function safeComputerScroll(
  value: unknown,
): Record<string, unknown> | undefined {
  const point = safeComputerPointAction(value, "move")
  const scrollX = safeInteger(readRecordValue(value, "scroll_x"))
  const scrollY = safeInteger(readRecordValue(value, "scroll_y"))
  if (!point || scrollX === undefined || scrollY === undefined) return undefined
  const { type: _type, ...position } = point
  return { type: "scroll", ...position, scroll_x: scrollX, scroll_y: scrollY }
}

function safeComputerDrag(value: unknown): Record<string, unknown> | undefined {
  const path = readRecordValue(value, "path")
  if (!Array.isArray(path)) return undefined
  const safePath = path.flatMap((point) => {
    const pointX = safeInteger(readRecordValue(point, "x"))
    const pointY = safeInteger(readRecordValue(point, "y"))
    return pointX === undefined || pointY === undefined ?
        []
      : [{ x: pointX, y: pointY }]
  })
  const keys = safeComputerKeys(readRecordValue(value, "keys"))
  return {
    type: "drag",
    path: safePath,
    ...(keys === undefined ? {} : { keys }),
  }
}

function safeComputerAction(
  value: unknown,
): Record<string, unknown> | undefined {
  const type = readRecordValue(value, "type")
  if (type === "screenshot" || type === "wait") return { type }
  if (type === "keypress") {
    const actionKeys = safeStringArray(readRecordValue(value, "keys"))
    return actionKeys === undefined ? undefined : { type, keys: actionKeys }
  }
  if (type === "type") {
    const actionText = text(readRecordValue(value, "text"))
    return actionText === undefined ? undefined : { type, text: actionText }
  }
  if (type === "click") return safeComputerClick(value)
  if (type === "double_click" || type === "move") {
    return safeComputerPointAction(value, type)
  }
  if (type === "scroll") return safeComputerScroll(value)
  if (type === "drag") return safeComputerDrag(value)
  return undefined
}

function safeComputerCall(value: unknown): Record<string, unknown> {
  const callId = nonEmptyString(readRecordValue(value, "call_id"))
  const action = safeComputerAction(readRecordValue(value, "action"))
  const actions = readRecordValue(value, "actions")
  return {
    ...commonOutputFields(value, "computer_call"),
    ...(callId === undefined ? {} : { call_id: callId }),
    ...(action === undefined ? {} : { action }),
    ...(Array.isArray(actions) ?
      {
        actions: actions.flatMap((item) => {
          const sanitized = safeComputerAction(item)
          return sanitized ? [sanitized] : []
        }),
      }
    : {}),
  }
}

function safeCustomToolCall(
  value: unknown,
): Record<string, unknown> | undefined {
  const callId = nonEmptyString(readRecordValue(value, "call_id"))
  const name = nonEmptyString(readRecordValue(value, "name"))
  const input = text(readRecordValue(value, "input"))
  if (callId === undefined || name === undefined || input === undefined) {
    return undefined
  }
  const namespace = nonEmptyString(readRecordValue(value, "namespace"))
  return {
    ...commonOutputFields(value, "custom_tool_call"),
    call_id: callId,
    name,
    input,
    ...(namespace === undefined ? {} : { namespace }),
  }
}

function safeFileSearchResult(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const key of ["file_id", "filename", "text"]) {
    const field = text(readRecordValue(value, key))
    if (field !== undefined) result[key] = field
  }
  const score = readRecordValue(value, "score")
  if (typeof score === "number" && Number.isFinite(score)) result.score = score
  return result
}

function safeFileSearchCall(
  value: unknown,
): Record<string, unknown> | undefined {
  const queries = safeStringArray(readRecordValue(value, "queries"))
  if (queries === undefined) return undefined
  const results = readRecordValue(value, "results")
  let safeResults: Array<Record<string, unknown>> | null | undefined
  if (results === null) {
    safeResults = null
  } else if (Array.isArray(results)) {
    safeResults = results.flatMap((result) => {
      const sanitized = safeFileSearchResult(result)
      return sanitized ? [sanitized] : []
    })
  }
  return {
    ...commonOutputFields(value, "file_search_call"),
    queries,
    ...(safeResults === undefined ? {} : { results: safeResults }),
  }
}

function safeMcpCall(value: unknown): Record<string, unknown> | undefined {
  const id = nonEmptyString(readRecordValue(value, "id"))
  const serverLabel = nonEmptyString(readRecordValue(value, "server_label"))
  const name = nonEmptyString(readRecordValue(value, "name"))
  const argumentsValue = text(readRecordValue(value, "arguments"))
  if (
    id === undefined
    || serverLabel === undefined
    || name === undefined
    || argumentsValue === undefined
  ) {
    return undefined
  }
  const callId = nonEmptyString(readRecordValue(value, "call_id"))
  const output = readRecordValue(value, "output")
  const error = readRecordValue(value, "error")
  const approvalRequestId = readRecordValue(value, "approval_request_id")
  return {
    ...commonOutputFields(value, "mcp_call"),
    id,
    ...(callId === undefined ? {} : { call_id: callId }),
    server_label: serverLabel,
    name,
    arguments: argumentsValue,
    ...(typeof output === "string" || output === null ? { output } : {}),
    ...(error === null ? { error: null } : {}),
    ...(typeof approvalRequestId === "string" || approvalRequestId === null ?
      { approval_request_id: approvalRequestId }
    : {}),
  }
}

function safeWebSearchSource(
  value: unknown,
): Record<string, unknown> | undefined {
  if (readRecordValue(value, "type") !== "url") return undefined
  const url = nonEmptyString(readRecordValue(value, "url"))
  return url === undefined ? undefined : { type: "url", url }
}

function safeWebSearchAction(
  value: unknown,
): Record<string, unknown> | undefined {
  const type = readRecordValue(value, "type")
  if (type === "open_page") {
    const url = readRecordValue(value, "url")
    return typeof url === "string" || url === null ? { type, url } : { type }
  }
  if (type === "find_in_page") {
    const url = nonEmptyString(readRecordValue(value, "url"))
    const pattern = text(readRecordValue(value, "pattern"))
    return url === undefined || pattern === undefined ?
        undefined
      : { type, url, pattern }
  }
  if (type === "search") {
    const query = text(readRecordValue(value, "query"))
    const queries = safeStringArray(readRecordValue(value, "queries"))
    const sources = readRecordValue(value, "sources")
    return {
      type,
      ...(query === undefined ? {} : { query }),
      ...(queries === undefined ? {} : { queries }),
      ...(Array.isArray(sources) ?
        {
          sources: sources.flatMap((source) => {
            const sanitized = safeWebSearchSource(source)
            return sanitized ? [sanitized] : []
          }),
        }
      : {}),
    }
  }
  return undefined
}

function safeWebSearchCall(value: unknown): Record<string, unknown> {
  const action = safeWebSearchAction(readRecordValue(value, "action"))
  return {
    ...commonOutputFields(value, "web_search_call"),
    ...(action === undefined ? {} : { action }),
  }
}

function safeOutputItem(value: unknown): Record<string, unknown> | undefined {
  const type = readRecordValue(value, "type")
  if (type === "message") return safeMessage(value)
  if (type === "reasoning") return safeReasoning(value)
  if (type === "function_call") return safeFunctionCall(value)
  if (type === "computer_call") return safeComputerCall(value)
  if (type === "custom_tool_call") return safeCustomToolCall(value)
  if (type === "file_search_call") return safeFileSearchCall(value)
  if (type === "mcp_call") return safeMcpCall(value)
  if (type === "web_search_call") return safeWebSearchCall(value)
  return undefined
}

function safeCompletedOutput(value: unknown): Array<unknown> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const sanitized = safeOutputItem(item)
    return sanitized ? [sanitized] : []
  })
}

function hasRequiredCompletedFields(
  response: Record<string, unknown>,
): boolean {
  return REQUIRED_COMPLETED_FIELDS.every((key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(response, key)
      return descriptor !== undefined && "value" in descriptor
    } catch {
      return false
    }
  })
}

interface CompletedParts {
  readonly id: string
  readonly output: Array<unknown>
  readonly outputText: string
  readonly sequenceNumber: number
  readonly usage: Record<string, unknown> | null
}

function readCompletedParts(
  parsed: unknown,
  response: unknown,
): CompletedParts | undefined {
  if (!isRecord(parsed) || !isRecord(response)) return undefined
  const parsedType = readRecordValue(parsed, "type")
  const sequence = nonNegativeInteger(
    readRecordValue(parsed, "sequence_number"),
  )
  const id = nonEmptyString(readRecordValue(response, "id"))
  const object = readRecordValue(response, "object")
  const status = readRecordValue(response, "status")
  const output = readRecordValue(response, "output")
  const outputText = text(readRecordValue(response, "output_text"))
  if (
    parsedType !== "response.completed"
    || sequence === undefined
    || id === undefined
    || object !== SAFE_OBJECT
    || status !== "completed"
    || !Array.isArray(output)
    || outputText === undefined
    || readRecordValue(response, "error") !== null
    || readRecordValue(response, "incomplete_details") !== null
    || !hasRequiredCompletedFields(response)
  ) {
    return undefined
  }
  const usageValue = readRecordValue(response, "usage")
  const usage = safeUsage(usageValue)
  if (usageValue !== null && usage === null) return undefined
  return {
    id,
    output: safeCompletedOutput(output),
    outputText,
    sequenceNumber: sequence,
    usage,
  }
}

function safeCompletedEvent(
  parsed: unknown,
  response: unknown,
): Record<string, unknown> | undefined {
  const parts = readCompletedParts(parsed, response)
  if (!parts) return undefined
  const createdAt = nonNegativeInteger(readRecordValue(response, "created_at"))
  const model = nonEmptyString(readRecordValue(response, "model"))
  return {
    type: "response.completed",
    sequence_number: parts.sequenceNumber,
    response: {
      id: parts.id,
      object: SAFE_OBJECT,
      ...(createdAt === undefined ? {} : { created_at: createdAt }),
      ...(model === undefined ? {} : { model }),
      status: "completed",
      output: parts.output,
      output_text: parts.outputText,
      usage: parts.usage,
      error: null,
      incomplete_details: null,
    },
  }
}

function safeIncompleteDetails(value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  const reason = readRecordValue(value, "reason")
  return typeof reason === "string" && SAFE_INCOMPLETE_REASONS.has(reason) ?
      { reason }
    : null
}

function safeTerminalResponse(
  value: unknown,
  includeStatus = true,
): Record<string, unknown> {
  const id = nonEmptyString(readRecordValue(value, "id"))
  const object = readRecordValue(value, "object")
  const status = readRecordValue(value, "status")
  return {
    ...(id === undefined ? {} : { id }),
    ...(object === SAFE_OBJECT ? { object } : {}),
    ...((
      includeStatus && typeof status === "string" && SAFE_STATUSES.has(status)
    ) ?
      { status }
    : {}),
    output: [],
    output_text: "",
    usage: safeUsage(readRecordValue(value, "usage")),
    error: safeError(readRecordValue(value, "error")),
    incomplete_details: safeIncompleteDetails(
      readRecordValue(value, "incomplete_details"),
    ),
  }
}

function safeTerminalEvent(
  parsed: unknown,
  eventType: string,
): Record<string, unknown> {
  const sequence = sequenceNumber(readRecordValue(parsed, "sequence_number"))
  if (eventType === "error") {
    return { type: "error", sequence_number: sequence, ...safeError(parsed) }
  }
  const response = readRecordValue(parsed, "response")
  return {
    type: eventType,
    sequence_number: sequence,
    response: safeTerminalResponse(response, eventType !== "response.failed"),
  }
}

export function sanitizeResponsesStreamEvent(
  event: ServerSentEventMessage,
): ServerSentEventMessage {
  if (!event.data) {
    if (!event.event || !TERMINAL_EVENT_TYPES.has(event.event)) return event
    const eventType =
      event.event === "response.completed" ? "response.failed" : event.event
    return {
      ...event,
      event: eventType,
      data: JSON.stringify(safeTerminalEvent({}, eventType)),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(event.data) as unknown
  } catch {
    if (!event.event || !TERMINAL_EVENT_TYPES.has(event.event)) return event
    const eventType =
      event.event === "response.completed" ? "response.failed" : event.event
    return {
      ...event,
      event: eventType,
      data: JSON.stringify(safeTerminalEvent({}, eventType)),
    }
  }

  const parsedType = readRecordValue(parsed, "type")
  const eventType =
    event.event ?? (typeof parsedType === "string" ? parsedType : undefined)
  if (!eventType || !TERMINAL_EVENT_TYPES.has(eventType)) return event
  if (eventType === "response.completed") {
    const completed = safeCompletedEvent(
      parsed,
      readRecordValue(parsed, "response"),
    )
    if (completed) return { ...event, data: JSON.stringify(completed) }
    return {
      ...event,
      event: "response.failed",
      data: JSON.stringify(safeTerminalEvent(parsed, "response.failed")),
    }
  }
  return {
    ...event,
    data: JSON.stringify(safeTerminalEvent(parsed, eventType)),
  }
}
