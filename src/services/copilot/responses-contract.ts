/* eslint-disable max-lines -- legacy and tolerant Responses contracts coexist until Task 14 */
import type { CopilotContractNormalizationClass } from "~/lib/copilot-contract-observability"

import { LocalHTTPError } from "~/lib/error"
import { getUnsupportedRequestParameters } from "~/lib/model-settings"
import {
  isProxyObject,
  REQUEST_SNAPSHOT_MAX_ARRAY_LENGTH,
  snapshotRequestPlainDataRecord,
} from "~/lib/plain-data-snapshot"

import type { ResponseInputMessage, ResponsesPayload } from "./create-responses"

export type ResponsesWireBody = ResponsesPayload & Record<string, unknown>

export interface PreparedResponsesSource {
  readonly source: ResponsesWireBody
  readonly normalizationClasses: ReadonlyArray<CopilotContractNormalizationClass>
}

export interface FinalizedNativeResponsesRequest {
  readonly body: ResponsesWireBody
  readonly normalizationClasses: ReadonlyArray<CopilotContractNormalizationClass>
}

export interface PreparedResponsesRequest {
  body: ResponsesWireBody
  normalizationClasses: Array<CopilotContractNormalizationClass>
}

export interface FinalizeResponsesRequestOptions {
  defaultEffort?: string
  implicitDefault: boolean
}

export interface FinalizeNativeResponsesRequestOptions
  extends FinalizeResponsesRequestOptions {
  model: string
}

export function applyResponsesReasoningDefaults(options: {
  body: ResponsesWireBody
  defaultEffort: string | undefined
  implicitDefault: boolean
}): boolean {
  const { body, defaultEffort, implicitDefault } = options
  const createdReasoning =
    body.reasoning === undefined || body.reasoning === null
  const reasoning = body.reasoning ?? {}
  body.reasoning = reasoning
  let changed =
    applyReasoningEffortDefault(reasoning, defaultEffort, implicitDefault)
    || createdReasoning

  if (reasoning.effort === "none") {
    changed ||= Object.hasOwn(reasoning, "summary")
    delete reasoning.summary
    if (body.include) {
      const filtered = body.include.filter(
        (item) => item !== "reasoning.encrypted_content",
      )
      changed ||= filtered.length !== body.include.length
      body.include = filtered
    }
    return changed
  }

  if (reasoning.summary === undefined || reasoning.summary === null) {
    reasoning.summary = "auto"
    changed = true
  }
  const include = body.include ? [...body.include] : []
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content")
    changed = true
  }
  body.include = include
  return changed
}

function applyReasoningEffortDefault(
  reasoning: NonNullable<ResponsesWireBody["reasoning"]>,
  defaultEffort: string | undefined,
  implicitDefault: boolean,
): boolean {
  if (reasoning.effort !== undefined && reasoning.effort !== null) return false
  if (implicitDefault) {
    const changed = Object.hasOwn(reasoning, "effort")
    delete reasoning.effort
    return changed
  }
  if (defaultEffort === undefined) return false
  reasoning.effort = defaultEffort
  return true
}

export function finalizeResponsesRequest(
  payload: ResponsesPayload,
  options: FinalizeResponsesRequestOptions,
): PreparedResponsesRequest {
  const prepared = prepareLegacyResponsesRequest(payload)
  if (
    shouldFinalizeResponsesReasoning(prepared.body, options)
    && applyResponsesReasoningDefaults({
      body: prepared.body,
      defaultEffort: options.defaultEffort,
      implicitDefault: options.implicitDefault,
    })
  ) {
    prepared.normalizationClasses.push("reasoning_defaults")
  }
  const samplingClass = removeUnsupportedResponsesRequestParameters(
    prepared.body,
  )
  if (samplingClass) prepared.normalizationClasses.push(samplingClass)
  return prepared
}

export function finalizeNativeResponsesRequest(
  prepared: PreparedResponsesSource,
  options: FinalizeNativeResponsesRequestOptions,
): FinalizedNativeResponsesRequest {
  const sourceSnapshot = snapshotRequestPlainDataRecord(prepared.source)
  if (!sourceSnapshot) {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: "The request body must be a JSON object.",
      param: "body",
    })
  }
  const body = structuredClone(sourceSnapshot) as ResponsesWireBody
  const normalizationClasses = [...prepared.normalizationClasses]
  body.model = options.model
  body.store = false
  delete body.service_tier

  const toolsClass = finalizeNativeResponsesTools(body)
  if (toolsClass) normalizationClasses.push(toolsClass)
  if (ensureJsonObjectInputMentionsJson(body)) {
    normalizationClasses.push("json_object_instruction")
  }
  if (normalizeFunctionToolParameters(body)) {
    normalizationClasses.push("function_parameters")
  }
  if (normalizeJsonSchemaResponseFormat(body)) {
    normalizationClasses.push("json_schema")
  }
  if (canonicalizeEncryptedReasoningInclude(body)) {
    normalizationClasses.push("encrypted_reasoning_include")
  }
  if (clampMaxOutputTokens(body)) {
    normalizationClasses.push("max_output_tokens")
  }
  if (
    shouldFinalizeResponsesReasoning(body, options)
    && applyResponsesReasoningDefaults({
      body,
      defaultEffort: options.defaultEffort,
      implicitDefault: options.implicitDefault,
    })
  ) {
    normalizationClasses.push("reasoning_defaults")
  }
  const samplingClass = removeUnsupportedResponsesRequestParameters(body)
  if (samplingClass) normalizationClasses.push(samplingClass)
  return { body, normalizationClasses }
}

function shouldFinalizeResponsesReasoning(
  body: ResponsesWireBody,
  options: FinalizeResponsesRequestOptions,
): boolean {
  return (
    body.reasoning !== undefined
    || options.defaultEffort !== undefined
    || options.implicitDefault
  )
}

const RESPONSES_TOP_LEVEL_FIELDS = [
  "model",
  "input",
  "instructions",
  "max_output_tokens",
  "metadata",
  "user",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "temperature",
  "top_p",
  "include",
  "context_management",
  "truncation",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "snippy",
  "multi_agent",
  "store",
  "background",
  "previous_response_id",
  "service_tier",
  "stream",
  "prompt",
  "conversation_id",
  "generate",
  "client_metadata",
  "task_budget",
  "copilot_cache_control",
] as const

const OMIT_FIELD = Symbol("omit Responses field")
const INVALID_RESPONSES_TOOL_SNAPSHOT = Symbol(
  "invalid Responses tool snapshot",
)
class ResponsesToolsSnapshotLimitError extends Error {}
const JSON_OBJECT_INPUT_INSTRUCTION = "Respond with JSON."
export const COPILOT_RESPONSES_MIN_OUTPUT_TOKENS = 16

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export function createResponsesValidationError(options: {
  code: string
  message: string
  param?: string
  status?: 400
}): LocalHTTPError {
  const clientBody = {
    error: {
      code: options.code,
      message: options.message,
      ...(options.param ? { param: options.param } : {}),
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    options.message,
    Response.json(clientBody, { status: options.status ?? 400 }),
    clientBody,
  )
}

export function prepareResponsesRequest(
  payload: unknown,
): PreparedResponsesSource {
  const sourceSnapshot = snapshotResponsesSource(payload)
  const normalizationClasses: Array<CopilotContractNormalizationClass> = []
  if (
    sourceSnapshot.store !== false
    || sourceSnapshot.service_tier !== undefined
  ) {
    normalizationClasses.push("stateless_controls")
  }
  const source = structuredClone(sourceSnapshot)
  source.store = false
  return { source, normalizationClasses }
}

function prepareLegacyResponsesRequest(
  payload: ResponsesPayload,
): PreparedResponsesRequest {
  validateResponsesBody(payload)
  validateStatefulControls(payload)
  validateResponsesContextManagement(payload.context_management)
  const preparedTools = prepareResponsesTools(payload.tools)
  const normalizationClasses: Array<CopilotContractNormalizationClass> = []

  const body = {} as ResponsesWireBody
  let statelessControlsNormalized = false
  for (const field of RESPONSES_TOP_LEVEL_FIELDS) {
    if (field === "tools") {
      if (preparedTools !== undefined) body.tools = preparedTools
      continue
    }
    const value = normalizeStatefulField(field, payload[field])
    if (value === OMIT_FIELD) {
      statelessControlsNormalized ||= payload[field] !== undefined
      continue
    }
    if (value === undefined) continue
    ;(body as Record<string, unknown>)[field] = structuredClone(value)
  }
  if (statelessControlsNormalized) {
    normalizationClasses.push("stateless_controls")
  }

  if (ensureJsonObjectInputMentionsJson(body)) {
    normalizationClasses.push("json_object_instruction")
  }
  if (normalizeFunctionToolParameters(body)) {
    normalizationClasses.push("function_parameters")
  }
  if (normalizeEmptyToolControls(body)) {
    normalizationClasses.push("empty_tool_controls")
  }
  if (normalizeJsonSchemaResponseFormat(body)) {
    normalizationClasses.push("json_schema")
  }
  if (canonicalizeEncryptedReasoningInclude(body)) {
    normalizationClasses.push("encrypted_reasoning_include")
  }
  if (clampMaxOutputTokens(body)) {
    normalizationClasses.push("max_output_tokens")
  }

  return { body, normalizationClasses }
}

function snapshotResponsesSource(payload: unknown): ResponsesWireBody {
  const sourceCandidate = createResponsesSourceSnapshotCandidate(payload)
  const snapshot = snapshotRequestPlainDataRecord(sourceCandidate)
  if (!snapshot) {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: "The request body must be a JSON object.",
      param: "body",
    })
  }

  const model = snapshot.model
  if (typeof model !== "string" || model.trim() === "") {
    throw createResponsesValidationError({
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
    })
  }
  return snapshot as ResponsesWireBody
}

function createResponsesSourceSnapshotCandidate(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || Array.isArray(payload) || isProxyObject(payload)) {
    return undefined
  }
  try {
    const prototype = Object.getPrototypeOf(payload) as unknown
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(payload)
    const source: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return undefined
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !("value" in descriptor)) {
        return undefined
      }
      if (key === "tools") {
        const tools = snapshotResponsesSourceTools(descriptor.value)
        if (tools !== undefined) source.tools = tools
        continue
      }
      source[key] = descriptor.value
    }
    return source
  } catch (error) {
    if (error instanceof ResponsesToolsSnapshotLimitError) {
      throw createResponsesValidationError({
        code: "invalid_value",
        message: `The tools field must contain at most ${REQUEST_SNAPSHOT_MAX_ARRAY_LENGTH.toLocaleString("en-US")} items.`,
        param: "tools",
      })
    }
    return undefined
  }
}

function snapshotResponsesSourceTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return snapshotResponsesToolEvidence(tools)
  let descriptors: Record<PropertyKey, PropertyDescriptor | undefined>
  try {
    if (
      isProxyObject(tools)
      || Object.getPrototypeOf(tools) !== Array.prototype
    ) {
      return undefined
    }
    descriptors = Object.getOwnPropertyDescriptors(tools) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >
  } catch {
    return undefined
  }
  const lengthDescriptor = descriptors.length
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return undefined
  }
  if (lengthDescriptor.value > REQUEST_SNAPSHOT_MAX_ARRAY_LENGTH) {
    throw new ResponsesToolsSnapshotLimitError()
  }
  const length = lengthDescriptor.value as number
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string"
        || (key !== "length" && (!/^\d+$/u.test(key) || Number(key) >= length)),
    )
  ) {
    return undefined
  }
  const snapshot: Array<unknown> = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      continue
    }
    const item = snapshotResponsesToolEvidence(descriptor.value)
    if (item !== undefined) snapshot.push(item)
  }
  return snapshot
}

function snapshotResponsesToolEvidence(value: unknown): unknown {
  const wrapper = snapshotRequestPlainDataRecord({ value })
  return wrapper?.value
}

function validateResponsesBody(payload: ResponsesPayload): void {
  if (!isPlainResponsesRecord(payload)) {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: "The request body must be a JSON object.",
      param: "body",
    })
  }
  if (typeof payload.model !== "string" || payload.model.trim() === "") {
    throw createResponsesValidationError({
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
    })
  }
}

function isPlainResponsesRecord(value: unknown): value is ResponsesPayload {
  if (!isRecord(value) || Array.isArray(value)) return false
  try {
    return Object.getPrototypeOf(value) === Object.prototype
  } catch {
    return false
  }
}

function canonicalizeEncryptedReasoningInclude(
  payload: ResponsesWireBody,
): boolean {
  if (!Array.isArray(payload.include)) return false

  let encryptedReasoningIncluded = false
  let changed = false
  payload.include = payload.include.filter((item) => {
    if (item !== "reasoning.encrypted_content") return true
    if (encryptedReasoningIncluded) {
      changed = true
      return false
    }
    encryptedReasoningIncluded = true
    return true
  })
  return changed
}

export function validateResponsesTools(tools: unknown): void {
  prepareResponsesTools(tools)
}

function prepareResponsesTools(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (tools === undefined || tools === null) return undefined
  if (!Array.isArray(tools)) {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: "The tools field must be an array.",
      param: "tools",
    })
  }

  return tools.map((tool) => {
    return getSafeResponsesToolSnapshot(tool)
  })
}

function finalizeNativeResponsesTools(
  payload: ResponsesWireBody,
): CopilotContractNormalizationClass | undefined {
  const suppliedTools = (payload as Record<string, unknown>).tools
  let candidates: Array<unknown>
  if (Array.isArray(suppliedTools)) {
    candidates = suppliedTools
  } else if (suppliedTools === undefined || suppliedTools === null) {
    candidates = []
  } else {
    candidates = [suppliedTools]
  }
  const tools = candidates.flatMap((tool) => {
    const snapshot = getSafeNativeResponsesToolSnapshot(tool)
    return snapshot ? [snapshot] : []
  })
  if (tools.length > 0) {
    payload.tools = tools
    return undefined
  }
  payload.tools = []
  return normalizeEmptyToolControls(payload) ? "empty_tool_controls" : undefined
}

function getSafeNativeResponsesToolSnapshot(
  tool: unknown,
): (Record<string, unknown> & { type: string }) | undefined {
  const snapshot = snapshotRequestPlainDataRecord(tool)
  if (!snapshot) return undefined
  const type = snapshot.type
  if (typeof type !== "string" || type.trim() === "") return undefined
  const writable = structuredClone(snapshot) as Record<string, unknown>
  writable.type = type.trim()
  return writable as Record<string, unknown> & { type: string }
}

function getSafeResponsesToolSnapshot(
  tool: unknown,
): Record<string, unknown> & { type: string } {
  let snapshot:
    | (Record<string, unknown> & { type: string })
    | typeof INVALID_RESPONSES_TOOL_SNAPSHOT
  try {
    snapshot = createSafeResponsesToolSnapshot(tool)
  } catch {
    throw createInvalidResponsesToolError()
  }

  if (snapshot === INVALID_RESPONSES_TOOL_SNAPSHOT) {
    throw createInvalidResponsesToolError()
  }
  return snapshot
}

function createSafeResponsesToolSnapshot(
  tool: unknown,
):
  | (Record<string, unknown> & { type: string })
  | typeof INVALID_RESPONSES_TOOL_SNAPSHOT {
  if (
    !isRecord(tool)
    || Array.isArray(tool)
    || Object.getPrototypeOf(tool) !== Object.prototype
  ) {
    return INVALID_RESPONSES_TOOL_SNAPSHOT
  }

  const snapshot = cloneResponsesToolData(tool, new Map<object, unknown>())
  if (!isRecord(snapshot) || Array.isArray(snapshot)) {
    return INVALID_RESPONSES_TOOL_SNAPSHOT
  }

  const descriptor = asDataDescriptor(
    Object.getOwnPropertyDescriptor(snapshot, "type"),
  )
  if (!descriptor) {
    return INVALID_RESPONSES_TOOL_SNAPSHOT
  }

  const type = descriptor.value
  if (typeof type !== "string" || type.trim() === "") {
    return INVALID_RESPONSES_TOOL_SNAPSHOT
  }
  snapshot.type = type.trim()
  return snapshot as Record<string, unknown> & { type: string }
}

function cloneResponsesToolData(
  value: unknown,
  seen: Map<object, unknown>,
): unknown {
  if (typeof value !== "object" || value === null) return value
  const existing = seen.get(value)
  if (existing !== undefined) return existing

  const isArray = Array.isArray(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (
    (!isArray && prototype !== Object.prototype && prototype !== null)
    || (isArray && prototype !== Array.prototype)
  ) {
    return INVALID_RESPONSES_TOOL_SNAPSHOT
  }

  const snapshot: Record<PropertyKey, unknown> | Array<unknown> =
    isArray ? [] : {}
  seen.set(value, snapshot)
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length" || typeof key === "symbol") continue
    const descriptor = asDataDescriptor(
      Object.getOwnPropertyDescriptor(value, key),
    )
    if (!descriptor) return INVALID_RESPONSES_TOOL_SNAPSHOT
    if (!descriptor.enumerable) continue
    const nestedSnapshot = cloneResponsesToolData(descriptor.value, seen)
    if (nestedSnapshot === INVALID_RESPONSES_TOOL_SNAPSHOT) {
      return INVALID_RESPONSES_TOOL_SNAPSHOT
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: nestedSnapshot,
      writable: true,
    })
  }
  return snapshot
}

function asDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): { enumerable?: boolean; value: unknown } | undefined {
  if (descriptor === undefined || !("value" in descriptor)) return undefined
  return descriptor as { enumerable?: boolean; value: unknown }
}

function createInvalidResponsesToolError(): LocalHTTPError {
  return createResponsesValidationError({
    code: "invalid_type",
    message: "Each tool must be a plain object with a non-empty string type.",
    param: "tools",
  })
}

export function validateResponsesContextManagement(value: unknown): void {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: "The context_management field must be an array.",
      param: "context_management",
    })
  }

  for (const item of value) {
    if (!isRecord(item) || Array.isArray(item)) {
      throw createResponsesValidationError({
        code: "invalid_type",
        message: "Each context_management item must be an object.",
        param: "context_management",
      })
    }
    if (item.type !== "compaction" && item.type !== "truncate") {
      throw createResponsesValidationError({
        code: "unsupported_value",
        message: "The context_management type must be compaction or truncate.",
        param: "context_management",
      })
    }
  }
}

export function removeUnsupportedResponsesRequestParameters(
  payload: ResponsesWireBody,
): "gpt56_sampling" | "unsupported_sampling" | undefined {
  const unsupported = new Set(getUnsupportedRequestParameters(payload.model))
  const gpt56Sampling =
    payload.model.startsWith("gpt-5.6-") && payload.reasoning?.effort !== "none"
  if (gpt56Sampling) {
    unsupported.add("temperature")
    unsupported.add("top_p")
  }

  let removed = false
  for (const parameter of unsupported) {
    switch (parameter) {
      case "temperature": {
        removed ||= payload.temperature !== undefined
        delete payload.temperature
        break
      }
      case "top_p": {
        removed ||= payload.top_p !== undefined
        delete payload.top_p
        break
      }
      default: {
        break
      }
    }
  }
  if (!removed) return undefined
  return gpt56Sampling ? "gpt56_sampling" : "unsupported_sampling"
}

function validateStatefulControls(payload: ResponsesPayload): void {
  validateBooleanStatefulControl({
    param: "store",
    value: payload.store,
    invalidTypeMessage: "The store field must be a boolean.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support stored responses.",
  })
  validateBooleanStatefulControl({
    param: "background",
    value: payload.background,
    invalidTypeMessage: "The background field must be a boolean.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support background requests.",
  })
  validateStringStatefulControl({
    param: "previous_response_id",
    value: payload.previous_response_id,
    invalidTypeMessage: "The previous_response_id field must be a string.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support previous-response continuation.",
  })
}

function validateBooleanStatefulControl(options: {
  param: "background" | "store"
  value: unknown
  invalidTypeMessage: string
  unsupportedMessage: string
}): void {
  if (
    options.value === undefined
    || options.value === null
    || options.value === false
  ) {
    return
  }
  if (typeof options.value !== "boolean") {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: options.invalidTypeMessage,
      param: options.param,
    })
  }
  throw createResponsesValidationError({
    code: "unsupported_value",
    message: options.unsupportedMessage,
    param: options.param,
  })
}

function validateStringStatefulControl(options: {
  param: "previous_response_id"
  value: unknown
  invalidTypeMessage: string
  unsupportedMessage: string
}): void {
  if (options.value === undefined || options.value === null) return
  if (typeof options.value !== "string") {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: options.invalidTypeMessage,
      param: options.param,
    })
  }
  throw createResponsesValidationError({
    code: "unsupported_value",
    message: options.unsupportedMessage,
    param: options.param,
  })
}

function normalizeStatefulField(
  field: (typeof RESPONSES_TOP_LEVEL_FIELDS)[number],
  value: unknown,
): unknown {
  if (field === "store") return value === false ? false : OMIT_FIELD
  if (field === "context_management" && value === null) return OMIT_FIELD
  if (
    field === "background"
    || field === "previous_response_id"
    || field === "service_tier"
  ) {
    return OMIT_FIELD
  }
  return value
}

function normalizeEmptyToolControls(payload: ResponsesWireBody): boolean {
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return false

  const changed =
    payload.tools !== undefined
    || payload.tool_choice !== undefined
    || payload.parallel_tool_calls !== undefined
  delete payload.tools
  delete payload.tool_choice
  delete payload.parallel_tool_calls
  return changed
}

function clampMaxOutputTokens(payload: ResponsesWireBody): boolean {
  if (
    typeof payload.max_output_tokens === "number"
    && payload.max_output_tokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    payload.max_output_tokens = COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
    return true
  }
  return false
}

function ensureJsonObjectInputMentionsJson(
  payload: ResponsesWireBody,
): boolean {
  if (payload.text?.format?.type !== "json_object") return false
  if (inputMentionsJson(payload.input)) return false

  const instruction: ResponseInputMessage = {
    type: "message",
    role: "developer",
    content: JSON_OBJECT_INPUT_INSTRUCTION,
  }

  if (Array.isArray(payload.input)) {
    payload.input = [instruction, ...payload.input]
    return true
  }

  if (typeof payload.input === "string") {
    payload.input = [
      instruction,
      { type: "message", role: "user", content: payload.input },
    ]
    return true
  }

  payload.input = [instruction]
  return true
}

function inputMentionsJson(input: ResponsesPayload["input"]): boolean {
  if (typeof input === "string") return containsJson(input)
  if (!Array.isArray(input)) return false

  return input.some((item) => {
    if (!isRecord(item)) return false
    if (!("content" in item)) return false
    return contentMentionsJson(item.content)
  })
}

function contentMentionsJson(content: unknown): boolean {
  if (typeof content === "string") return containsJson(content)
  if (!Array.isArray(content)) return false

  return content.some((part) => {
    if (typeof part === "string") return containsJson(part)
    return isRecord(part) && containsJson(part.text)
  })
}

function containsJson(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().includes("json")
}

function normalizeFunctionToolParameters(payload: ResponsesWireBody): boolean {
  if (!Array.isArray(payload.tools)) return false

  let changed = false
  for (const tool of payload.tools) {
    if (!isRecord(tool) || tool.type !== "function") continue

    if (!isRecord(tool.parameters) || Array.isArray(tool.parameters)) {
      tool.parameters = { type: "object", properties: {} }
      changed = true
      continue
    }

    if (tool.parameters.type === undefined || tool.parameters.type === null) {
      tool.parameters.type = "object"
      changed = true
    }
    if (!isRecord(tool.parameters.properties)) {
      tool.parameters.properties = {}
      changed = true
    }
  }
  return changed
}

export function normalizeJsonSchemaResponseFormat(
  _payload: ResponsesWireBody,
): boolean {
  return false
}
