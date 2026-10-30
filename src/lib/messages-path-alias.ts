/**
 * Anthropic SDKs append `/v1/messages` to their configured base URL. Factory
 * Droid hands a custom model's `baseUrl` to that SDK unchanged, so the
 * OpenAI-style `https://host/v1` base its OpenAI models need becomes
 * `/v1/v1/messages` for its Anthropic models. Only the two Messages endpoints
 * are aliased; every other doubled path keeps its normal 404.
 */
const DOUBLED_MESSAGES_PATH = /^\/v1(\/v1\/messages(?:\/count_tokens)?)$/

/** Return the canonical Messages path for a doubled `/v1/v1/...` request. */
export function resolveDoubledMessagesPath(path: string): string | undefined {
  return DOUBLED_MESSAGES_PATH.exec(path)?.[1]
}
