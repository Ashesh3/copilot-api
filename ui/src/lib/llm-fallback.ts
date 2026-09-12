import type { LlmDebugFallback, LlmDebugFallbackObservation } from "./types"

export interface LlmFallbackContext {
  fallback?: LlmDebugFallback
  fallbackObservations?: Array<LlmDebugFallbackObservation>
}

export interface LlmFallbackIndicator {
  key: string
  label: string
  description: string
  tone: "warning" | "success" | "info" | "neutral"
  previousLogId?: string
}

export function fallbackDescription(fallback: LlmDebugFallback): string {
  const route =
    fallback.configuredTargetModel === fallback.targetModel ?
      `${fallback.fromModel} → ${fallback.targetModel}`
    : `${fallback.fromModel} → ${fallback.configuredTargetModel} → ${fallback.targetModel} (Model Redirect)`
  const hop =
    fallback.hop > 1 ?
      ` Fallback hop ${fallback.hop}, originally requested ${fallback.sourceModel}.`
    : ""
  return fallback.cached ?
      `This request uses the conversation's remembered configured HTTP 422 fallback: ${route}.${hop} No new HTTP 422 was required for this request.`
    : `A configured gateway rule sent this request because ${fallback.fromModel} returned HTTP 422. ${route}.${hop}`
}

function observationIndicator(
  observation: LlmDebugFallbackObservation,
): LlmFallbackIndicator {
  const key = JSON.stringify(observation)
  // eslint-disable-next-line default-case -- The observation union is exhaustive.
  switch (observation.kind) {
    case "requested": {
      const targets =
        observation.targetModels === "default" ?
          "the server-defined default fallback"
        : observation.targetModels.join(" → ")
      return {
        key,
        label: "Fallback requested",
        description: `The request asked for ${targets} if ${observation.sourceModel} declines. This policy does not confirm that a model switch occurred.`,
        tone: "neutral",
      }
    }
    case "upstream": {
      return {
        key,
        label: "Upstream fallback",
        description: `The upstream response contains a fallback block reporting ${observation.fromModel} → ${observation.targetModel}. This is explicit response evidence of a switch within that request.`,
        tone: "success",
      }
    }
    case "client": {
      return {
        key,
        label: "Client retry (inferred)",
        description: `The next request in the same session sent the same content after a refusal, changing the requested model: ${observation.fromModel} → ${observation.targetModel}. These are client-requested models; gateway routing may select a different upstream model. This suggests a client retry; the captures cannot establish whether it was automatic or manual.`,
        tone: "info",
        previousLogId: observation.previousLogId,
      }
    }
  }
}

export function fallbackIndicators({
  fallback,
  fallbackObservations,
}: LlmFallbackContext): Array<LlmFallbackIndicator> {
  const indicators: Array<LlmFallbackIndicator> = []
  if (fallback) {
    indicators.push({
      key: "configured",
      label:
        fallback.cached ?
          "Configured fallback · cached"
        : "Configured fallback",
      description: fallbackDescription(fallback),
      tone: "warning",
    })
  }
  for (const observation of fallbackObservations ?? []) {
    indicators.push(observationIndicator(observation))
  }
  return indicators
}

export function fallbackSearchText(context: LlmFallbackContext): string {
  const indicators = fallbackIndicators(context)
  if (indicators.length === 0) return ""
  return [
    "fallback",
    context.fallback?.sourceModel ?? "",
    ...indicators.map(
      (indicator) => `${indicator.label} ${indicator.description}`,
    ),
  ]
    .join(" ")
    .toLowerCase()
}
