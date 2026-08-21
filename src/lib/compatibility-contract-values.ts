export interface CompatibilityContractRow {
  behavior: string
  surface: string
}

export const ANTHROPIC_HTTP_ERROR_STATUS_TYPES = [
  { status: 400, type: "invalid_request_error" },
  { status: 401, type: "authentication_error" },
  { status: 403, type: "permission_error" },
  { status: 404, type: "not_found_error" },
  { status: 413, type: "request_too_large" },
  { status: 429, type: "rate_limit_error" },
  { status: 500, type: "api_error" },
] as const

export const STREAM_BEHAVIOR_CONTRACT = [
  {
    surface: "Messages handled HTTP failure",
    behavior: `error event with ${ANTHROPIC_HTTP_ERROR_STATUS_TYPES.map(({ type }) => type).join(", ")}`,
  },
  {
    surface: "Synthetic Responses-from-Messages failure",
    behavior: "error then response.failed",
  },
  {
    surface: "Native Responses terminal families",
    behavior:
      "sanitized response.completed, response.incomplete, response.failed, error",
  },
  {
    surface: "Thrown native Chat transport failure",
    behavior: "written chunks then close without synthesized error event",
  },
  {
    surface: "Thrown native Responses transport failure",
    behavior: "buffered unwritten chunks may be absent when the stream closes",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>

export const SESSION_TOKEN_PRIVACY_CONTRACT = [
  {
    surface: "Administrator-only LLM Debug",
    behavior: "exact forwarded token may be captured",
  },
  {
    surface: "Ordinary handler logs",
    behavior: "session token value is redacted",
  },
  {
    surface: "Configuration export",
    behavior: "token-keyed values are redacted",
  },
  {
    surface: "Inference forwarding",
    behavior:
      "multi-account mode also requires issuer proof for the selected account",
  },
  {
    surface: "Token-required control plane",
    behavior:
      "issuer mismatch or unknown proof is rejected locally without upstream send",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>

export const ERROR_ENVELOPE_CONTRACT = [
  {
    surface: "Chat and Responses HTTP",
    behavior: "OpenAI/Copilot envelope with fixed safe message",
  },
  {
    surface: "/v1/messages and /v1/messages/count_tokens",
    behavior: "Anthropic envelope with fixed safe message",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>

// These recovery targets supersede current behavior. They intentionally remain
// independent from the behavior-derived contract rows until their runtime work
// and documentation reconciliation are complete.
export const RECOVERY_TARGET_CONTRACT = [
  {
    surface: "Final non-empty upstream HTTP error body",
    behavior:
      "exact in normal client, ordinary logs, and Sentry; preserve upstream status and content type",
  },
  {
    surface: "Runtime-valid absolute HTTP(S) attachment/file URL",
    behavior:
      "fetchable without destination, DNS, IP, or redirect-target filtering; abort, time, byte, and redirect limits remain",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>
