// Types mirror the payload shapes produced by src/routes/dashboard/api.ts
// and src/routes/dashboard/llm-debug-replay.ts. Keep these in sync when the
// server-side handlers change shape.

export interface Overview {
  activeSessions: number
  codeSessionsCount: number
  directConnectCount: number
  environmentsCount: number
  flagsCount: number
  uptime: string
  health: string
}

export type SessionType = "code-session" | "direct-connect"
export type SessionState = "idle" | "running" | "requires_action" | "connected"

export interface Session {
  id: string
  title: string
  state: SessionState
  type: SessionType
  createdAt: number
  lastHeartbeat: number | null
  tags: Array<string>
}

export interface SessionEvent {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
  is_compaction?: boolean
  agent_id?: string
}

export interface Environment {
  id: string
  machineName: string
  directory: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  createdAt: number
  pendingWorkCount: number
}

export type FlagApplication = "claudeCode" | "chatgptCodex"
export type FlagValue = boolean | string | number | Record<string, unknown>
export type FlagsMap = Record<string, FlagValue>
export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigDynamicConfig = Record<string, unknown>

export interface StatsigOverrides {
  featureGates: Record<string, boolean>
  dynamicConfigs: Record<string, StatsigDynamicConfig>
}

export interface Replacement {
  id: string
  name?: string
  pattern: string
  replacement: string
  isRegex: boolean
  enabled: boolean
  isSystem?: boolean
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type RedirectSourceEffort = "all" | "default" | ReasoningEffort
export type RedirectTargetEffort = ReasoningEffort

export interface ModelRedirectConflict {
  id: string
  name?: string
}

export interface ModelRedirect {
  id: string
  name?: string
  sourceModel: string
  sourceEffort: RedirectSourceEffort
  targetModel: string
  targetEffort?: RedirectTargetEffort
  enabled: boolean
  conflicts: Array<ModelRedirectConflict>
}

export type ModelRequestParameter = "temperature" | "top_p"

export interface ModelSetting {
  model: string
  sentryModelName?: string
  supportedReasoningEfforts?: Array<ReasoningEffort>
  defaultReasoningEffort?: ReasoningEffort
  implicitReasoningDefault?: boolean
  exposeVirtualReasoningModels?: boolean
  supportsAssistantPrefill?: boolean
  unsupportedRequestParameters?: Array<ModelRequestParameter>
}

export type CustomProviderModelKind = "chat" | "embedding"

export interface CustomProviderModel {
  id: string
  aliases?: Array<string>
  kind: CustomProviderModelKind
  dimensions?: number
  supportsStreaming?: boolean
  passReasoningEffort?: boolean
}

export interface CustomProvider {
  id: string
  name: string
  type: "openai-compatible"
  baseUrl: string
  apiKeyConfigured: boolean
  apiKeyEnv?: string
  headerNames: Array<string>
  models: Array<CustomProviderModel>
  passReasoningEffort?: boolean
}

export interface ModelRoutingAccount {
  id: number
  accountType: string
  healthy: boolean
  modelsCount: number
}

export interface ModelRoutingModelAccount {
  accountId: number
  enabled: boolean
}

export interface ModelRoutingModel {
  id: string
  name: string
  vendor: string
  preview: boolean
  accounts: Array<ModelRoutingModelAccount>
}

export interface ModelRouting {
  multiToken: boolean
  accounts: Array<ModelRoutingAccount>
  models: Array<ModelRoutingModel>
}

export interface UsageSection {
  utilization?: number
  tokens_used?: number
  request_count?: number
  resets_at?: number
  total_tokens?: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_requests?: number
  first_request_at?: number | null
}

export type UsageData = Record<string, UsageSection>

export interface IpAllowlistEntry {
  ip: string
  enabled: boolean
  source: "dashboard" | "manual"
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}

export interface LlmDebugEntry {
  id: string
  method: string
  path: string
  model?: string
  requestId?: string
  requestPreview: string
  requestBodyBytes: number
  responsePreview?: string
  responseBodyBytes?: number
  responseContentType?: string
  responseStatus?: number
  responseStatusText?: string
  errorMessage?: string
  startedAt: string
  durationMs?: number
  endedAt?: string
  status: "pending" | "complete" | "error" | "aborted"
  stream?: boolean
}

export interface LlmDebugLogError {
  message: string
  name: string
  stack?: string
}

export interface LlmDebugLogRequest {
  body: string | null
  bodyBytes: number
  headers: Record<string, string>
  method: string
  path: string
  url: string
}

export interface LlmDebugLogResponse {
  body: string | null
  bodyBytes: number
  bodyReadError?: LlmDebugLogError
  headers: Record<string, string>
  status: number
  statusText: string
}

export interface LlmDebugDetail {
  id: string
  model?: string
  requestId?: string
  request: LlmDebugLogRequest
  response?: LlmDebugLogResponse
  error?: LlmDebugLogError
  startedAt: string
  startedAtMs: number
  durationMs?: number
  endedAt?: string
  status: "pending" | "complete" | "error" | "aborted"
  stream?: boolean
}

export interface ReplayStreamEvent {
  data: unknown
  rawData: string
  event?: string
  id?: string
  retry?: number
}

export interface ReplayResult {
  body: string
  durationMs: number
  finishReason: string | null
  headers: Record<string, string>
  parsed: unknown
  responseId: string | null
  status: number
  statusText: string
  streamEvents: Array<ReplayStreamEvent>
  usage: unknown
}

export interface SettingsData {
  version: string
  port: string
  host: string
  authEnabled: boolean
  multiToken: boolean
  sentryEnabled: boolean
  groqEnabled: boolean
  dataDir: string
  debug: boolean
  verbose: boolean
  codexCleanupModel: string | null
  codexCleanupModelDefault: string | undefined
  availableModels: Array<string>
}
