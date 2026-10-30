/**
 * Copilot binds replayed Responses state (reasoning and compaction tokens,
 * item IDs, previous response IDs) to the account that produced it, and
 * expires it. Replaying state Copilot cannot accept is rejected with
 * "... does not belong to this connection": a request error the caller can
 * repair, never a sign that the account's credentials were refused.
 */

const OWNERSHIP_REJECTION = /\bdoes not belong to this connection\b/u
const MISMATCH_CODE = "input_item_connection_mismatch"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isServerErrorDiscriminator(value: unknown): boolean {
  return (
    typeof value === "string"
    && (value.includes("internal")
      || value.includes("server")
      || value === "service_unavailable")
  )
}

/** The rejection message when an error body rejects replayed state. */
export function readConnectionOwnershipRejection(
  body: unknown,
): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined
  const { code, message, type } = body.error
  if (isServerErrorDiscriminator(code) || isServerErrorDiscriminator(type)) {
    return undefined
  }
  const text =
    typeof message === "string" ?
      message.toLowerCase().replaceAll(/\s+/gu, " ")
    : ""
  if (code === MISMATCH_CODE) return text
  return OWNERSHIP_REJECTION.test(text) ? text : undefined
}

/**
 * Copilot reports some ownership rejections as 401 or 403. Present them as
 * the 400 request error they are, so routing never treats them as an account
 * rejection and the request layer can remove the state Copilot refused.
 */
export async function normalizeConnectionOwnershipRejection(
  path: string,
  response: Response,
): Promise<Response> {
  if (path !== "/responses") return response
  if (response.status !== 401 && response.status !== 403) return response
  let body: unknown
  try {
    body = JSON.parse(await response.clone().text()) as unknown
  } catch {
    return response
  }
  if (readConnectionOwnershipRejection(body) === undefined) return response
  // Reading the original completes any diagnostic capture of this response.
  const text = await response.text()
  return new Response(text, {
    headers: response.headers,
    status: 400,
    statusText: "Bad Request",
  })
}
