import { routedFetch } from "~/lib/account-router"
import { HTTPError } from "~/lib/error"

export const COPILOT_DECISIONS_ENDPOINT = "/v1/decisions"

/**
 * Copilot's OpenAI-compatible Decisions request. The gateway reads only the
 * routing and validation fields; questions and future fields stay native JSON.
 */
export interface DecisionsRequest {
  [key: string]: unknown
  model: string
  questions: Array<Record<string, unknown>>
}

export interface DecisionsUsage {
  inputTokens: number
  outputTokens: number
}

export interface DecisionsResult {
  body: Uint8Array<ArrayBuffer>
  contentType: string
  usage?: DecisionsUsage
}

function tokenCount(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

function readDecisionsUsage(body: Uint8Array): DecisionsUsage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || !("usage" in parsed))
    return undefined
  const usage = parsed.usage
  if (typeof usage !== "object" || usage === null) return undefined
  const inputTokens = tokenCount(
    (usage as Record<string, unknown>).input_tokens,
  )
  const outputTokens = tokenCount(
    (usage as Record<string, unknown>).output_tokens,
  )
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

/** Returns Copilot's response bytes unchanged; decimals such as 1.0 survive. */
export async function createDecisions(
  payload: DecisionsRequest,
  options?: { signal?: AbortSignal },
): Promise<DecisionsResult> {
  const { response } = await routedFetch(
    COPILOT_DECISIONS_ENDPOINT,
    { method: "POST", body: JSON.stringify(payload), signal: options?.signal },
    { modelId: payload.model },
  )
  if (!response.ok) throw new HTTPError("Failed to create decisions", response)

  const body = new Uint8Array(await response.arrayBuffer())
  return {
    body,
    contentType: response.headers.get("content-type") ?? "application/json",
    usage: readDecisionsUsage(body),
  }
}
