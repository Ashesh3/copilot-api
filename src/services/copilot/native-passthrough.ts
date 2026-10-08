import { routedFetch } from "~/lib/account-router"
import { HTTPError } from "~/lib/error"

/** Copilot APIs whose JSON responses the gateway relays without translation. */
export type NativeCopilotEndpoint =
  | "/v1/decisions"
  | "/v1/images/edits"
  | "/v1/images/generations"

export interface NativeCopilotRequest {
  body: string | Uint8Array<ArrayBuffer>
  contentType: string
  endpoint: NativeCopilotEndpoint
  model: string
  signal?: AbortSignal
}

export interface NativeCopilotUsage {
  inputTokens: number
  outputTokens: number
}

export interface NativeCopilotResult {
  body: Uint8Array<ArrayBuffer>
  contentType: string
  usage?: NativeCopilotUsage
}

const FAILURE_MESSAGES: Record<NativeCopilotEndpoint, string> = {
  "/v1/decisions": "Failed to create decisions",
  "/v1/images/edits": "Failed to edit images",
  "/v1/images/generations": "Failed to generate images",
}

function tokenCount(value: unknown): number | undefined {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : undefined
}

/** Decisions and Images both report `usage.input_tokens` and `output_tokens`. */
function readUsage(body: Uint8Array): NativeCopilotUsage | undefined {
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
export async function forwardNativeCopilotRequest(
  request: NativeCopilotRequest,
): Promise<NativeCopilotResult> {
  const { response } = await routedFetch(
    request.endpoint,
    { method: "POST", body: request.body, signal: request.signal },
    {
      modelId: request.model,
      headerOptions: { contentType: request.contentType },
    },
  )
  if (!response.ok)
    throw new HTTPError(FAILURE_MESSAGES[request.endpoint], response)

  const body = new Uint8Array(await response.arrayBuffer())
  return {
    body,
    contentType: response.headers.get("content-type") ?? "application/json",
    usage: readUsage(body),
  }
}
