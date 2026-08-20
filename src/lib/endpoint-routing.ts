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
