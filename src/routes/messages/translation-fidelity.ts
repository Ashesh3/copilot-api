import type { TranslationCheck } from "~/lib/endpoint-routing"

import type { AnthropicMessagesPayload, AnthropicTool } from "./anthropic-types"

import { scanMessagesContent } from "./content-fidelity"

type TranslationTarget = "chat" | "responses"
type ExtensionConcept =
  | "content_extension"
  | "format_extension"
  | "request_extension"
  | "source_extension"
  | "tool_type"
  | "tool_extension"
const ROOT_FIELDS = new Set([
  "cache_control",
  "context_management",
  "fallback_credit_token",
  "max_tokens",
  "messages",
  "metadata",
  "model",
  "output_config",
  "service_tier",
  "speed",
  "stop_details",
  "stop_sequences",
  "stream",
  "system",
  "temperature",
  "thinking",
  "tool_choice",
  "tools",
  "top_k",
  "top_p",
])
const CACHE_CONTROL_FIELDS = new Set(["ttl", "type"])
const FUNCTION_TOOL_FIELDS = new Set([
  "description",
  "input_schema",
  "name",
  "type",
])
const WEB_SEARCH_TOOL_FIELDS = new Set([
  "allowed_domains",
  "blocked_domains",
  "description",
  "input_schema",
  "max_uses",
  "name",
  "type",
])
const TOOL_CHOICE_FIELDS = new Set([
  "disable_parallel_tool_use",
  "name",
  "type",
])
const THINKING_FIELDS = new Set(["budget_tokens", "type"])
const OUTPUT_CONFIG_FIELDS = new Set(["effort", "format", "task_budget"])
const METADATA_FIELDS = new Set(["user_id"])
const FORMAT_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  json_object: new Set(["type"]),
  json_schema: new Set(["description", "name", "schema", "strict", "type"]),
  text: new Set(["type"]),
}
const TASK_BUDGET_FIELDS = new Set(["remaining", "total", "type"])
const JSON_SCHEMA_FIELDS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "default",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "description",
  "discriminator",
  "else",
  "enum",
  "example",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "externalDocs",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "nullable",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly",
  "xml",
])

function createCheck(blockers: Array<string>): TranslationCheck {
  return { supported: blockers.length === 0, blockers }
}

function addBlocker(blockers: Array<string>, blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker)
}

function addPresentBlocker(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  field: string,
): void {
  const value = payload[field]
  if (value !== undefined && value !== null) addBlocker(blockers, field)
}

function scanUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  options: { blockers: Array<string>; concept: ExtensionConcept },
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addBlocker(options.blockers, options.concept)
    }
  }
}

function scanRoot(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  scanUnknownKeys(payload, ROOT_FIELDS, {
    blockers,
    concept: "request_extension",
  })
  addPresentBlocker(payload, blockers, "fallback_credit_token")
  addPresentBlocker(payload, blockers, "stop_details")
  addPresentBlocker(payload, blockers, "context_management")
  scanCacheControl(payload.cache_control, blockers, {
    extensionFirst: false,
    presenceBlocker: "cache_control",
  })
  if (payload.top_k !== undefined) {
    addBlocker(blockers, "top_k")
  }
  if (payload.service_tier !== undefined) {
    addBlocker(blockers, "service_tier")
  }
  if (target === "responses") {
    if (payload.stop_sequences !== undefined) {
      addBlocker(blockers, "stop_sequences")
    }
    if (payload.temperature !== undefined) {
      addBlocker(blockers, "temperature")
    }
  }
}

function scanTypedObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  options: { blockers: Array<string>; concept: ExtensionConcept },
): void {
  if (!isRecord(value)) return
  scanUnknownKeys(value, allowed, options)
}

function scanStructuredControls(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  scanTypedObject(payload.metadata, METADATA_FIELDS, {
    blockers,
    concept: "request_extension",
  })
  scanTypedObject(payload.thinking, THINKING_FIELDS, {
    blockers,
    concept: "request_extension",
  })
  scanTypedObject(payload.tool_choice, TOOL_CHOICE_FIELDS, {
    blockers,
    concept: "request_extension",
  })
  if (payload.tool_choice?.disable_parallel_tool_use !== undefined) {
    addBlocker(blockers, "tool_choice.disable_parallel_tool_use")
  }
  scanTypedObject(payload.output_config, OUTPUT_CONFIG_FIELDS, {
    blockers,
    concept: "request_extension",
  })
  scanOutputConfig(payload.output_config, blockers)
  if (target === "chat" && payload.output_config?.task_budget !== undefined) {
    addBlocker(blockers, "output_config.task_budget")
  }
}

function scanCacheControl(
  value: unknown,
  blockers: Array<string>,
  options: {
    extensionFirst: boolean
    presenceBlocker: string
  } = { extensionFirst: true, presenceBlocker: "content_cache_control" },
): void {
  if (!isRecord(value)) return
  if (!options.extensionFirst) addBlocker(blockers, options.presenceBlocker)
  scanUnknownKeys(value, CACHE_CONTROL_FIELDS, {
    blockers,
    concept:
      options.presenceBlocker === "cache_control" ?
        "request_extension"
      : "content_extension",
  })
  if (options.extensionFirst) addBlocker(blockers, options.presenceBlocker)
}

function scanOutputConfig(value: unknown, blockers: Array<string>): void {
  if (!isRecord(value)) return
  scanOutputFormat(value.format, blockers)
  scanTypedObject(value.task_budget, TASK_BUDGET_FIELDS, {
    blockers,
    concept: "request_extension",
  })
}

function scanOutputFormat(value: unknown, blockers: Array<string>): void {
  if (!isRecord(value)) return
  const type = typeof value.type === "string" ? value.type : "unknown"
  const allowed = FORMAT_FIELDS[type]
  if (!allowed) {
    addBlocker(blockers, "format_extension")
    return
  }
  scanUnknownKeys(value, allowed, {
    blockers,
    concept: "format_extension",
  })
  if (type === "json_schema") {
    scanJsonSchema(value.schema, {
      blockers,
      concept: "format_extension",
    })
  }
}

function scanTools(
  tools: AnthropicMessagesPayload["tools"],
  blockers: Array<string>,
): void {
  if (!tools) return
  for (const tool of tools) scanTool(tool, blockers)
}

function scanTool(tool: AnthropicTool, blockers: Array<string>): void {
  const type = typeof tool.type === "string" ? tool.type : undefined
  if (type?.startsWith("web_search")) {
    scanUnknownKeys(tool, WEB_SEARCH_TOOL_FIELDS, {
      blockers,
      concept: "tool_extension",
    })
    scanProvidedToolSchema(tool.input_schema, blockers, true)
    return
  }
  if (type?.startsWith("web_fetch")) {
    addBlocker(blockers, "tool_extension")
  } else if (type === "custom") {
    addBlocker(blockers, "tool_extension")
  } else if (type !== undefined && type !== "function") {
    addBlocker(blockers, "tool_type")
  }
  scanUnknownKeys(tool, FUNCTION_TOOL_FIELDS, {
    blockers,
    concept: "tool_extension",
  })
  scanProvidedToolSchema(tool.input_schema, blockers, false)
}

function scanProvidedToolSchema(
  value: unknown,
  blockers: Array<string>,
  regenerated: boolean,
): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    addBlocker(blockers, "tool_extension")
    return
  }
  scanJsonSchema(value, {
    blockers,
    concept: "tool_extension",
  })
  if (regenerated && Object.keys(value).length > 0) {
    addBlocker(blockers, "tool_extension")
  }
}

function scanJsonSchema(
  value: unknown,
  options: {
    blockers: Array<string>
    concept: "format_extension" | "tool_extension"
    seen?: Set<object>
  },
): void {
  const seen = options.seen ?? new Set<object>()
  if (!isRecord(value) || seen.has(value)) return
  seen.add(value)
  scanUnknownKeys(value, JSON_SCHEMA_FIELDS, options)

  for (const field of [
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "properties",
  ]) {
    const schemas = value[field]
    if (!isRecord(schemas)) continue
    for (const schema of Object.values(schemas)) {
      scanJsonSchema(schema, { ...options, seen })
    }
  }

  for (const field of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const schemas = value[field]
    if (!Array.isArray(schemas)) continue
    for (const schema of schemas) scanJsonSchema(schema, { ...options, seen })
  }

  for (const field of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) {
    scanJsonSchema(value[field], { ...options, seen })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkMessagesTranslation(
  payload: AnthropicMessagesPayload,
  target: TranslationTarget,
): TranslationCheck {
  const blockers: Array<string> = []
  scanRoot(payload, blockers, target)
  scanStructuredControls(payload, blockers, target)
  scanMessagesContent(payload, blockers, target)
  scanTools(payload.tools, blockers)
  return createCheck(blockers)
}

export function checkMessagesToResponsesTranslation(
  payload: AnthropicMessagesPayload,
): TranslationCheck {
  return checkMessagesTranslation(payload, "responses")
}

export function checkMessagesToChatTranslation(
  payload: AnthropicMessagesPayload,
): TranslationCheck {
  return checkMessagesTranslation(payload, "chat")
}

export function checkMessagesNativeCompatibility(
  payload: AnthropicMessagesPayload,
): TranslationCheck {
  const blockers: Array<string> = []
  for (const tool of payload.tools ?? []) {
    const type = typeof tool.type === "string" ? tool.type : undefined
    if (!type?.startsWith("web_search")) continue
    scanUnknownKeys(tool, WEB_SEARCH_TOOL_FIELDS, {
      blockers,
      concept: "tool_extension",
    })
    scanProvidedToolSchema(tool.input_schema, blockers, true)
  }
  return createCheck(blockers)
}
