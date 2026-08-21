/* eslint-disable max-lines, complexity, no-nested-ternary -- strict compatibility wrapper and tolerant source preparation coexist during migration */
import util from "node:util"

import type { CopilotContractNormalizationClass } from "~/lib/copilot-contract-observability"
import type { TranslationFinding } from "~/lib/endpoint-routing"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const SUPPORTED_CHAT_ROLES = new Set([
  "assistant",
  "developer",
  "system",
  "tool",
  "user",
])

function createInvalidChatBodyError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message: "The request body must be a JSON object.",
    param: "body",
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  try {
    return (
      !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    )
  } catch {
    return false
  }
}

function createChatValidationError(options: {
  code: string
  message: string
  param: string
}): LocalHTTPError {
  const clientBody = {
    error: {
      code: options.code,
      message: options.message,
      param: options.param,
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    options.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

function normalizeFunctionParameters(value: unknown): Record<string, unknown> {
  const parameters = isRecord(value) ? value : {}
  if (!parameters.type) parameters.type = "object"
  if (!isRecord(parameters.properties)) parameters.properties = {}
  return parameters
}

function validateMessages(messages: ChatCompletionsPayload["messages"]): void {
  const seenToolCallIds = new Set<string>()
  let pendingToolCallIds: Array<string> = []
  for (const message of messages as Array<unknown>) {
    if (!isRecord(message)) throw createInvalidMessagesError()
    validateMessageRole(message)
    pendingToolCallIds = validateToolHistoryMessage({
      message,
      pendingToolCallIds,
      seenToolCallIds,
    })
    validateMessageContent(message)
  }
  if (pendingToolCallIds.length > 0) throw createInvalidToolHistoryError()
}

function validateMessageRole(message: Record<string, unknown>): void {
  if (
    typeof message.role !== "string"
    || !SUPPORTED_CHAT_ROLES.has(message.role)
  ) {
    throw createInvalidMessageRoleError()
  }
}

function validateToolHistoryMessage(options: {
  message: Record<string, unknown>
  pendingToolCallIds: Array<string>
  seenToolCallIds: Set<string>
}): Array<string> {
  const { message, pendingToolCallIds, seenToolCallIds } = options
  if (pendingToolCallIds.length > 0 && message.role !== "tool") {
    throw createInvalidToolHistoryError()
  }
  if (message.role === "assistant") {
    return validateAssistantToolCalls(message.tool_calls, seenToolCallIds)
  }
  if (message.role === "tool") {
    return consumeToolResult(message, pendingToolCallIds)
  }
  return pendingToolCallIds
}

function validateMessageContent(message: Record<string, unknown>): void {
  if (!hasOwn(message, "content")) return
  const content = message.content
  if (typeof content === "string" || content === null) return
  if (!Array.isArray(content)) throw createInvalidMessagesError()
  for (const part of content) {
    if (part === null) throw createInvalidMessagesError()
    if (!isRecord(part)) throw createInvalidMessagesError()
    if (!hasOwn(part, "type") || typeof part.type !== "string") {
      throw createInvalidMessagesError()
    }
    validateKnownContentPart(part)
  }
}

function createInvalidMessageRoleError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_value",
    message: "Each message must use a supported role.",
    param: "messages",
  })
}

function createInvalidToolHistoryError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_value",
    message: "Tool calls and tool results must be complete and ordered.",
    param: "messages",
  })
}

function validateAssistantToolCalls(
  toolCalls: unknown,
  seenToolCallIds: Set<string>,
): Array<string> {
  if (toolCalls === undefined || toolCalls === null) return []
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw createInvalidToolHistoryError()
  }

  const pending: Array<string> = []
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || toolCall.type !== "function") {
      throw createInvalidToolHistoryError()
    }
    if (
      typeof toolCall.id !== "string"
      || toolCall.id.trim() === ""
      || seenToolCallIds.has(toolCall.id)
      || !isRecord(toolCall.function)
      || typeof toolCall.function.name !== "string"
      || toolCall.function.name.trim() === ""
      || typeof toolCall.function.arguments !== "string"
    ) {
      throw createInvalidToolHistoryError()
    }
    seenToolCallIds.add(toolCall.id)
    pending.push(toolCall.id)
  }
  return pending
}

function consumeToolResult(
  message: Record<string, unknown>,
  pendingToolCallIds: Array<string>,
): Array<string> {
  const expected = pendingToolCallIds[0]
  if (
    typeof message.tool_call_id !== "string"
    || message.tool_call_id !== expected
  ) {
    throw createInvalidToolHistoryError()
  }
  return pendingToolCallIds.slice(1)
}

function validateKnownContentPart(part: Record<string, unknown>): void {
  switch (part.type) {
    case "text": {
      validateTextContentPart(part)
      return
    }
    case "image_url": {
      validateImageContentPart(part)
      return
    }
    case "file": {
      validateFileContentPart(part)
      return
    }
    case "document": {
      validateDocumentContentPart(part)
      return
    }
    default: {
      return
    }
  }
}

function validateTextContentPart(part: Record<string, unknown>): void {
  if (typeof part.text !== "string") throw createInvalidMessagesError()
}

function validateImageContentPart(part: Record<string, unknown>): void {
  const image = part.image_url
  if (!isRecord(image) || typeof image.url !== "string") {
    throw createInvalidMessagesError()
  }
  if (image.url.trim().length === 0) throw createInvalidMessagesError()
  if (
    image.detail !== undefined
    && image.detail !== "low"
    && image.detail !== "high"
    && image.detail !== "auto"
  ) {
    throw createInvalidMessagesError()
  }
}

function validateFileContentPart(part: Record<string, unknown>): void {
  const file = part.file
  if (!isRecord(file)) return
  if (
    !isOptionalString(file.filename)
    || !isOptionalString(file.file_data)
    || !isOptionalString(file.file_id)
  ) {
    throw createInvalidMessagesError()
  }
}

function validateDocumentContentPart(part: Record<string, unknown>): void {
  if (hasOwn(part, "source") && !isRecord(part.source)) {
    throw createInvalidMessagesError()
  }
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function createInvalidMessagesError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message:
      "Each message content must be a string, null, or a valid content-part array.",
    param: "messages",
  })
}

function validateToolsContainer(tools: unknown): void {
  if (tools === undefined || tools === null || Array.isArray(tools)) return
  throw createChatValidationError({
    code: "invalid_type",
    message: "The tools field must be an array or null.",
    param: "tools",
  })
}

function validateTools(tools: ChatCompletionsPayload["tools"]): Set<string> {
  const functionNames = new Set<string>()
  if (!Array.isArray(tools)) return functionNames

  for (const tool of tools as Array<unknown>) {
    if (
      !isRecord(tool)
      || typeof tool.type !== "string"
      || tool.type.trim().length === 0
    ) {
      throw createInvalidToolsError()
    }
    if (tool.type !== "function") continue

    const func = tool.function
    if (
      !isRecord(func)
      || typeof func.name !== "string"
      || func.name.trim().length === 0
      || (func.description !== undefined
        && typeof func.description !== "string")
      || !isRecord(func.parameters)
    ) {
      throw createInvalidToolsError()
    }
    functionNames.add(func.name)
  }

  return functionNames
}

function createInvalidToolsError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message: "Each tools entry must be a valid tool definition.",
    param: "tools",
  })
}

function validateToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
  functionNames: Set<string>,
): void {
  if (
    toolChoice === undefined
    || toolChoice === null
    || toolChoice === "none"
  ) {
    return
  }

  if (functionNames.size === 0) throw createInvalidToolChoiceError()
  if (typeof toolChoice === "string") {
    return
  }
  if (!isRecord(toolChoice)) throw createInvalidToolChoiceError()
  if (toolChoice.type !== "function") {
    if (typeof toolChoice.type !== "string" || toolChoice.type.trim() === "") {
      throw createInvalidToolChoiceError()
    }
    return
  }
  if (!isMatchingFunctionToolChoice(toolChoice, functionNames)) {
    throw createInvalidToolChoiceError()
  }
}

function isMatchingFunctionToolChoice(
  toolChoice: Record<string, unknown>,
  functionNames: Set<string>,
): boolean {
  if (!isRecord(toolChoice.function)) return false
  const name = toolChoice.function.name
  return (
    typeof name === "string"
    && name.trim().length > 0
    && functionNames.has(name)
  )
}

function createInvalidToolChoiceError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_value",
    message:
      "The tool_choice field must select a declared function when tools are used.",
    param: "tool_choice",
  })
}

function normalizeModernFunctionTools(
  payload: ChatCompletionsPayload,
): boolean {
  if (!Array.isArray(payload.tools)) return false

  let changed = false
  for (const tool of payload.tools as Array<unknown>) {
    if (!isRecord(tool) || tool.type !== "function") continue
    if (!isRecord(tool.function)) continue
    const parameters = tool.function.parameters
    if (!isRecord(parameters)) {
      tool.function.parameters = normalizeFunctionParameters(parameters)
      changed = true
      continue
    }
    if (!parameters.type) {
      parameters.type = "object"
      changed = true
    }
    if (!isRecord(parameters.properties)) {
      parameters.properties = {}
      changed = true
    }
  }
  return changed
}

function normalizeDeprecatedFunctions(
  payload: ChatCompletionsPayload,
): boolean {
  const legacyFunctions = payload.functions
  if (legacyFunctions === undefined || legacyFunctions === null) {
    const changed = hasOwn(payload, "functions")
    delete payload.functions
    return changed
  }
  if (!Array.isArray(legacyFunctions)) {
    throw createChatValidationError({
      code: "invalid_type",
      message: "The functions field must be an array.",
      param: "functions",
    })
  }

  const converted = legacyFunctions.map((legacyFunction) => {
    if (!isRecord(legacyFunction)) {
      throw createInvalidLegacyFunctionError()
    }
    const { description, name, parameters } = legacyFunction
    if (typeof name !== "string" || name.trim().length === 0) {
      throw createInvalidLegacyFunctionError()
    }
    if (description !== undefined && typeof description !== "string") {
      throw createInvalidLegacyFunctionError()
    }

    return {
      type: "function" as const,
      function: {
        name,
        ...(description === undefined ? {} : { description }),
        parameters: normalizeFunctionParameters(parameters),
      },
    }
  })

  if (converted.length > 0) {
    payload.tools = [
      ...(Array.isArray(payload.tools) ? payload.tools : []),
      ...converted,
    ]
  }
  delete payload.functions
  return true
}

function createInvalidLegacyFunctionError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message: "Each functions entry must be a valid function definition.",
    param: "functions",
  })
}

function normalizeDeprecatedFunctionCall(
  payload: ChatCompletionsPayload,
): boolean {
  if (!hasOwn(payload, "function_call")) return false

  const functionCall = payload.function_call
  let converted: ChatCompletionsPayload["tool_choice"]
  if (functionCall === null) {
    converted = undefined
  } else if (functionCall === "none" || functionCall === "auto") {
    converted = functionCall
  } else if (
    isRecord(functionCall)
    && typeof functionCall.name === "string"
    && functionCall.name.trim().length > 0
  ) {
    converted = {
      type: "function",
      function: { name: functionCall.name },
    }
  } else {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The function_call field must select a valid function.",
      param: "function_call",
    })
  }

  if (payload.tool_choice === undefined && converted !== undefined) {
    payload.tool_choice = converted
  }
  delete payload.function_call
  return true
}

export interface PreparedChatCompletionsRequest {
  readonly findings: ReadonlyArray<TranslationFinding>
  normalizationClasses: Array<CopilotContractNormalizationClass>
  /** Compatibility alias for callers migrating to `source`. */
  payload: PreparedChatCompletionsSource
  source: PreparedChatCompletionsSource
}

export interface PreparedChatMessage extends Record<string, unknown> {
  content?: unknown
  role: string
  tool_calls?: Array<Record<string, unknown>>
}

export interface PreparedChatCompletionsSource extends Record<string, unknown> {
  messages: Array<PreparedChatMessage>
  model: string
  tools?: Array<Record<string, unknown>>
}

interface MutablePreparationState {
  findings: Array<TranslationFinding>
  normalizationClasses: Array<CopilotContractNormalizationClass>
}

function addFinding(
  state: MutablePreparationState,
  finding: TranslationFinding,
): void {
  if (
    state.findings.some(
      (current) =>
        current.class === finding.class
        && current.severity === finding.severity,
    )
  ) {
    return
  }
  state.findings.push(finding)
}

function addNormalizationClass(
  state: MutablePreparationState,
  value: CopilotContractNormalizationClass,
): void {
  if (!state.normalizationClasses.includes(value)) {
    state.normalizationClasses.push(value)
  }
}

function assertSnapshotSafe(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return
  }
  if (value === undefined) throw createInvalidChatBodyError()
  if (typeof value !== "object") throw createInvalidChatBodyError()
  if (util.types.isProxy(value)) throw createInvalidChatBodyError()
  if (seen.has(value)) throw createInvalidChatBodyError()
  seen.add(value)

  let prototype: unknown
  let descriptors: PropertyDescriptorMap
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw createInvalidChatBodyError()
  }
  if (
    Array.isArray(value) ?
      prototype !== Array.prototype
    : prototype !== Object.prototype && prototype !== null
  ) {
    throw createInvalidChatBodyError()
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw createInvalidChatBodyError()
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) {
        throw createInvalidChatBodyError()
      }
    }
  }
  for (const descriptor of Object.values(descriptors)) {
    if (
      typeof descriptor.value === "function"
      || typeof descriptor.value === "symbol"
      || typeof descriptor.value === "bigint"
    ) {
      throw createInvalidChatBodyError()
    }
    if (!Object.hasOwn(descriptor, "value")) throw createInvalidChatBodyError()
    assertSnapshotSafe(descriptor.value, seen)
  }
  seen.delete(value)
}

function clonePreparedSource(payload: unknown): Record<string, unknown> {
  if (!isPlainRecord(payload)) throw createInvalidChatBodyError()
  assertSnapshotSafe(payload)
  try {
    return structuredClone(payload)
  } catch {
    throw createInvalidChatBodyError()
  }
}

function normalizeContent(
  value: unknown,
  state: MutablePreparationState,
): unknown {
  if (value === null || typeof value === "string") return value
  if (
    typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    addFinding(state, { class: "content_part", severity: "adapted" })
    return String(value)
  }
  if (isRecord(value)) {
    addFinding(state, { class: "message_shape", severity: "adapted" })
    return [value]
  }
  if (!Array.isArray(value)) return undefined

  const parts: Array<unknown> = []
  for (const part of value) {
    if (part === null || part === undefined) {
      addFinding(state, { class: "content_part", severity: "omitted" })
      continue
    }
    if (isRecord(part)) {
      parts.push(part)
      continue
    }
    if (
      typeof part === "string"
      || typeof part === "boolean"
      || (typeof part === "number" && Number.isFinite(part))
    ) {
      addFinding(state, { class: "content_part", severity: "adapted" })
      parts.push({ type: "text", text: String(part) })
      continue
    }
    addFinding(state, { class: "content_part", severity: "omitted" })
  }
  return parts
}

function normalizeToolCalls(
  value: unknown,
  state: MutablePreparationState,
): Array<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined
  const entries = Array.isArray(value) ? value : [value]
  if (!Array.isArray(value)) {
    addFinding(state, { class: "tool_history", severity: "adapted" })
  }
  const retained: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    if (!isRecord(entry)) {
      addFinding(state, { class: "tool_history", severity: "omitted" })
      continue
    }
    retained.push(entry)
  }
  if (retained.length > 0) {
    addFinding(state, { class: "tool_history", severity: "exact" })
    return retained
  }
  return undefined
}

function hasMeaningfulContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  if (!Array.isArray(value)) return false
  return value.some((part) => {
    if (typeof part === "string") return part.trim().length > 0
    return isRecord(part)
  })
}

function hasMeaningfulMessage(message: PreparedChatMessage): boolean {
  return (
    hasMeaningfulContent(message.content)
    || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || (message.role === "tool"
      && typeof message.tool_call_id === "string"
      && message.tool_call_id.trim().length > 0)
    || [
      message.reasoning_text,
      message.reasoning_opaque,
      message.encrypted_content,
    ].some((value) => typeof value === "string" && value.trim().length > 0)
  )
}

function prepareMessages(
  value: unknown,
  state: MutablePreparationState,
): Array<PreparedChatMessage> {
  const entries =
    Array.isArray(value) ? value
    : isRecord(value) ? [value]
    : []
  if (isRecord(value)) {
    addFinding(state, { class: "message_shape", severity: "adapted" })
  }
  const messages: Array<PreparedChatMessage> = []
  for (const entry of entries) {
    if (!isRecord(entry)) {
      addFinding(state, { class: "message_shape", severity: "omitted" })
      continue
    }
    const message = entry as PreparedChatMessage
    if (typeof message.role !== "string" || message.role.trim() === "") {
      message.role = "user"
      addFinding(state, { class: "message_role", severity: "adapted" })
    } else if (!SUPPORTED_CHAT_ROLES.has(message.role)) {
      addFinding(state, { class: "message_role", severity: "exact" })
    }
    if (hasOwn(message, "content")) {
      const content = normalizeContent(message.content, state)
      if (content === undefined) delete message.content
      else message.content = content
    }
    const toolCalls = normalizeToolCalls(message.tool_calls, state)
    if (toolCalls) message.tool_calls = toolCalls
    else if (hasOwn(message, "tool_calls")) delete message.tool_calls
    if (!hasMeaningfulMessage(message)) {
      addFinding(state, { class: "message_shape", severity: "omitted" })
      continue
    }
    messages.push(message)
  }
  return messages
}

function repairFunctionParameters(
  value: unknown,
  state: MutablePreparationState,
): Record<string, unknown> {
  const parameters = isRecord(value) ? value : {}
  let changed = !isRecord(value)
  if (typeof parameters.type !== "string" || parameters.type.trim() === "") {
    parameters.type = "object"
    changed = true
  }
  if (!isRecord(parameters.properties)) {
    parameters.properties = {}
    changed = true
  }
  if (changed) {
    addFinding(state, { class: "tool_shape", severity: "adapted" })
    addNormalizationClass(state, "function_parameters")
  }
  return parameters
}

function prepareModernTool(
  value: unknown,
  state: MutablePreparationState,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value)
    || typeof value.type !== "string"
    || !value.type.trim()
  ) {
    addFinding(state, { class: "tool_shape", severity: "omitted" })
    return undefined
  }
  if (value.type !== "function") {
    addFinding(state, { class: "tool_shape", severity: "exact" })
    return value
  }
  if (
    !isRecord(value.function)
    || typeof value.function.name !== "string"
    || !value.function.name.trim()
  ) {
    addFinding(state, { class: "tool_shape", severity: "omitted" })
    return undefined
  }
  if (
    value.function.description !== undefined
    && typeof value.function.description !== "string"
  ) {
    delete value.function.description
    addFinding(state, { class: "tool_shape", severity: "adapted" })
  }
  value.function.parameters = repairFunctionParameters(
    value.function.parameters,
    state,
  )
  return value
}

function prepareLegacyTool(
  value: unknown,
  state: MutablePreparationState,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value)
    || typeof value.name !== "string"
    || !value.name.trim()
  ) {
    addFinding(state, { class: "tool_shape", severity: "omitted" })
    return undefined
  }
  const functionDefinition: Record<string, unknown> = {
    name: value.name,
    parameters: repairFunctionParameters(value.parameters, state),
  }
  if (typeof value.description === "string") {
    functionDefinition.description = value.description
  } else if (value.description !== undefined) {
    addFinding(state, { class: "tool_shape", severity: "adapted" })
  }
  return { type: "function", function: functionDefinition }
}

function prepareTools(
  source: Record<string, unknown>,
  state: MutablePreparationState,
): void {
  const modernValue = source.tools
  const modernEntries =
    Array.isArray(modernValue) ? modernValue
    : isRecord(modernValue) ? [modernValue]
    : []
  if (isRecord(modernValue)) {
    addFinding(state, { class: "tool_shape", severity: "adapted" })
  } else if (modernValue !== undefined && modernValue !== null) {
    addFinding(state, { class: "tool_shape", severity: "omitted" })
  }
  const tools = modernEntries.flatMap((entry) => {
    const prepared = prepareModernTool(entry, state)
    return prepared ? [prepared] : []
  })

  const legacyValue = source.functions
  const legacyEntries =
    Array.isArray(legacyValue) ? legacyValue
    : isRecord(legacyValue) ? [legacyValue]
    : []
  for (const entry of legacyEntries) {
    const prepared = prepareLegacyTool(entry, state)
    if (prepared) tools.push(prepared)
  }
  if (legacyEntries.length > 0) {
    addNormalizationClass(state, "deprecated_functions")
    addFinding(state, { class: "tool_shape", severity: "adapted" })
  } else if (legacyValue !== undefined && legacyValue !== null) {
    addFinding(state, { class: "tool_shape", severity: "omitted" })
  }

  if (tools.length > 0) source.tools = tools
  else delete source.tools
  delete source.functions
}

function prepareLegacyToolChoice(
  source: Record<string, unknown>,
  state: MutablePreparationState,
): void {
  if (!hasOwn(source, "function_call")) return
  const legacy = source.function_call
  if (!hasOwn(source, "tool_choice")) {
    if (legacy === "none" || legacy === "auto") {
      source.tool_choice = legacy
      addNormalizationClass(state, "deprecated_function_call")
      addFinding(state, { class: "tool_choice", severity: "adapted" })
    } else if (
      isRecord(legacy)
      && typeof legacy.name === "string"
      && legacy.name.trim()
    ) {
      source.tool_choice = {
        type: "function",
        function: { name: legacy.name },
      }
      addNormalizationClass(state, "deprecated_function_call")
      addFinding(state, { class: "tool_choice", severity: "adapted" })
    } else if (legacy !== undefined && legacy !== null) {
      addFinding(state, { class: "tool_choice", severity: "omitted" })
    }
  }
  delete source.function_call
}

function prepareTokenAliases(
  source: Record<string, unknown>,
  state: MutablePreparationState,
): void {
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    if (source[key] === null) {
      if (key === "max_tokens") delete source.max_tokens
      else delete source.max_completion_tokens
      addFinding(state, { class: "token_alias", severity: "adapted" })
    }
  }
  if (
    source.max_tokens !== undefined
    && source.max_completion_tokens !== undefined
  ) {
    addFinding(state, { class: "token_alias", severity: "exact" })
  }
}

export function prepareChatCompletionsRequest(
  payload: unknown,
): PreparedChatCompletionsRequest {
  const source = clonePreparedSource(payload)
  const state: MutablePreparationState = {
    findings: [],
    normalizationClasses: [],
  }

  if (typeof source.model !== "string" || source.model.trim() === "") {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
    })
  }
  const messages = prepareMessages(source.messages, state)
  if (messages.length === 0) {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The messages field must contain a meaningful message.",
      param: "messages",
    })
  }
  source.messages = messages
  prepareTools(source, state)
  prepareLegacyToolChoice(source, state)
  prepareTokenAliases(source, state)

  const preparedSource = source as PreparedChatCompletionsSource
  return {
    findings: Object.freeze(
      state.findings.map((finding) => Object.freeze(finding)),
    ),
    normalizationClasses: state.normalizationClasses,
    payload: preparedSource,
    source: preparedSource,
  }
}

function prepareStrictChatCompletionsRequest(payload: ChatCompletionsPayload): {
  payload: ChatCompletionsPayload
} {
  if (!isPlainRecord(payload)) throw createInvalidChatBodyError()

  let normalized: ChatCompletionsPayload
  try {
    normalized = structuredClone(payload)
    JSON.stringify(normalized)
  } catch {
    throw createInvalidChatBodyError()
  }

  if (typeof normalized.model !== "string" || normalized.model.trim() === "") {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
    })
  }
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The messages field must be a non-empty array.",
      param: "messages",
    })
  }
  validateMessages(normalized.messages)
  validateToolsContainer(normalized.tools)
  if (
    normalized.max_tokens !== undefined
    && normalized.max_tokens !== null
    && normalized.max_completion_tokens !== undefined
    && normalized.max_completion_tokens !== null
  ) {
    throw createChatValidationError({
      code: "invalid_request",
      message: "max_tokens and max_completion_tokens are mutually exclusive.",
      param: "max_tokens",
    })
  }

  const normalizationClasses: Array<CopilotContractNormalizationClass> = []
  if (normalizeModernFunctionTools(normalized)) {
    normalizationClasses.push("function_parameters")
  }
  if (normalizeDeprecatedFunctions(normalized)) {
    normalizationClasses.push("deprecated_functions")
  }
  if (normalizeDeprecatedFunctionCall(normalized)) {
    normalizationClasses.push("deprecated_function_call")
  }
  const functionNames = validateTools(normalized.tools)
  validateToolChoice(normalized.tool_choice, functionNames)
  return { payload: normalized }
}

export function normalizeChatCompletionsRequest(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return prepareStrictChatCompletionsRequest(payload).payload
}
