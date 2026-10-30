/**
 * Copilot refuses a prompt over the model's input limit in two ways: its own
 * preflight answers `model_max_prompt_tokens_exceeded` with "prompt token
 * count of N exceeds the limit of M", and a provider refusal arrives as
 * `invalid_request_body` with the provider's context-window message.
 */

export interface ContextOverflow {
  readonly message: string
  /** Present when Copilot reports its count and limit. */
  readonly promptTokens?: number
  readonly limit?: number
}

const OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "model_max_prompt_tokens_exceeded",
])
const OVERFLOW_MESSAGE =
  /\b(?:exceeds the context window|maximum context length|context_length_exceeded)\b/iu
const PROMPT_COUNT = /prompt token count of (\d+) exceeds the limit of (\d+)/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The overflow a Copilot error body reports, if it reports one. */
export function readContextOverflow(
  status: number,
  body: unknown,
): ContextOverflow | undefined {
  if (status !== 400 && status !== 413) return undefined
  if (!isRecord(body) || !isRecord(body.error)) return undefined
  const { code, message } = body.error
  const text = typeof message === "string" ? message : ""
  const overflow =
    (typeof code === "string" && OVERFLOW_CODES.has(code))
    || (code === "invalid_request_body" && OVERFLOW_MESSAGE.test(text))
  if (!overflow) return undefined
  const counts = PROMPT_COUNT.exec(text)
  return {
    message: text,
    ...(counts ?
      { promptTokens: Number(counts[1]), limit: Number(counts[2]) }
    : {}),
  }
}

export function readContextOverflowText(
  status: number,
  bodyText: string | undefined,
): ContextOverflow | undefined {
  if (bodyText === undefined) return undefined
  try {
    return readContextOverflow(status, JSON.parse(bodyText) as unknown)
  } catch {
    return undefined
  }
}

export async function readContextOverflowResponse(
  response: Response,
): Promise<ContextOverflow | undefined> {
  if (response.ok) return undefined
  return readContextOverflowText(
    response.status,
    await response
      .clone()
      .text()
      .catch(() => undefined),
  )
}
