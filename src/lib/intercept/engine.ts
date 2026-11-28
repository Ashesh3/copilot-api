import consola from "consola"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { getClientSessionId } from "~/lib/request-session"

import type {
  InterceptAssistantResult,
  InterceptAssistantRunner,
} from "./assistant"
import type {
  AssistantDiffOp,
  CanonicalItem,
  InterceptConfig,
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
  CanonicalEditError,
  extractModelFromBody,
  parseCanonicalView,
  serializeCanonicalItemsToBody,
} from "./canonical"
import {
  responseMatchConfirmed,
  responseMayMatch,
  shouldIntercept,
} from "./filters"
import {
  HELD_BODY_COPIES,
  readResponseCopy,
  retainedBytes,
  warnCaptureBudget,
} from "./held-body"
import {
  buildItem,
  cloneConfig,
  type DropStatus,
  droppedError,
  normalizeAssistant,
  normalizeFilters,
  requestStreamFlag,
  summarizeItem,
} from "./items"
import { DEFAULT_INTERCEPT_CONFIG } from "./types"
import { interceptWaitCancelSignal, signalInterceptWait } from "./wait-signal"

/** The request's signal, also aborted when its client cancels the early stream. */
function holdSignal(
  signal: AbortSignal | null | undefined,
): AbortSignal | undefined {
  const cancelled = interceptWaitCancelSignal()
  if (!cancelled) return signal ?? undefined
  return signal ? AbortSignal.any([signal, cancelled]) : cancelled
}

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
  /** The request was held for a decision, as opposed to passed through. */
  held: boolean
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

/** The suggestion an operator reviewed; applying it to anything else is refused. */
export interface ReviewedSuggestion {
  suggestionId: string
  revision: number
}

/** The edit or suggestion was made for an earlier revision of the item. */
export class StaleRevisionError extends Error {}

/** Capture memory cannot hold the edited item; the edit is not applied. */
export class CaptureBudgetError extends Error {}

type PendingResolution =
  | { action: "forward"; body: string }
  | { action: "drop"; reason: string; status: DropStatus }

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
  /** Capture memory reserved for this item; follows `retainedBytes(item)`. */
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
const CAPTURE_FULL =
  "Capture memory is full. Forward or drop held items, or clear history, and try again."

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Move a capture's reservation to the bytes its held item retains. The
 * decoded text can be shorter than the bytes read (a stripped BOM), so a
 * shrink is released rather than refused. False when growth does not fit.
 */
function resizeCaptureReservation(reserved: number, needed: number): boolean {
  if (needed < reserved) {
    releaseDebugCaptureMemory(reserved - needed)
    return true
  }
  return reserveDebugCaptureMemory(needed - reserved)
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
  /** Aborted when Intercept turns off, releasing responses still being read. */
  private captureAbort = new AbortController()
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
        patch.filters ? normalizeFilters(patch.filters) : this.config.filters,
      assistant:
        patch.assistant ?
          normalizeAssistant(patch.assistant)
        : this.config.assistant,
    }

    const wasEnabled = this.config.enabled
    this.config = next
    this.emit({ type: "config", config: this.getConfig() })

    // Turning Intercept off releases everything it was holding or reading.
    if (wasEnabled && !next.enabled) {
      this.captureAbort.abort()
      this.captureAbort = new AbortController()
      this.forwardAllPending()
    }

    return this.getConfig()
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

  /** Grow or shrink a slot's reservation; false when growth does not fit. */
  private reserveFor(slot: PendingSlot, bytes: number): boolean {
    const delta = bytes - slot.reservedBytes
    if (delta > 0 && !reserveDebugCaptureMemory(delta)) return false
    if (delta < 0) releaseDebugCaptureMemory(-delta)
    slot.reservedBytes = bytes
    return true
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
   * is not the current revision, `CanonicalEditError` for edits that cannot be
   * written back faithfully or that change a request's `stream` mode, and
   * `CaptureBudgetError` when the edited item does not fit in capture memory.
   * Any suggestion or running assistant call was made for the previous
   * revision, so both are discarded.
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
    if (item.phase === "request") {
      // The client and the response parser expect the original format.
      const before = requestStreamFlag(item.originalBody)
      const after = requestStreamFlag(nextBody)
      if (before !== undefined && after !== undefined && before !== after) {
        throw new CanonicalEditError(
          `The client expects a ${before ? "streamed" : "buffered"} response, so \`stream\` cannot change.`,
        )
      }
    }
    const reserved = this.reserveFor(
      slot,
      retainedBytes({
        ...item,
        currentBody: nextBody,
        assistantSuggestion: undefined,
      }),
    )
    if (!reserved) throw new CaptureBudgetError(CAPTURE_FULL)

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
   * Apply the reviewed suggestion's operations, or the operator's selection
   * of them. Throws `StaleRevisionError` unless `reviewed` names the current
   * suggestion and the item is still at its revision, and `AssistantDiffError`
   * for operations that do not fit the item.
   */
  applyAssistantDiff(
    id: string,
    reviewed: ReviewedSuggestion,
    selectedOperations?: Array<AssistantDiffOp>,
  ): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    const suggestion = slot.item.assistantSuggestion
    if (
      suggestion?.id !== reviewed.suggestionId
      || suggestion.revision !== reviewed.revision
      || slot.item.revision !== reviewed.revision
    ) {
      throw new StaleRevisionError(
        "This suggestion no longer matches the item. Review the current one or run AI Assist again.",
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
      baseRevision: reviewed.revision,
    })
  }

  rejectAssistantSuggestion(id: string): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    slot.item.assistantSuggestion = undefined
    slot.item.assistantStatus = "idle"
    slot.item.assistantError = undefined
    this.reserveFor(slot, retainedBytes(slot.item))
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
      outcome = { error: errorText(error) }
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
    const suggestion =
      "suggestion" in outcome ?
        { ...outcome.suggestion, revision: run.revision }
      : undefined
    if (
      suggestion
      && this.reserveFor(
        slot,
        retainedBytes({ ...item, assistantSuggestion: suggestion }),
      )
    ) {
      item.assistantStatus = "ready"
      item.assistantSuggestion = suggestion
    } else {
      item.assistantStatus = "error"
      item.assistantError = "error" in outcome ? outcome.error : CAPTURE_FULL
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
    const suggestion = slot?.item.assistantSuggestion
    if (
      !slot?.autopilotEligible
      || !suggestion
      || slot.item.assistantStatus !== "ready"
      || !this.autopilotCovers(slot.item.phase)
    ) {
      return
    }
    try {
      this.applyAssistantDiff(id, {
        suggestionId: suggestion.id,
        revision: suggestion.revision,
      })
    } catch (error) {
      slot.item.assistantStatus = "error"
      slot.item.assistantError = errorText(error)
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
    // A response's deadline started when its capture began.
    const holdMs = Math.max(0, item.expiresAtMs - Date.now())
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
    const unchanged = {
      body: input.body,
      modified: false,
      held: false,
      requestSnapshot,
    }
    if (isInterceptBypassed() || !this.config.enabled) return unchanged

    requestSnapshot.model = extractModelFromBody(input.body)
    requestSnapshot.sessionId = getClientSessionId()
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
    const item = buildItem({
      ...input,
      phase: "request",
      model: requestSnapshot.model ?? canonical.model,
      sessionId: requestSnapshot.sessionId,
      canonical,
      expiresAtMs: Date.now() + this.config.timeoutSeconds * 1000,
    })

    consola.info(
      `[Intercept] Holding REQUEST ${item.id.slice(0, 8)} ${input.method} ${input.path} (model=${item.model ?? "unknown"})`,
    )

    signalInterceptWait()
    const resolution = await this.enqueueItem(
      item,
      reservedBytes,
      holdSignal(input.signal),
    )
    if (resolution.action === "drop") {
      throw droppedError(resolution.reason, resolution.status)
    }

    return {
      body: resolution.body,
      modified: resolution.body !== input.body,
      held: true,
      requestSnapshot: {
        ...requestSnapshot,
        body: resolution.body,
        model: extractModelFromBody(resolution.body) ?? requestSnapshot.model,
      },
    }
  }

  /**
   * Read a response that may be held. Undefined means pass it through: it
   * cannot be held, Intercept turned off, or the client left while it was
   * read. Reading counts against the same hold deadline as the decision that
   * follows; a read that outlasts it follows `timeoutAction`, but only when
   * the filters already match without the body: a response whose body might
   * not match is passed through rather than dropped.
   */
  private async captureResponse(
    input: InterceptResponseInput,
    hold: { expiresAtMs: number; matchConfirmed: () => boolean },
  ): Promise<{ text: string; reservedBytes: number } | undefined> {
    const turnedOff = this.captureAbort.signal
    // Operator-configured hold deadline for Intercept, not an upstream timeout.
    const deadline = new AbortController()
    const timer = setTimeout(
      () => {
        deadline.abort()
      },
      Math.max(0, hold.expiresAtMs - Date.now()),
    )
    let copy: Awaited<ReturnType<typeof readResponseCopy>>
    try {
      copy = await readResponseCopy(
        input.response,
        input.path,
        AbortSignal.any([
          turnedOff,
          deadline.signal,
          ...(input.signal ? [input.signal] : []),
        ]),
      )
    } finally {
      clearTimeout(timer)
    }
    if (
      !copy
      && deadline.signal.aborted
      && !turnedOff.aborted
      && !input.signal?.aborted
      && this.config.timeoutAction === "drop"
      && hold.matchConfirmed()
    ) {
      void input.response.body?.cancel().catch(() => undefined)
      throw droppedError(
        `the response did not finish within ${this.config.timeoutSeconds}s`,
        504,
      )
    }
    return copy
  }

  /**
   * Returns the original response object unless the operator edited it, so
   * unheld and unchanged responses keep their identity, bytes, and
   * streaming. A dropped response throws the same local error as a dropped
   * request.
   */
  async interceptResponse(input: InterceptResponseInput): Promise<Response> {
    if (isInterceptBypassed() || !this.config.enabled) return input.response
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

    const expiresAtMs = Date.now() + this.config.timeoutSeconds * 1000
    const confirmedAtStart = responseMatchConfirmed(this.config, context)
    // Reading the rest of the upstream stream can take as long as the hold.
    signalInterceptWait()
    const signal = holdSignal(input.signal)
    const copy = await this.captureResponse(
      { ...input, signal },
      {
        expiresAtMs,
        // Both the rules the read began under and the current rules must
        // confirm the match before a timeout drops the response.
        matchConfirmed: () =>
          confirmedAtStart && responseMatchConfirmed(this.config, context),
      },
    )
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
    const item = buildItem({
      ...input,
      phase: "response",
      headers: responseHeaders,
      body: copy.text,
      model: snapshot.model ?? canonical.model,
      sessionId: snapshot.sessionId,
      canonical,
      expiresAtMs,
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
    // The request context is retained with the item; reserve it as well.
    const reservedBytes = retainedBytes(item)
    if (!resizeCaptureReservation(copy.reservedBytes, reservedBytes)) {
      releaseDebugCaptureMemory(copy.reservedBytes)
      warnCaptureBudget(input.path)
      return input.response
    }

    consola.info(
      `[Intercept] Holding RESPONSE ${item.id.slice(0, 8)} ${input.response.status} ${input.path} (model=${item.model ?? "unknown"})`,
    )

    const resolution = await this.enqueueItem(item, reservedBytes, signal)
    if (resolution.action === "forward" && resolution.body === copy.text) {
      return input.response
    }
    // The original body will not be delivered; release its upstream stream.
    void input.response.body?.cancel().catch(() => undefined)
    if (resolution.action === "drop") {
      throw droppedError(resolution.reason, resolution.status)
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

  /** Test helper to reset engine state between test cases. */
  resetForTest(): void {
    this.dropAllPending("Test reset")
    this.clearRecent()
    this.config = cloneConfig(DEFAULT_INTERCEPT_CONFIG)
    this.stats = { forwardedCount: 0, droppedCount: 0, modifiedCount: 0 }
  }
}

export const interceptEngine = new InterceptEngine()
