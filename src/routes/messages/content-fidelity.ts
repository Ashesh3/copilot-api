import { isHttpUrl } from "~/lib/attachments"

import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicThinkingBlock,
} from "./anthropic-types"

type TranslationTarget = "chat" | "responses"
type ContentContext = "document" | "message" | "system" | "tool_result"

interface ContentScanState {
  readonly blockers: Array<string>
  nodes: number
  readonly seen: Set<object>
  readonly target: TranslationTarget
}

interface ContentVisit {
  readonly context: ContentContext
  readonly depth: number
  readonly value: unknown
}

const MAX_CONTENT_SCAN_DEPTH = 16
const MAX_CONTENT_SCAN_NODES = 2048
const MAX_CONTENT_ARRAY_LENGTH = MAX_CONTENT_SCAN_NODES
const MESSAGE_FIELDS = new Set(["content", "role"])
const CACHE_CONTROL_FIELDS = new Set(["ttl", "type"])
const CONTENT_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  document: new Set([
    "cache_control",
    "citations",
    "context",
    "source",
    "title",
    "type",
  ]),
  image: new Set(["cache_control", "source", "type"]),
  text: new Set(["cache_control", "text", "type"]),
  thinking: new Set(["cache_control", "signature", "thinking", "type"]),
  tool_reference: new Set(["cache_control", "tool_name", "type"]),
  tool_result: new Set([
    "cache_control",
    "content",
    "is_error",
    "tool_use_id",
    "type",
  ]),
  tool_use: new Set(["cache_control", "id", "input", "name", "type"]),
}
const CITATION_FIELDS = new Set(["enabled"])
const IMAGE_SOURCE_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  base64: new Set(["data", "media_type", "type"]),
  url: new Set(["type", "url"]),
}
const DOCUMENT_SOURCE_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  base64: new Set(["data", "media_type", "type"]),
  content: new Set(["content", "type"]),
  text: new Set(["data", "media_type", "type"]),
  url: new Set(["type", "url"]),
}

function addBlocker(blockers: Array<string>, blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker)
}

function scanUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  blockers: Array<string>,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    addBlocker(blockers, "content_extension")
  }
}

function scanCacheControl(value: unknown, blockers: Array<string>): void {
  if (!isRecord(value)) return
  scanUnknownKeys(value, CACHE_CONTROL_FIELDS, blockers)
  addBlocker(blockers, "content_cache_control")
}

function scanTypedObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  blockers: Array<string>,
): void {
  if (!isRecord(value)) return
  scanUnknownKeys(value, allowed, blockers)
}

export function scanMessagesContent(
  payload: AnthropicMessagesPayload,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  const state: ContentScanState = {
    blockers,
    nodes: 0,
    seen: new Set<object>(),
    target,
  }
  for (const block of Array.isArray(payload.system) ? payload.system : []) {
    scanContentBlock(state, { context: "system", depth: 0, value: block })
  }
  for (const message of payload.messages) {
    scanUnknownKeys(message, MESSAGE_FIELDS, blockers)
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      scanContentBlock(state, { context: "message", depth: 0, value: block })
    }
  }
}

function scanContentBlock(state: ContentScanState, visit: ContentVisit): void {
  const { blockers, target } = state
  const block = enterContentNode(state, visit)
  if (!block) return
  const type = typeof block.type === "string" ? block.type : "unknown"
  const allowed = CONTENT_FIELDS[type]
  if (!allowed) {
    addBlocker(blockers, "content_extension")
    return
  }
  if (!isAllowedInContext(visit.context, type)) {
    addBlocker(blockers, "content_extension")
  }
  scanUnknownKeys(block, allowed, blockers)
  scanCacheControl(block.cache_control, blockers)
  if (
    type === "tool_result"
    && target === "chat"
    && block.is_error !== undefined
  ) {
    addBlocker(blockers, "tool_result.is_error")
  }
  scanContentSemantics(state, block, { depth: visit.depth, type })
}

function isAllowedInContext(context: ContentContext, type: string): boolean {
  if (context === "message") return true
  if (context === "system") return type === "text"
  if (context === "document") return type === "text" || type === "image"
  return (
    type === "text"
    || type === "image"
    || type === "document"
    || type === "tool_reference"
  )
}

function scanContentSemantics(
  state: ContentScanState,
  block: Record<string, unknown>,
  options: { depth: number; type: string },
): void {
  switch (options.type) {
    case "image": {
      scanSource({
        depth: options.depth + 1,
        kind: "image",
        state,
        value: block.source,
      })
      break
    }
    case "document": {
      scanDocument(block, state, options.depth + 1)
      break
    }
    case "tool_result": {
      scanToolResultContent(block.content, state, options.depth + 1)
      break
    }
    case "tool_reference": {
      addBlocker(state.blockers, "tool_reference")
      break
    }
    case "thinking": {
      scanThinkingBlock(
        block as unknown as AnthropicThinkingBlock,
        state.blockers,
        state.target,
      )
      break
    }
    // No default
  }
}

function enterContentNode(
  state: ContentScanState,
  visit: Pick<ContentVisit, "depth" | "value">,
): Record<string, unknown> | undefined {
  if (
    visit.depth > MAX_CONTENT_SCAN_DEPTH
    || !isRecord(visit.value)
    || state.seen.has(visit.value)
  ) {
    addBlocker(state.blockers, "content_extension")
    return undefined
  }
  state.nodes += 1
  if (state.nodes > MAX_CONTENT_SCAN_NODES) {
    addBlocker(state.blockers, "content_extension")
    return undefined
  }
  state.seen.add(visit.value)
  return visit.value
}

function enterContentArray(
  value: Array<unknown>,
  state: ContentScanState,
  depth: number,
): boolean {
  if (
    depth > MAX_CONTENT_SCAN_DEPTH
    || value.length > MAX_CONTENT_ARRAY_LENGTH
    || state.seen.has(value)
  ) {
    addBlocker(state.blockers, "content_extension")
    return false
  }
  state.nodes += 1
  if (state.nodes > MAX_CONTENT_SCAN_NODES) {
    addBlocker(state.blockers, "content_extension")
    return false
  }
  state.seen.add(value)
  return true
}

function scanToolResultContent(
  content: unknown,
  state: ContentScanState,
  depth: number,
): void {
  if (typeof content === "string") return
  if (!Array.isArray(content) || content.length === 0) {
    addBlocker(state.blockers, "content_extension")
    return
  }
  if (!enterContentArray(content, state, depth)) return
  for (const nested of content) {
    scanContentBlock(state, {
      context: "tool_result",
      depth: depth + 1,
      value: nested,
    })
  }
}

function scanDocument(
  block: Record<string, unknown>,
  state: ContentScanState,
  depth: number,
): void {
  const { blockers, target } = state
  scanSource({ depth, kind: "document", state, value: block.source })
  scanTypedObject(block.citations, CITATION_FIELDS, blockers)
  if (target === "chat") {
    addBlocker(blockers, "document")
    return
  }
  if (!isResponsesDocumentSource(block)) addBlocker(blockers, "document.source")
  if (block.context !== undefined && block.context !== null) {
    addBlocker(blockers, "document.context")
  }
  if (block.citations !== undefined && block.citations !== null) {
    addBlocker(blockers, "document.citations")
  }
}

function scanSource(options: {
  depth: number
  kind: "document" | "image"
  state: ContentScanState
  value: unknown
}): void {
  const { blockers } = options.state
  if (!isRecord(options.value)) return
  const type =
    typeof options.value.type === "string" ? options.value.type : "unknown"
  const allowed =
    options.kind === "image" ?
      IMAGE_SOURCE_FIELDS[type]
    : DOCUMENT_SOURCE_FIELDS[type]
  if (!allowed) {
    addBlocker(blockers, "source_extension")
    return
  }
  if (Object.keys(options.value).some((key) => !allowed.has(key))) {
    addBlocker(blockers, "source_extension")
  }
  if (options.kind !== "document" || type !== "content") return
  if (!Array.isArray(options.value.content)) return
  if (!enterContentArray(options.value.content, options.state, options.depth)) {
    return
  }
  for (const nested of options.value.content) {
    scanContentBlock(options.state, {
      context: "document",
      depth: options.depth + 1,
      value: nested,
    })
  }
}

function isResponsesDocumentSource(block: Record<string, unknown>): boolean {
  const source = (block as unknown as AnthropicDocumentBlock).source
  if (!isRecord(source)) return false
  if (source.type === "url") {
    return (
      hasExactlyKeys(source, ["type", "url"])
      && typeof source.url === "string"
      && isAbsoluteHttpUrl(source.url)
    )
  }
  return (
    source.type === "base64"
    && hasExactlyKeys(source, ["data", "media_type", "type"])
    && typeof source.media_type === "string"
    && source.media_type.toLowerCase().split(";")[0].trim()
      === "application/pdf"
    && typeof source.data === "string"
  )
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  )
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (
    !isHttpUrl(value)
    || hasUnsafeRawUrlCharacter(value)
    || hasInvalidPercentEncoding(value)
  ) {
    return false
  }
  try {
    const url = new URL(value)
    const authority = rawUrlAuthority(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
      && url.username.length === 0
      && url.password.length === 0
      && isValidRawHttpAuthority(authority, url.hostname, url.protocol)
      && matchesCanonicalHttpUrl(value, url)
    )
  } catch {
    return false
  }
}

function hasUnsafeRawUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (
      character === "\\"
      || code === undefined
      || code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
      || character.trim().length === 0
    ) {
      return true
    }
  }
  return false
}

function hasInvalidPercentEncoding(value: string): boolean {
  for (
    let index = value.indexOf("%");
    index >= 0;
    index = value.indexOf("%", index + 1)
  ) {
    if (!/^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) return true
  }
  return false
}

function rawUrlAuthority(value: string): string {
  const authorityStart = value.startsWith("https://") ? 8 : 7
  const authorityEnd = findFirstDelimiter(value, authorityStart)
  return value.slice(authorityStart, authorityEnd)
}

function isValidRawHttpAuthority(
  authority: string,
  parsedHostname: string,
  protocol: string,
): boolean {
  if (authority.length === 0 || authority.includes("@")) return false
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]")
    if (closingBracket <= 1) return false
    return authority === new URL(`${protocol}//${authority}`).host
  }
  const firstColon = authority.indexOf(":")
  const lastColon = authority.lastIndexOf(":")
  if (firstColon !== lastColon) return false
  const hostname = firstColon < 0 ? authority : authority.slice(0, firstColon)
  const portSuffix = firstColon < 0 ? "" : authority.slice(firstColon)
  return (
    isValidRawHostname(hostname)
    && isValidRawPortSuffix(portSuffix)
    && (!isCanonicalIpv4Address(parsedHostname) || hostname === parsedHostname)
  )
}

function isValidRawHostname(hostname: string): boolean {
  const withoutTrailingDot =
    hostname.endsWith(".") ? hostname.slice(0, -1) : hostname
  if (/^[\d.]+$/.test(withoutTrailingDot)) {
    const octets = withoutTrailingDot.split(".")
    return (
      octets.length === 4
      && octets.every(
        (octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255,
      )
    )
  }
  return (
    withoutTrailingDot.length > 0
    && withoutTrailingDot.length <= 253
    && withoutTrailingDot
      .split(".")
      .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  )
}

function isValidRawPortSuffix(value: string): boolean {
  if (value.length === 0) return true
  const port = value.slice(1)
  return /^\d{1,5}$/.test(port) && Number(port) <= 65_535
}

function isCanonicalIpv4Address(value: string): boolean {
  return value.split(".").length === 4 && isValidRawHostname(value)
}

function matchesCanonicalHttpUrl(value: string, url: URL): boolean {
  const authorityEnd = findFirstDelimiter(value, url.protocol.length + 2)
  const rawPathAndSuffix = value.slice(authorityEnd)
  const canonicalAuthorityEnd = findFirstDelimiter(
    url.href,
    url.protocol.length + 2,
  )
  const canonicalPathAndSuffix = url.href.slice(canonicalAuthorityEnd)
  if (rawPathAndSuffix.length === 0) return canonicalPathAndSuffix === "/"
  if (rawPathAndSuffix.startsWith("?") || rawPathAndSuffix.startsWith("#")) {
    return canonicalPathAndSuffix === `/${rawPathAndSuffix}`
  }
  return rawPathAndSuffix === canonicalPathAndSuffix
}

function findFirstDelimiter(value: string, start: number): number {
  const indexes = ["/", "?", "#"]
    .map((delimiter) => value.indexOf(delimiter, start))
    .filter((index) => index >= 0)
  return indexes.length === 0 ? value.length : Math.min(...indexes)
}

function scanThinkingBlock(
  block: AnthropicThinkingBlock,
  blockers: Array<string>,
  target: TranslationTarget,
): void {
  const signature = block.signature
  if (!signature) {
    if (target === "responses") addBlocker(blockers, "thinking_signature")
    return
  }
  const hasResponsesItemId = isResponsesThinkingSignature(signature)
  if (
    (target === "responses" && !hasResponsesItemId)
    || (target === "chat" && hasResponsesItemId)
  ) {
    addBlocker(blockers, "thinking_signature")
  }
}

function isResponsesThinkingSignature(signature: string): boolean {
  const parts = signature.split("@")
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
