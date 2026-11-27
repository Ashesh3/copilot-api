import consola from "consola"
import { randomUUID } from "node:crypto"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { LocalHTTPError } from "~/lib/error"
import { getClientSessionId, getRequestId } from "~/lib/request-session"

import type {
  InterceptAssistantResult,
  InterceptAssistantRunner,
} from "./assistant"
import type {
  AssistantDiffOp,
  CanonicalItem,
  InterceptAssistantConfig,
  InterceptConfig,
  InterceptFilterConfig,
  InterceptItemStatus,
  InterceptItemSummary,
  InterceptPendingItem,
  InterceptPhase,
  InterceptSnapshot,
} from "./types"

import {
  isInterceptBypassed,
  resolveAssistantInstruction,
  runInterceptAssistant,
  validateDiffOps,
} from "./assistant"
import {
  applyCanonicalDiffOps,
  extractModelFromBody,
  parseCanonicalView,
  serializeCanonicalItemsToBody,
} from "./canonical"
import { responseMayMatch, shouldIntercept } from "./filters"
import {
  HELD_BODY_COPIES,
  readResponseCopy,
  redactHeaders,
  warnCaptureBudget,
} from "./held-body"
import { DEFAULT_INTERCEPT_CONFIG } from "./types"

export interface InterceptRequestInput {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal | null
}

/** Request facts kept so a later response decision has the full context. */
export interface InterceptRequestSnapshot {
  method: string
  path: string
  model?: string
  body: string
  headers: Record<string, string>
  sessionId?: string
}

export interface InterceptRequestOutcome {
  /** The body to send upstream: the operator's final version, or the input. */
  body: string
  modified: boolean
  requestSnapshot: InterceptRequestSnapshot
}

export interface InterceptResponseInput {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  response: Response
  requestSnapshot: InterceptRequestSnapshot
  signal?: AbortSignal | null
}

export interface InterceptItemEdit {
  body?: string
  canonicalItems?: Array<CanonicalItem>
  /** Revision the edit was written against; a mismatch is refused. */
  baseRevision?: number
}

/** The edit or suggestion was made for an earlier revision of the item. */
export class StaleRevisionError extends Error {}

type PendingResolution =
  | { action: "forward"; body: string }
  | { action: "drop"; reason: string; status: DropStatus }

/** 403: dropped by the operator. 504: no decision before the hold expired. 499: client gone. */
type DropStatus = 403 | 499 | 504

interface AssistantRun {
  abort: AbortController
  /** Item revision the run reads; its result applies only to that revision. */
  revision: number
}

type AssistantOutcome =
  | { suggestion: InterceptAssistantResult }
  | { error: string }

interface PendingSlot {
  item: InterceptPendingItem
  resolve: (result: PendingResolution) => void
  timer: ReturnType<typeof setTimeout>
  cleanupAbort?: () => void
  reservedBytes: number
  /** Autopilot covered this item's direction when it was held. */
  autopilotEligible: boolean
  assistantRun?: AssistantRun
}

interface RecentEntry {
  item: InterceptPendingItem
  reservedBytes: number
}

export type InterceptEvent =
  | { type: "snapshot"; snapshot: InterceptSnapshot }
  | { type: "config"; config: InterceptConfig }
  | { type: "queued"; item: InterceptItemSummary }
  | { type: "updated"; item: InterceptItemSummary }
  | { type: "resolved"; id: string; status: InterceptItemStatus }

type InterceptListener = (event: InterceptEvent) => void

const RECENT_ITEMS_KEPT = 60
const TEXT_CONTENT_TYPE = /^(?:text\/|application\/(?:json|[\w.+-]+\+json)\b)/i

function cloneConfig(config: InterceptConfig): InterceptConfig {
  return {
    ...config,
    filters: {
      ...config.filters,
      conditions: config.filters.conditions.map((c) => ({ ...c })),
    },
    assistant: { ...config.assistant },
  }
}

function summarizeItem(item: InterceptPendingItem): InterceptItemSummary {
  const firstMeaningful =
    item.canonical.items.find(
      (entry) => entry.kind !== "system" && !entry.opaque && entry.content,
    ) ?? item.canonical.items.at(0)
  const rawPreview =
    firstMeaningful ? firstMeaningful.content : item.currentBody
  const preview = rawPreview.replaceAll(/\s+/g, " ").trim().slice(0, 140)
  return {
    id: item.id,
    phase: item.phase,
    status: item.status,
    createdAt: item.createdAt,
    createdAtMs: item.createdAtMs,
    expiresAtMs: item.expiresAtMs,
    modified: item.modified,
    method: item.method,
    path: item.path,
    upstream: item.upstream,
    providerId: item.providerId,
    model: item.model,
    sessionId: item.sessionId,
    stream: item.stream,
    responseStatus: item.responseStatus,
    bodyBytes: Buffer.byteLength(item.currentBody, "utf8"),
    itemCount: item.canonical.items.length,
    preview,
    assistantStatus: item.assistantStatus,
    assistantOpCount: item.assistantSuggestion?.operations.length ?? 0,
    autopilot: item.autopilot === true,
  }
}

function dropBody(resolution: Extract<PendingResolution, { action: "drop" }>) {
  return {
    error: {
      code: "intercept_dropped",
      type: resolution.status === 403 ? "permission_error" : "api_error",
      message: `Dropped by Intercept: ${resolution.reason}`,
    },
  }
}

export class InterceptEngine {
  private config: InterceptConfig = cloneConfig(DEFAULT_INTERCEPT_CONFIG)
  private readonly pending = new Map<string, PendingSlot>()
  private readonly recent: Array<RecentEntry> = []
  private readonly listeners = new Set<InterceptListener>()
  private stats = {
    forwardedCount: 0,
    droppedCount: 0,
    modifiedCount: 0,
  }
  private readonly runAssistant: InterceptAssistantRunner

  /** `runAssistant` is a test seam; production calls the configured model. */
  constructor(runAssistant: InterceptAssistantRunner = runInterceptAssistant) {
    this.runAssistant = runAssistant
  }

  /** Cheap gate so transports skip all intercept work while it is off. */
  isEnabled(): boolean {
    return this.config.enabled
  }

  getConfig(): InterceptConfig {
    return cloneConfig(this.config)
  }

  updateConfig(patch: Partial<InterceptConfig>): InterceptConfig {
    const next: InterceptConfig = {
      ...this.config,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
      ...(patch.timeoutSeconds !== undefined ?
        {
          timeoutSeconds: Math.min(
            3600,
            Math.max(15, Math.round(patch.timeoutSeconds)),
          ),
        }
      : {}),
      ...(patch.timeoutAction !== undefined ?
        { timeoutAction: patch.timeoutAction }
      : {}),
      filters:
        patch.filters ?
          this.normalizeFilters(patch.filters)
        : this.config.filters,
      assistant:
        patch.assistant ?
          this.normalizeAssistant(patch.assistant)
        : this.config.assistant,
    }

    const wasEnabled = this.config.enabled
    this.config = next
    this.emit({ type: "config", config: this.getConfig() })

    // Turning Intercept off releases everything it was holding.
    if (wasEnabled && !next.enabled && this.pending.size > 0) {
      this.forwardAllPending()
    }

    return this.getConfig()
  }

  private normalizeFilters(
    filters: InterceptFilterConfig,
  ): InterceptFilterConfig {
    return {
      enabled: filters.enabled,
      matchMode: filters.matchMode === "any" ? "any" : "all",
      conditions: filters.conditions.map((c) => ({
        id: c.id || randomUUID(),
        enabled: c.enabled,
        field: c.field,
        ...(c.headerName ? { headerName: c.headerName } : {}),
        operator: c.operator,
        value: c.value,
        caseSensitive: Boolean(c.caseSensitive),
      })),
    }
  }

  private normalizeAssistant(
    assistant: InterceptAssistantConfig,
  ): InterceptAssistantConfig {
    return {
      enabled: assistant.enabled,
      autoRun: assistant.autoRun,
      autopilot: assistant.autopilot,
      model: assistant.model.trim(),
      instructionMode:
        assistant.instructionMode === "separate" ? "separate" : "shared",
      sharedInstruction: assistant.sharedInstruction,
      requestInstruction: assistant.requestInstruction,
      responseInstruction: assistant.responseInstruction,
    }
  }

  getSnapshot(): InterceptSnapshot {
    const pendingList = [...this.pending.values()]
      .sort((a, b) => a.item.createdAtMs - b.item.createdAtMs)
      .map((slot) => summarizeItem(slot.item))
    return {
      config: this.getConfig(),
      pending: pendingList,
      recent: this.recent.map((entry) => summarizeItem(entry.item)),
      stats: {
        pendingCount: pendingList.length,
        forwardedCount: this.stats.forwardedCount,
        droppedCount: this.stats.droppedCount,
        modifiedCount: this.stats.modifiedCount,
      },
    }
  }

  getItem(id: string): InterceptPendingItem | undefined {
    return (
      this.pending.get(id)?.item
      ?? this.recent.find((entry) => entry.item.id === id)?.item
    )
  }

  subscribe(listener: InterceptListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: InterceptEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One failing subscriber must not affect the others.
      }
    }
  }

  private pushRecent(entry: RecentEntry): void {
    this.recent.unshift(entry)
    for (const evicted of this.recent.splice(RECENT_ITEMS_KEPT)) {
      releaseDebugCaptureMemory(evicted.reservedBytes)
    }
  }

  private finalizeSlot(
    id: string,
    status: InterceptItemStatus,
    resolution: PendingResolution,
  ): boolean {
    const slot = this.pending.get(id)
    if (!slot) return false
    this.pending.delete(id)
    clearTimeout(slot.timer)
    slot.cleanupAbort?.()
    slot.assistantRun?.abort.abort()
    slot.assistantRun = undefined

    const { item } = slot
    item.status = status
    item.resolvedAt = new Date().toISOString()
    if (resolution.action === "forward") {
      item.modified = resolution.body !== item.originalBody
      this.stats.forwardedCount += 1
      if (item.modified) this.stats.modifiedCount += 1
    } else {
      this.stats.droppedCount += 1
    }

    this.pushRecent({ item, reservedBytes: slot.reservedBytes })
    this.emit({ type: "resolved", id, status })
    slot.resolve(resolution)
    return true
  }

  /**
   * Replace the held payload. Throws `StaleRevisionError` when `baseRevision`
   * is not the current revision, and `CanonicalEditError` for edits that
   * cannot be written back faithfully. Any suggestion or running assistant
   * call was made for the previous revision, so both are discarded.
   */
  editPendingItem(
    id: string,
    update: InterceptItemEdit,
  ): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    const { item } = slot
    if (
      update.baseRevision !== undefined
      && update.baseRevision !== item.revision
    ) {
      throw new StaleRevisionError(
        "The held payload changed since this edit was started. Reload it and edit again.",
      )
    }

    let nextBody = item.currentBody
    if (update.canonicalItems) {
      nextBody = serializeCanonicalItemsToBody({
        originalBody: item.currentBody,
        canonical: item.canonical,
        items: update.canonicalItems,
        contentType: item.responseContentType,
      })
    } else if (update.body !== undefined) {
      nextBody = update.body
    }

    slot.assistantRun?.abort.abort()
    slot.assistantRun = undefined
    item.currentBody = nextBody
    item.revision += 1
    item.modified = nextBody !== item.originalBody
    item.canonical = parseCanonicalView({
      path: item.path,
      phase: item.phase,
      body: nextBody,
      contentType: item.responseContentType,
    })
    item.assistantSuggestion = undefined
    item.assistantError = undefined
    item.assistantStatus = "idle"
    this.emit({ type: "updated", item: summarizeItem(item) })
    return item
  }

  /**
   * Apply suggested operations, or the operator's selection of them. Throws
   * `StaleRevisionError` if the item changed after the suggestion was made and
   * `AssistantDiffError` for operations that do not fit the item.
   */
  applyAssistantDiff(
    id: string,
    selectedOperations?: Array<AssistantDiffOp>,
  ): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    const suggestion = slot.item.assistantSuggestion
    if (!suggestion || suggestion.revision !== slot.item.revision) {
      throw new StaleRevisionError(
        "This suggestion no longer matches the item. Run AI Assist again.",
      )
    }
    const operations = selectedOperations ?? suggestion.operations
    if (operations.length === 0) return slot.item
    validateDiffOps(slot.item.canonical.items, operations)
    return this.editPendingItem(id, {
      canonicalItems: applyCanonicalDiffOps(
        slot.item.canonical.items,
        operations,
      ),
    })
  }

  rejectAssistantSuggestion(id: string): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    slot.item.assistantSuggestion = undefined
    slot.item.assistantStatus = "idle"
    slot.item.assistantError = undefined
    this.emit({ type: "updated", item: summarizeItem(slot.item) })
    return slot.item
  }

  async triggerAssistant(
    id: string,
    options?: { instruction?: string; model?: string },
  ): Promise<InterceptPendingItem | undefined> {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    const { item } = slot

    slot.assistantRun?.abort.abort()
    const run: AssistantRun = {
      abort: new AbortController(),
      revision: item.revision,
    }
    slot.assistantRun = run
    item.assistantStatus = "running"
    item.assistantError = undefined
    this.emit({ type: "updated", item: summarizeItem(item) })

    let outcome: AssistantOutcome
    try {
      outcome = {
        suggestion: await this.runAssistant({
          item: { ...item },
          config: this.config.assistant,
          instructionOverride: options?.instruction,
          modelOverride: options?.model,
          signal: run.abort.signal,
        }),
      }
    } catch (error) {
      outcome = {
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.settleAssistantRun(slot, run, outcome)
    return item
  }

  /** Record a finished run unless its item resolved, changed, or ran again. */
  private settleAssistantRun(
    slot: PendingSlot,
    run: AssistantRun,
    outcome: AssistantOutcome,
  ): void {
    const { item } = slot
    if (
      this.pending.get(item.id) !== slot
      || slot.assistantRun !== run
      || item.revision !== run.revision
    ) {
      return
    }
    slot.assistantRun = undefined
    if ("suggestion" in outcome) {
      item.assistantStatus = "ready"
      item.assistantSuggestion = {
        ...outcome.suggestion,
        revision: run.revision,
      }
    } else {
      item.assistantStatus = "error"
      item.assistantError = outcome.error
    }
    this.emit({ type: "updated", item: summarizeItem(item) })
  }

  forwardItem(id: string, override?: InterceptItemEdit): boolean {
    const slot = this.pending.get(id)
    if (!slot) return false
    if (override?.body !== undefined || override?.canonicalItems) {
      this.editPendingItem(id, override)
    }
    return this.finalizeSlot(id, "forwarded", {
      action: "forward",
      body: slot.item.currentBody,
    })
  }

  dropItem(id: string, reason = "Dropped by operator"): boolean {
    return this.finalizeSlot(id, "dropped", {
      action: "drop",
      reason,
      status: 403,
    })
  }

  forwardAllPending(): number {
    let count = 0
    for (const id of this.pending.keys()) {
      if (this.forwardItem(id)) count += 1
    }
    return count
  }

  dropAllPending(reason = "Dropped all held items"): number {
    let count = 0
    for (const id of this.pending.keys()) {
      if (this.dropItem(id, reason)) count += 1
    }
    return count
  }

  clearRecent(): void {
    for (const entry of this.recent.splice(0)) {
      releaseDebugCaptureMemory(entry.reservedBytes)
    }
    this.emit({ type: "snapshot", snapshot: this.getSnapshot() })
  }

  private autopilotCovers(phase: InterceptPhase): boolean {
    const { autopilot, enabled } = this.config.assistant
    return enabled && (autopilot === "both" || autopilot === phase)
  }

  private maybeAutoRunAssistant(slot: PendingSlot): void {
    const cfg = this.config.assistant
    const { item } = slot
    if (!cfg.enabled || !cfg.model.trim() || !item.canonical.editable) return
    if (!cfg.autoRun && !slot.autopilotEligible) return
    if (!resolveAssistantInstruction(cfg, item.phase)) return
    void this.triggerAssistant(item.id).then(() => {
      this.completeAutopilot(item.id)
    })
  }

  /**
   * Apply every proposed change and forward. The item stays held when it was
   * not eligible when held, Autopilot was switched off, the assistant failed,
   * or its changes cannot be written back.
   */
  private completeAutopilot(id: string): void {
    const slot = this.pending.get(id)
    if (
      !slot?.autopilotEligible
      || slot.item.assistantStatus !== "ready"
      || !this.autopilotCovers(slot.item.phase)
    ) {
      return
    }
    try {
      this.applyAssistantDiff(id)
    } catch (error) {
      slot.item.assistantStatus = "error"
      slot.item.assistantError =
        error instanceof Error ? error.message : String(error)
      this.emit({ type: "updated", item: summarizeItem(slot.item) })
      return
    }
    slot.item.autopilot = true
    this.forwardItem(id)
  }

  private resolveOnTimeout(id: string): void {
    const slot = this.pending.get(id)
    if (!slot) return
    if (this.config.timeoutAction === "drop") {
      this.finalizeSlot(id, "timed_out", {
        action: "drop",
        reason: `no decision within ${this.config.timeoutSeconds}s`,
        status: 504,
      })
      return
    }
    this.finalizeSlot(id, "timed_out", {
      action: "forward",
      body: slot.item.currentBody,
    })
  }

  private enqueueItem(
    item: InterceptPendingItem,
    reservedBytes: number,
    signal?: AbortSignal | null,
  ): Promise<PendingResolution> {
    const { promise, resolve } = Promise.withResolvers<PendingResolution>()
    if (signal?.aborted) {
      releaseDebugCaptureMemory(reservedBytes)
      resolve({ action: "drop", reason: "client disconnected", status: 499 })
      return promise
    }

    // Operator-configured hold deadline for Intercept, not an upstream timeout.
    const holdMs = this.config.timeoutSeconds * 1000
    const timer = setTimeout(() => this.resolveOnTimeout(item.id), holdMs)
    const onAbort = () => {
      this.finalizeSlot(item.id, "aborted", {
        action: "drop",
        reason: "client disconnected",
        status: 499,
      })
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    const slot: PendingSlot = {
      item,
      resolve,
      timer,
      reservedBytes,
      autopilotEligible: this.autopilotCovers(item.phase),
      cleanupAbort: () => signal?.removeEventListener("abort", onAbort),
    }
    this.pending.set(item.id, slot)
    this.emit({ type: "queued", item: summarizeItem(item) })
    this.maybeAutoRunAssistant(slot)
    return promise
  }

  async interceptRequest(
    input: InterceptRequestInput,
  ): Promise<InterceptRequestOutcome> {
    const requestSnapshot: InterceptRequestSnapshot = {
      method: input.method,
      path: input.path,
      body: input.body,
      headers: { ...input.headers },
    }
    if (isInterceptBypassed() || !this.config.enabled) {
      return { body: input.body, modified: false, requestSnapshot }
    }

    requestSnapshot.model = extractModelFromBody(input.body)
    requestSnapshot.sessionId = getClientSessionId()
    const unchanged = { body: input.body, modified: false, requestSnapshot }
    const matches = shouldIntercept(this.config, {
      phase: "request",
      path: input.path,
      upstream: input.upstream,
      providerId: input.providerId,
      model: requestSnapshot.model,
      sessionId: requestSnapshot.sessionId,
      headers: input.headers,
      requestBody: input.body,
    })
    if (!matches) return unchanged

    const reservedBytes =
      Buffer.byteLength(input.body, "utf8") * HELD_BODY_COPIES
    if (!reserveDebugCaptureMemory(reservedBytes)) {
      warnCaptureBudget(input.path)
      return unchanged
    }

    const canonical = parseCanonicalView({
      path: input.path,
      phase: "request",
      body: input.body,
    })
    const item = this.createItem({
      phase: "request",
      input,
      headers: input.headers,
      body: input.body,
      model: requestSnapshot.model ?? canonical.model,
      sessionId: requestSnapshot.sessionId,
      canonical,
    })

    consola.info(
      `[Intercept] Holding REQUEST ${item.id.slice(0, 8)} ${input.method} ${input.path} (model=${item.model ?? "unknown"})`,
    )

    const resolution = await this.enqueueItem(item, reservedBytes, input.signal)
    if (resolution.action === "drop") {
      const body = dropBody(resolution)
      throw new LocalHTTPError(
        body.error.message,
        Response.json(body, { status: resolution.status }),
        body,
      )
    }

    return {
      body: resolution.body,
      modified: resolution.body !== input.body,
      requestSnapshot: {
        ...requestSnapshot,
        body: resolution.body,
        model: extractModelFromBody(resolution.body) ?? requestSnapshot.model,
      },
    }
  }

  /**
   * Returns the original response object unless the operator edited or
   * dropped it, so unheld and unchanged responses keep their identity, bytes,
   * and streaming.
   */
  async interceptResponse(input: InterceptResponseInput): Promise<Response> {
    if (isInterceptBypassed()) return input.response
    const contentType = input.response.headers.get("content-type") ?? undefined
    if (contentType && !TEXT_CONTENT_TYPE.test(contentType)) {
      return input.response
    }

    const snapshot = input.requestSnapshot
    const responseHeaders = Object.fromEntries(input.response.headers.entries())
    const context = {
      phase: "response" as const,
      path: input.path,
      upstream: input.upstream,
      providerId: input.providerId,
      model: snapshot.model,
      sessionId: snapshot.sessionId,
      headers: responseHeaders,
      requestBody: snapshot.body,
    }
    if (!responseMayMatch(this.config, context)) return input.response

    const copy = await readResponseCopy(input.response, input.path)
    if (!copy) return input.response
    if (
      !shouldIntercept(this.config, { ...context, responseBody: copy.text })
    ) {
      releaseDebugCaptureMemory(copy.reservedBytes)
      return input.response
    }

    const canonical = parseCanonicalView({
      path: input.path,
      phase: "response",
      body: copy.text,
      contentType,
    })
    const item = this.createItem({
      phase: "response",
      input,
      headers: responseHeaders,
      body: copy.text,
      model: snapshot.model ?? canonical.model,
      sessionId: snapshot.sessionId,
      canonical,
    })
    item.responseStatus = input.response.status
    item.responseStatusText = input.response.statusText
    item.responseContentType = contentType
    item.requestContext = {
      method: snapshot.method,
      path: snapshot.path,
      model: snapshot.model,
      body: snapshot.body,
      canonical: parseCanonicalView({
        path: snapshot.path,
        phase: "request",
        body: snapshot.body,
      }),
    }

    consola.info(
      `[Intercept] Holding RESPONSE ${item.id.slice(0, 8)} ${input.response.status} ${input.path} (model=${item.model ?? "unknown"})`,
    )

    const resolution = await this.enqueueItem(
      item,
      copy.reservedBytes,
      input.signal,
    )
    if (resolution.action === "forward" && resolution.body === copy.text) {
      return input.response
    }
    // The original body will not be delivered; release its upstream stream.
    void input.response.body?.cancel().catch(() => undefined)
    if (resolution.action === "drop") {
      return Response.json(dropBody(resolution), { status: resolution.status })
    }
    const headers = new Headers(responseHeaders)
    // The body changed length and is no longer the upstream encoding.
    headers.delete("content-encoding")
    headers.delete("content-length")
    headers.delete("transfer-encoding")
    return new Response(resolution.body, {
      status: input.response.status,
      statusText: input.response.statusText,
      headers,
    })
  }

  private createItem(options: {
    phase: InterceptPhase
    input: InterceptRequestInput | InterceptResponseInput
    headers: Record<string, string>
    body: string
    model?: string
    sessionId?: string
    canonical: InterceptPendingItem["canonical"]
  }): InterceptPendingItem {
    const now = Date.now()
    const { input } = options
    return {
      id: randomUUID(),
      phase: options.phase,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      expiresAtMs: now + this.config.timeoutSeconds * 1000,
      modified: false,
      revision: 0,
      method: input.method,
      path: input.path,
      url: input.url,
      upstream: input.upstream,
      providerId: input.providerId,
      model: options.model,
      sessionId: options.sessionId,
      requestId: getRequestId(),
      stream: options.canonical.stream,
      headers: redactHeaders(options.headers),
      originalBody: options.body,
      currentBody: options.body,
      canonical: options.canonical,
      assistantStatus: "idle",
    }
  }

  /** Test helper to reset engine state between test cases. */
  resetForTest(): void {
    this.dropAllPending("Test reset")
    this.clearRecent()
    this.config = cloneConfig(DEFAULT_INTERCEPT_CONFIG)
    this.stats = { forwardedCount: 0, droppedCount: 0, modifiedCount: 0 }
  }
}

export const interceptEngine = new InterceptEngine()
