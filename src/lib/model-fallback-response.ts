export type ModelFallbackReason = "http_422" | "refusal" | "content_filter"

type BufferedFallbackReason = Exclude<ModelFallbackReason, "http_422">

export class ModelFallbackResponseError extends Error {
  readonly response: Response
  readonly reason: BufferedFallbackReason

  constructor(response: Response, reason: BufferedFallbackReason) {
    super(`Upstream inference ended with ${reason}`)
    this.response = response
    this.reason = reason
  }
}

interface ResponseOutcome {
  reason?: BufferedFallbackReason
  successful: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messagesOutcome(body: Record<string, unknown>): ResponseOutcome {
  if (body.type !== "message") return { successful: false }
  if (body.stop_reason === "refusal")
    return { reason: "refusal", successful: false }
  return {
    successful:
      typeof body.stop_reason === "string"
      && body.stop_reason.length > 0
      && Array.isArray(body.content)
      && (body.error === undefined || body.error === null),
  }
}

function responsesOutcome(body: Record<string, unknown>): ResponseOutcome {
  if (body.object !== "response") return { successful: false }
  if (
    body.status === "incomplete"
    && isRecord(body.incomplete_details)
    && body.incomplete_details.reason === "content_filter"
  )
    return { reason: "content_filter", successful: false }
  return {
    // Some compatible buffered Responses/compaction results omit status.
    successful:
      (body.status === "completed" || body.status === undefined)
      && Array.isArray(body.output)
      && (body.error === undefined || body.error === null),
  }
}

/** Inspect buffered inference results before their client response is committed. */
export async function inspectModelFallbackResponse(
  response: Response,
  endpoint: string | undefined,
  signal?: AbortSignal | null,
): Promise<ResponseOutcome> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase()
  if (
    (endpoint !== "/v1/messages" && endpoint !== "/responses")
    || contentType !== "application/json"
  )
    return { successful: true }

  signal?.throwIfAborted()
  let body: unknown
  try {
    body = await response.clone().json()
  } catch (error) {
    // Leave malformed JSON to the existing endpoint parser; never remember it.
    if (error instanceof SyntaxError) return { successful: false }
    throw error
  }
  signal?.throwIfAborted()
  if (!isRecord(body)) return { successful: false }
  return endpoint === "/v1/messages" ?
      messagesOutcome(body)
    : responsesOutcome(body)
}
