export type InterceptDirection = "both" | "request" | "response"

export type InterceptPhase = "request" | "response"

export type InterceptTimeoutAction = "forward" | "drop"

export type InterceptFilterField =
  | "sessionId"
  | "model"
  | "path"
  | "upstream"
  | "requestBody"
  | "responseBody"
  | "header"
  | "direction"

export type InterceptFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "regex"
  | "starts_with"

export interface InterceptFilterCondition {
  id: string
  enabled: boolean
  field: InterceptFilterField
  /** Used when field === "header" (case-insensitive header name). */
  headerName?: string
  operator: InterceptFilterOperator
  value: string
  caseSensitive?: boolean
}

export interface InterceptFilterConfig {
  enabled: boolean
  matchMode: "all" | "any"
  conditions: Array<InterceptFilterCondition>
}

export type InterceptInstructionMode = "shared" | "separate"

/** Directions in which Autopilot applies the assistant's changes and forwards. */
export type InterceptAutopilot = "off" | InterceptDirection

export interface InterceptAssistantConfig {
  enabled: boolean
  /** Auto-run assistant LLM as soon as an item is intercepted. */
  autoRun: boolean
  /**
   * Run the assistant on every held item in these directions, apply all of its
   * changes, and forward without operator review. Failed runs stay held.
   */
  autopilot: InterceptAutopilot
  model: string
  instructionMode: InterceptInstructionMode
  sharedInstruction: string
  requestInstruction: string
  responseInstruction: string
}

export interface InterceptConfig {
  enabled: boolean
  direction: InterceptDirection
  /** Timeout in seconds before pending items auto-resolve (15–3600). */
  timeoutSeconds: number
  timeoutAction: InterceptTimeoutAction
  filters: InterceptFilterConfig
  assistant: InterceptAssistantConfig
}

export type CanonicalProtocol =
  | "chat_completions"
  | "responses"
  | "anthropic_messages"
  | "generic_json"
  | "raw_text"

export type CanonicalItemKind =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "other"

export interface CanonicalItem {
  /** Stable addressable ID for diffs, e.g. "sys-0", "msg-3", "tc-1", "out-0". */
  id: string
  kind: CanonicalItemKind
  role?: string
  label: string
  content: string
  /** Tool name for tool_call / tool_result items. */
  toolName?: string
  /** Tool call ID for correlation. */
  toolCallId?: string
  /** JSON-formatted arguments for tool_call items. */
  toolArguments?: string
  /**
   * Read-only node (signed thinking, encrypted reasoning, images, documents,
   * unknown blocks). It is preserved verbatim and may be deleted, but its
   * content cannot be edited. `content` is a short placeholder, never the raw node.
   */
  opaque?: boolean
}

export interface CanonicalView {
  protocol: CanonicalProtocol
  phase: InterceptPhase
  model?: string
  stream?: boolean
  stopReason?: string
  items: Array<CanonicalItem>
  /** True if structured edits can be cleanly written back to the raw payload. */
  editable: boolean
  /** Why structured edits are unavailable when `editable` is false. */
  readOnlyReason?: string
  note?: string
}

export type AssistantDiffOp =
  | {
      op: "replace"
      id: string
      content?: string
      toolName?: string
      toolArguments?: string
      reason?: string
    }
  | {
      op: "delete"
      id: string
      reason?: string
    }
  | {
      op: "insert_after"
      afterId: string | null
      kind: Exclude<CanonicalItemKind, "other">
      content: string
      toolName?: string
      toolCallId?: string
      toolArguments?: string
      reason?: string
    }

export interface AssistantSuggestion {
  id: string
  createdAt: string
  model: string
  summary: string
  operations: Array<AssistantDiffOp>
  /** Raw preview of the resulting body if all operations are applied. */
  previewBody: string | null
  /** Resulting canonical items after applying operations. */
  previewCanonical: CanonicalView | null
  error?: string
  durationMs: number
  /** Item revision the assistant read; applying it to a newer revision is refused. */
  revision: number
}

export type InterceptItemStatus =
  | "pending"
  | "forwarded"
  | "dropped"
  | "timed_out"
  | "aborted"

export interface InterceptPendingItem {
  id: string
  phase: InterceptPhase
  status: InterceptItemStatus
  createdAt: string
  createdAtMs: number
  expiresAtMs: number
  resolvedAt?: string
  modified: boolean
  /** Incremented on every server-side edit; suggestions are bound to it. */
  revision: number
  /** Upstream metadata */
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  model?: string
  sessionId?: string
  requestId?: string
  stream?: boolean
  /** Response metadata (only for phase === "response") */
  responseStatus?: number
  responseStatusText?: string
  responseContentType?: string
  /** Headers & bodies */
  headers: Record<string, string>
  originalBody: string
  currentBody: string
  /** For response phase: summary of the triggering request so assistant/user have full context */
  requestContext?: {
    method: string
    path: string
    model?: string
    body: string
    canonical: CanonicalView
  }
  /** Parsed structured view of currentBody */
  canonical: CanonicalView
  /** Assistant LLM suggestion state */
  assistantStatus: "idle" | "running" | "ready" | "error"
  assistantSuggestion?: AssistantSuggestion
  assistantError?: string
  /** Autopilot applied the assistant's changes and forwarded this item. */
  autopilot?: boolean
}

export interface InterceptItemSummary {
  id: string
  phase: InterceptPhase
  status: InterceptItemStatus
  createdAt: string
  createdAtMs: number
  expiresAtMs: number
  modified: boolean
  method: string
  path: string
  upstream: "copilot" | "custom"
  providerId?: string
  model?: string
  sessionId?: string
  stream?: boolean
  responseStatus?: number
  bodyBytes: number
  itemCount: number
  preview: string
  assistantStatus: InterceptPendingItem["assistantStatus"]
  assistantOpCount: number
  autopilot: boolean
}

export interface InterceptSnapshot {
  config: InterceptConfig
  pending: Array<InterceptItemSummary>
  recent: Array<InterceptItemSummary>
  stats: {
    pendingCount: number
    forwardedCount: number
    droppedCount: number
    modifiedCount: number
  }
}

export const DEFAULT_INTERCEPT_CONFIG: InterceptConfig = {
  enabled: false,
  direction: "both",
  timeoutSeconds: 300,
  timeoutAction: "forward",
  filters: {
    enabled: false,
    matchMode: "all",
    conditions: [],
  },
  assistant: {
    enabled: false,
    autoRun: true,
    autopilot: "off",
    model: "",
    instructionMode: "shared",
    sharedInstruction: "",
    requestInstruction: "",
    responseInstruction: "",
  },
}
