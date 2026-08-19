import * as Sentry from "@sentry/bun"
import consola from "consola"

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
  const count = beta ? beta.split(",").length : 0
  recordCopilotContractEvent({ kind: "messages_beta", count })
}

export function recordCopilotResponseMetadata(
  metadata: Record<string, string>,
): void {
  let quotaSnapshotCount = 0
  for (const name of Object.keys(metadata)) {
    if (name.startsWith("x-quota-snapshot-")) quotaSnapshotCount += 1
  }
  recordCopilotContractEvent({
    kind: "response_metadata",
    headerCount: Object.keys(metadata).length,
    quotaSnapshotCount,
  })
}

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

const MAX_COUNT = 65_535
const MAX_NORMALIZATION_INPUTS = 64
const MAX_NORMALIZATION_TEXT_LENGTH = 256
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

export function recordCopilotContractEvent(event: CopilotContractEvent): void {
  const diagnostic = createSafeDiagnostic(event)
  consola.debug("[copilot-contract]", diagnostic.data)
  Sentry.addBreadcrumb({
    category: "copilot-api.contract",
    level: "info",
    message: diagnostic.message,
    data: diagnostic.data,
  })

  const span = Sentry.getActiveSpan()
  if (!span) return
  for (const [name, value] of Object.entries(diagnostic.attributes)) {
    span.setAttribute(name, value)
  }
}

function createSafeDiagnostic(event: CopilotContractEvent): {
  attributes: SafeContractData
  data: SafeContractData
  message: string
} {
  switch (event.kind) {
    case "endpoint_route": {
      const data = {
        kind: event.kind,
        source: event.source,
        target: event.target,
        translated: event.translated,
        reason: event.reason,
      }
      return {
        data,
        message: "Copilot endpoint route selected",
        attributes: prefixAttributes(event.kind, {
          source: event.source,
          target: event.target,
          translated: event.translated,
          reason: event.reason,
        }),
      }
    }
    case "request_normalization": {
      const classes = normalizeClasses(event.classes)
      const data = {
        kind: event.kind,
        protocol: event.protocol,
        classes,
        classCount: classes === "" ? 0 : classes.split(",").length,
      }
      return {
        data,
        message: "Copilot request normalized",
        attributes: prefixAttributes(event.kind, {
          protocol: event.protocol,
          classes,
          class_count: data.classCount,
        }),
      }
    }
    case "messages_beta": {
      const count = boundCount(event.count)
      const data = { kind: event.kind, count }
      return {
        data,
        message: "Copilot Messages beta identifiers counted",
        attributes: prefixAttributes(event.kind, { count }),
      }
    }
    case "websocket_continuation": {
      const data = { kind: event.kind, outcome: event.outcome }
      return {
        data,
        message: "Copilot WebSocket continuation resolved",
        attributes: prefixAttributes(event.kind, {
          outcome: event.outcome,
        }),
      }
    }
    case "response_metadata": {
      const headerCount = boundCount(event.headerCount)
      const quotaSnapshotCount = boundCount(event.quotaSnapshotCount)
      const data = {
        kind: event.kind,
        headerCount,
        quotaSnapshotCount,
      }
      return {
        data,
        message: "Copilot response metadata collected",
        attributes: prefixAttributes(event.kind, {
          header_count: headerCount,
          quota_snapshot_count: quotaSnapshotCount,
        }),
      }
    }
    default: {
      return assertNever(event)
    }
  }
}

function normalizeClasses(
  classes: Array<CopilotContractNormalizationClass>,
): string {
  const safeClasses = new Set<CopilotContractNormalizationClass>()
  const limit = Math.min(classes.length, MAX_NORMALIZATION_INPUTS)
  for (let index = 0; index < limit; index += 1) {
    const value = classes[index]
    if (NORMALIZATION_CLASSES.has(value)) safeClasses.add(value)
  }
  return [...safeClasses]
    .sort()
    .join(",")
    .slice(0, MAX_NORMALIZATION_TEXT_LENGTH)
}

function boundCount(value: number): number {
  if (!Number.isFinite(value)) return 0
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

function assertNever(value: never): never {
  void value
  throw new Error("Unhandled Copilot contract event")
}
