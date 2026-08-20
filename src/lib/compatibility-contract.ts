import type { CompatibilityContractRow } from "~/lib/compatibility-contract-values"
import type { Model } from "~/services/copilot/get-models"

import { selectGoogleUpstreamEndpoint } from "~/routes/google-ai/handler"

export {
  ANTHROPIC_HTTP_ERROR_STATUS_TYPES,
  ERROR_ENVELOPE_CONTRACT,
  SESSION_TOKEN_PRIVACY_CONTRACT,
  STREAM_BEHAVIOR_CONTRACT,
} from "~/lib/compatibility-contract-values"

interface GoogleRoutingCase {
  endpoints: ReadonlyArray<string> | undefined
  surface: string
  vendor: string
}

export const GOOGLE_ROUTING_CASES = [
  {
    surface: "Ordinary text with Chat advertised",
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    vendor: "openai",
  },
  {
    surface:
      "Non-Anthropic, Chat unavailable; Responses and Messages advertised",
    endpoints: ["/v1/messages", "/responses"],
    vendor: "openai",
  },
  {
    surface: "Anthropic, Chat unavailable; Responses and Messages advertised",
    endpoints: ["/v1/messages", "/responses"],
    vendor: "anthropic",
  },
  {
    surface: "Messages-only and lossless",
    endpoints: ["/v1/messages"],
    vendor: "anthropic",
  },
  {
    surface: "Chat-only",
    endpoints: ["/chat/completions"],
    vendor: "openai",
  },
  {
    surface: "Legacy omitted endpoint metadata",
    endpoints: undefined,
    vendor: "openai",
  },
  {
    surface: "No compatible advertised endpoint",
    endpoints: [],
    vendor: "openai",
  },
] as const satisfies ReadonlyArray<GoogleRoutingCase>

function modelForGoogleRoutingCase(options: GoogleRoutingCase): Model {
  return {
    id: "model-placeholder",
    name: "Model Placeholder",
    object: "model",
    preview: false,
    vendor: options.vendor,
    version: "1",
    model_picker_enabled: true,
    supported_endpoints:
      options.endpoints === undefined ? undefined : [...options.endpoints],
    capabilities: {
      family: options.vendor === "anthropic" ? "claude" : "placeholder",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

export function getGoogleRoutingContractRows(): Array<CompatibilityContractRow> {
  return GOOGLE_ROUTING_CASES.map((routingCase) => {
    const decision = selectGoogleUpstreamEndpoint({
      payload: {
        model: "model-placeholder",
        messages: [{ role: "user", content: "hello" }],
      },
      selectedModel: modelForGoogleRoutingCase(routingCase),
    })
    return {
      surface: routingCase.surface,
      behavior: "code" in decision ? decision.code : decision.target,
    }
  })
}
