export interface WebFetchInput {
  url: string
  raw?: boolean
  start_index?: number
  max_length?: number
}
export interface WebFetchLimits {
  maxBytes?: number
  maxRedirects?: number
  timeoutMs?: number
  allowedDomains?: ReadonlyArray<string>
  blockedDomains?: ReadonlyArray<string>
  maxContentTokens?: number
}
export interface PageLink {
  id: number
  url: string
  text: string
}
export interface WebDocument {
  requestedUrl: string
  url: string
  title: string
  status: number
  mediaType: string
  retrievedAt: string
  text: string
  rawBody: string
  links: ReadonlyArray<PageLink>
}
export type WebFetchErrorCode =
  | "invalid_tool_input"
  | "url_not_allowed"
  | "url_not_accessible"
  | "too_many_requests"
  | "unsupported_content_type"
  | "content_too_large"
  | "redirect_limit"
  | "timeout"
  | "unavailable"
  | "max_uses_exceeded"
export interface WebFetchFailure {
  ok: false
  code: WebFetchErrorCode
  url: string
  message: string
  status?: number
}
export interface WebFetchSuccess {
  ok: true
  document: WebDocument
  content: string
  full_length: number
  next_start_index: number | null
  warnings: ReadonlyArray<string>
}
export type WebFetchResult = WebFetchSuccess | WebFetchFailure
export interface WebFetchOptions {
  signal?: AbortSignal
  limits?: WebFetchLimits
  request?: (url: URL, init: RequestInit) => Promise<Response>
  now?: () => Date
}
