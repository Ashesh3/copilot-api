import * as Sentry from "@sentry/bun"
import consola from "consola"
import util from "node:util"

import type {
  ClientDialect,
  CopilotInferenceEndpoint,
  EndpointRouteDecision,
} from "~/lib/endpoint-routing"

export type CopilotContractNormalizationClass =
  | "cache_control"
  | "deprecated_function_call"
  | "deprecated_functions"
  | "empty_tool_controls"
  | "encrypted_reasoning_include"
  | "function_parameters"
  | "gateway_only_fields"
  | "gpt56_sampling"
  | "json_object_instruction"
  | "json_schema"
  | "max_output_tokens"
  | "reasoning_defaults"
  | "stateless_controls"
  | "unsupported_sampling"

export type CopilotContractEvent =
  | {
      kind: "endpoint_route"
      source: ClientDialect
      target: CopilotInferenceEndpoint
      translated: boolean
      reason: EndpointRouteDecision["reason"]
    }
  | {
      kind: "request_normalization"
      protocol: ClientDialect
      classes: Array<CopilotContractNormalizationClass>
    }
  | {
      kind: "messages_beta"
      count: number
    }
  | {
      kind: "websocket_continuation"
      outcome: "new_thread" | "rehydrated" | "not_found"
    }
  | {
      kind: "response_metadata"
      headerCount: number
      quotaSnapshotCount: number
    }

type SafeContractData = Record<string, boolean | number | string>
type SafeDiagnostic = {
  attributes: SafeContractData
  data: SafeContractData
  message: string
}

const MAX_COUNT = 65_535
const MAX_NORMALIZATION_INPUTS = 64
const MAX_NORMALIZATION_TEXT_LENGTH = 256
const CLIENT_DIALECTS = new Set<ClientDialect>([
  "chat",
  "messages",
  "responses",
])
const COPILOT_ENDPOINTS = new Set<CopilotInferenceEndpoint>([
  "/chat/completions",
  "/responses",
  "/v1/messages",
])
const ROUTE_REASONS = new Set<EndpointRouteDecision["reason"]>([
  "endpoint_unavailable",
  "native",
  "payload_requirement",
])
const CONTINUATION_OUTCOMES = new Set(["new_thread", "not_found", "rehydrated"])
const NORMALIZATION_CLASSES = new Set<CopilotContractNormalizationClass>([
  "cache_control",
  "deprecated_function_call",
  "deprecated_functions",
  "empty_tool_controls",
  "encrypted_reasoning_include",
  "function_parameters",
  "gateway_only_fields",
  "gpt56_sampling",
  "json_object_instruction",
  "json_schema",
  "max_output_tokens",
  "reasoning_defaults",
  "stateless_controls",
  "unsupported_sampling",
])

export function recordCopilotEndpointRoute(
  decision: EndpointRouteDecision,
): void {
  recordCopilotContractEvent({ kind: "endpoint_route", ...decision })
}

export function recordCopilotRequestNormalization(
  protocol: ClientDialect,
  classes: Array<CopilotContractNormalizationClass>,
): void {
  if (classes.length === 0) return
  recordCopilotContractEvent({
    kind: "request_normalization",
    protocol,
    classes,
  })
}

export function recordCopilotMessagesBeta(beta: string | undefined): void {
  const count =
    typeof beta === "string" && beta !== "" ?
      beta.split(",", MAX_COUNT + 1).length
    : 0
  recordCopilotContractEvent({ kind: "messages_beta", count })
}

export function recordCopilotResponseMetadata(
  metadata: Record<string, string>,
): void {
  let names: Array<string>
  try {
    if (util.types.isProxy(metadata)) return
    names = Object.keys(metadata)
  } catch {
    return
  }
  recordCopilotContractEvent({
    kind: "response_metadata",
    headerCount: names.length,
    quotaSnapshotCount: names.filter((name) =>
      name.startsWith("x-quota-snapshot-"),
    ).length,
  })
}

export function recordCopilotContractEvent(event: CopilotContractEvent): void {
  const diagnostic = createSafeDiagnostic(event)
  if (!diagnostic) return

  try {
    consola.debug("[copilot-contract]", diagnostic.data)
  } catch {
    // Diagnostics must never affect request processing.
  }
  try {
    Sentry.addBreadcrumb({
      category: "copilot-api.contract",
      level: "info",
      message: diagnostic.message,
      data: diagnostic.data,
    })
  } catch {
    // Diagnostics must never affect request processing.
  }

  let span: ReturnType<typeof Sentry.getActiveSpan>
  try {
    span = Sentry.getActiveSpan()
  } catch {
    return
  }
  if (!span) return
  for (const [name, value] of Object.entries(diagnostic.attributes)) {
    try {
      span.setAttribute(name, value)
    } catch {
      // One failed attribute must not affect the request or later attributes.
    }
  }
}

function createSafeDiagnostic(event: unknown): SafeDiagnostic | undefined {
  const values = getSafeDataProperties(event)
  if (!values) return undefined
  const kind = values.kind

  switch (kind) {
    case "endpoint_route": {
      const source = allowlisted(values.source, CLIENT_DIALECTS)
      const target = allowlisted(values.target, COPILOT_ENDPOINTS)
      const reason = allowlisted(values.reason, ROUTE_REASONS)
      if (
        !source
        || !target
        || !reason
        || typeof values.translated !== "boolean"
      ) {
        return undefined
      }
      const data = {
        kind,
        source,
        target,
        translated: values.translated,
        reason,
      }
      return {
        data,
        message: "Copilot endpoint route selected",
        attributes: prefixAttributes(kind, {
          source,
          target,
          translated: values.translated,
          reason,
        }),
      }
    }
    case "request_normalization": {
      const protocol = allowlisted(values.protocol, CLIENT_DIALECTS)
      const classes = normalizeClasses(values.classes)
      if (!protocol || !classes) return undefined
      const data = {
        kind,
        protocol,
        classes: classes.text,
        classCount: classes.count,
      }
      return {
        data,
        message: "Copilot request normalized",
        attributes: prefixAttributes(kind, {
          protocol,
          classes: classes.text,
          class_count: classes.count,
        }),
      }
    }
    case "messages_beta": {
      const count = boundCount(values.count)
      const data = { kind, count }
      return {
        data,
        message: "Copilot Messages beta identifiers counted",
        attributes: prefixAttributes(kind, { count }),
      }
    }
    case "websocket_continuation": {
      const outcome = allowlisted(values.outcome, CONTINUATION_OUTCOMES)
      if (!outcome) return undefined
      const data = { kind, outcome }
      return {
        data,
        message: "Copilot WebSocket continuation resolved",
        attributes: prefixAttributes(kind, { outcome }),
      }
    }
    case "response_metadata": {
      const headerCount = boundCount(values.headerCount)
      const quotaSnapshotCount = boundCount(values.quotaSnapshotCount)
      const data = { kind, headerCount, quotaSnapshotCount }
      return {
        data,
        message: "Copilot response metadata collected",
        attributes: prefixAttributes(kind, {
          header_count: headerCount,
          quota_snapshot_count: quotaSnapshotCount,
        }),
      }
    }
    default: {
      return undefined
    }
  }
}

function getSafeDataProperties(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  try {
    if (util.types.isProxy(value)) return undefined
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result: Record<string, unknown> = {}
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if ("value" in descriptor) result[name] = descriptor.value
    }
    return result
  } catch {
    return undefined
  }
}

function normalizeClasses(
  value: unknown,
): { count: number; text: string } | undefined {
  const classes = getSafeArrayValues(value)
  if (!classes) return undefined
  const safeClasses = new Set<CopilotContractNormalizationClass>()
  for (const entry of classes) {
    const normalizationClass = allowlisted(entry, NORMALIZATION_CLASSES)
    if (normalizationClass) safeClasses.add(normalizationClass)
  }

  const included: Array<CopilotContractNormalizationClass> = []
  let length = 0
  for (const normalizationClass of [...safeClasses].sort()) {
    const nextLength =
      length + (included.length === 0 ? 0 : 1) + normalizationClass.length
    if (nextLength > MAX_NORMALIZATION_TEXT_LENGTH) break
    included.push(normalizationClass)
    length = nextLength
  }
  if (included.length === 0) return undefined
  return { count: included.length, text: included.join(",") }
}

function getSafeArrayValues(value: unknown): Array<unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  try {
    if (util.types.isProxy(value)) return undefined
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = Math.min(value.length, MAX_NORMALIZATION_INPUTS)
    const result: Array<unknown> = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (Object.hasOwn(descriptor, "value")) {
        result.push(descriptor.value)
      }
    }
    return result
  } catch {
    return undefined
  }
}

function allowlisted<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ?
      (value as T)
    : undefined
}

function boundCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)))
}

function prefixAttributes(
  kind: CopilotContractEvent["kind"],
  values: SafeContractData,
): SafeContractData {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      `copilot_api.contract.${kind}.${name}`,
      value,
    ]),
  )
}
