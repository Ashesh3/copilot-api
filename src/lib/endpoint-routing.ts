import util from "node:util"

import type { Model } from "~/services/copilot/get-models"

export type ClientDialect = "chat" | "messages" | "responses"

export type CopilotInferenceEndpoint =
  | "/chat/completions"
  | "/responses"
  | "/v1/messages"

export interface ModelEndpointSupport {
  chat: boolean
  embeddings: boolean
  messages: boolean
  responses: boolean
  responsesWebSocket: boolean
}

export interface TranslationCheck {
  blockers: Array<string>
  supported: boolean
}

export type TranslationFindingClass =
  | "attachment"
  | "content_part"
  | "context_management"
  | "message_role"
  | "message_shape"
  | "reasoning_state"
  | "sampling"
  | "stateful_controls"
  | "token_alias"
  | "tool_choice"
  | "tool_history"
  | "tool_shape"
  | "unknown_item"
  | "unknown_top_level"

export type TranslationFindingSeverity =
  | "exact"
  | "adapted"
  | "omitted"
  | "fatal"

export interface TranslationFinding {
  readonly class: TranslationFindingClass
  readonly severity: TranslationFindingSeverity
}

export interface EvaluatedTranslationCheck {
  readonly mode: "evaluated"
  readonly findings: ReadonlyArray<TranslationFinding>
  readonly cost: number
  readonly supported: boolean
}

export interface EvaluatedEndpointCandidate<
  Endpoint extends CopilotInferenceEndpoint = CopilotInferenceEndpoint,
  Payload = unknown,
> {
  readonly endpoint: Endpoint
  readonly reason: "endpoint_unavailable" | "payload_requirement"
  readonly payload: Payload
  readonly check: EvaluatedTranslationCheck
}

export interface EvaluatedEndpointSelection<
  Candidate extends EvaluatedEndpointCandidate = EvaluatedEndpointCandidate,
> {
  readonly decision: EndpointRouteDecision
  readonly candidate: Candidate
}

export interface EndpointRouteDecision {
  reason: "endpoint_unavailable" | "native" | "payload_requirement"
  source: ClientDialect
  target: CopilotInferenceEndpoint
  translated: boolean
}

export interface EndpointRouteFailure {
  blockers: Array<string>
  code: "endpoint_translation_unsupported"
  source: ClientDialect
}

type TranslatedRouteReason = Exclude<EndpointRouteDecision["reason"], "native">

const SOURCE_ENDPOINTS: Record<ClientDialect, CopilotInferenceEndpoint> = {
  chat: "/chat/completions",
  messages: "/v1/messages",
  responses: "/responses",
}

const MAX_EVALUATED_FINDINGS = 32
const MAX_EVALUATED_COST = 255
const TRANSLATION_FINDING_CLASSES = new Set<TranslationFindingClass>([
  "attachment",
  "content_part",
  "context_management",
  "message_role",
  "message_shape",
  "reasoning_state",
  "sampling",
  "stateful_controls",
  "token_alias",
  "tool_choice",
  "tool_history",
  "tool_shape",
  "unknown_item",
  "unknown_top_level",
])
const TRANSLATION_FINDING_SEVERITIES = new Set<TranslationFindingSeverity>([
  "exact",
  "adapted",
  "omitted",
  "fatal",
])
const TRANSLATION_FINDING_COSTS: Record<
  Exclude<TranslationFindingSeverity, "fatal">,
  number
> = {
  exact: 0,
  adapted: 1,
  omitted: 2,
}

const endpointEnabled = (
  support: ModelEndpointSupport,
  endpoint: CopilotInferenceEndpoint,
): boolean => {
  switch (endpoint) {
    case "/chat/completions": {
      return support.chat
    }
    case "/responses": {
      return support.responses
    }
    case "/v1/messages": {
      return support.messages
    }
    default: {
      return false
    }
  }
}

export function getModelEndpointSupport(
  model: Pick<Model, "supported_endpoints"> | undefined,
): ModelEndpointSupport {
  if (!model) {
    return {
      chat: false,
      embeddings: false,
      messages: false,
      responses: false,
      responsesWebSocket: false,
    }
  }

  const endpoints = model.supported_endpoints
  if (!endpoints) {
    return {
      chat: true,
      embeddings: false,
      messages: false,
      responses: false,
      responsesWebSocket: false,
    }
  }

  return {
    chat: endpoints.includes("/chat/completions"),
    embeddings: endpoints.includes("/embeddings"),
    messages: endpoints.includes("/v1/messages"),
    responses: endpoints.includes("/responses"),
    responsesWebSocket: endpoints.includes("ws:/responses"),
  }
}

export function selectCopilotEndpoint(options: {
  candidates: Array<{
    check: TranslationCheck
    endpoint: CopilotInferenceEndpoint
    reason: TranslatedRouteReason
  }>
  source: ClientDialect
  support: ModelEndpointSupport
}): EndpointRouteDecision | EndpointRouteFailure {
  for (const candidate of options.candidates) {
    if (
      endpointEnabled(options.support, candidate.endpoint)
      && candidate.check.supported
    ) {
      const translated = candidate.endpoint !== SOURCE_ENDPOINTS[options.source]
      let reason: EndpointRouteDecision["reason"] = "native"
      if (translated) {
        reason = "endpoint_unavailable"
        if (candidate.reason === "payload_requirement") {
          reason = "payload_requirement"
        }
      }
      return {
        reason,
        source: options.source,
        target: candidate.endpoint,
        translated,
      }
    }
  }

  const blockers = Array.from(
    new Set(
      options.candidates.flatMap((candidate) =>
        endpointEnabled(options.support, candidate.endpoint) ?
          candidate.check.blockers
        : [],
      ),
    ),
  )
  return {
    blockers,
    code: "endpoint_translation_unsupported",
    source: options.source,
  }
}

export function createEvaluatedTranslationCheck(
  findings: ReadonlyArray<TranslationFinding>,
): EvaluatedTranslationCheck {
  const retained: Array<TranslationFinding> = []
  const pairs = new Set<string>()
  let cost = 0
  let fatal = false

  const entries = getSafeFindingArrayEntries(findings)
  for (const entry of entries) {
    const finding = getSafeTranslationFinding(entry)
    if (!finding) continue
    const key = `${finding.class}:${finding.severity}`
    if (pairs.has(key)) continue
    pairs.add(key)
    retained.push(Object.freeze(finding))
    if (finding.severity === "fatal") {
      fatal = true
    } else {
      cost = Math.min(
        MAX_EVALUATED_COST,
        cost + TRANSLATION_FINDING_COSTS[finding.severity],
      )
    }
  }

  return Object.freeze({
    mode: "evaluated" as const,
    findings: Object.freeze(retained),
    cost: fatal ? Number.MAX_SAFE_INTEGER : cost,
    supported: !fatal,
  })
}

export function selectEvaluatedCopilotCandidate<
  Candidate extends EvaluatedEndpointCandidate,
>(options: {
  readonly source: ClientDialect
  readonly support: ModelEndpointSupport
  readonly candidates: ReadonlyArray<Candidate>
}): EvaluatedEndpointSelection<Candidate> | EndpointRouteFailure {
  const eligible = options.candidates.filter(
    (candidate) =>
      endpointEnabled(options.support, candidate.endpoint)
      && candidate.check.supported,
  )
  const nativeEndpoint = SOURCE_ENDPOINTS[options.source]
  const native = eligible.find(
    (candidate) => candidate.endpoint === nativeEndpoint,
  )
  const candidate =
    native
    ?? eligible.reduce<Candidate | undefined>((selected, current) => {
      if (!selected || current.check.cost < selected.check.cost) return current
      return selected
    }, undefined)

  if (candidate) {
    const translated = candidate.endpoint !== nativeEndpoint
    return {
      candidate,
      decision: {
        reason: translated ? candidate.reason : "native",
        source: options.source,
        target: candidate.endpoint,
        translated,
      },
    }
  }

  const blockers: Array<string> = []
  const seen = new Set<TranslationFindingClass>()
  for (const evaluatedCandidate of options.candidates) {
    if (!endpointEnabled(options.support, evaluatedCandidate.endpoint)) continue
    for (const finding of evaluatedCandidate.check.findings) {
      if (finding.severity !== "fatal" || seen.has(finding.class)) continue
      seen.add(finding.class)
      blockers.push(finding.class)
    }
  }
  return {
    blockers,
    code: "endpoint_translation_unsupported",
    source: options.source,
  }
}

function getSafeFindingArrayEntries(value: unknown): Array<unknown> {
  try {
    if (util.types.isProxy(value)) return []
    if (!Array.isArray(value)) return []
    if (Object.getPrototypeOf(value) !== Array.prototype) return []
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const entries: Array<unknown> = []
    const length = Math.min(value.length, MAX_EVALUATED_FINDINGS)
    for (let index = 0; index < length; index += 1) {
      const name = String(index)
      if (!Object.hasOwn(descriptors, name)) continue
      const descriptor = descriptors[name]
      if (Object.hasOwn(descriptor, "value")) {
        entries.push(descriptor.value)
      }
    }
    return entries
  } catch {
    return []
  }
}

function getSafeTranslationFinding(
  value: unknown,
): TranslationFinding | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined
    if (util.types.isProxy(value)) return undefined
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      !Object.hasOwn(descriptors, "class")
      || !Object.hasOwn(descriptors, "severity")
    ) {
      return undefined
    }
    const classDescriptor = descriptors.class
    const severityDescriptor = descriptors.severity
    if (
      !Object.hasOwn(classDescriptor, "value")
      || !Object.hasOwn(severityDescriptor, "value")
    ) {
      return undefined
    }
    const findingClass = allowlistedFindingValue(
      classDescriptor.value,
      TRANSLATION_FINDING_CLASSES,
    )
    const severity = allowlistedFindingValue(
      severityDescriptor.value,
      TRANSLATION_FINDING_SEVERITIES,
    )
    if (!findingClass || !severity) return undefined
    return { class: findingClass, severity }
  } catch {
    return undefined
  }
}

function allowlistedFindingValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ?
      (value as T)
    : undefined
}
