import consola from "consola"
import { randomUUID } from "node:crypto"

import { LocalHTTPError } from "~/lib/error"
import { getClientSessionId, getRequestId } from "~/lib/request-session"

import type {
  AssistantDiffOp,
  CanonicalItem,
  InterceptAssistantConfig,
  InterceptConfig,
  InterceptFilterConfig,
  InterceptItemStatus,
  InterceptItemSummary,
  InterceptPendingItem,
  InterceptSnapshot,
} from "./types"

import {
  isInterceptBypassed,
  resolveAssistantInstruction,
  runInterceptAssistant,
} from "./assistant"
import {
  applyCanonicalDiffOps,
  extractModelFromBody,
  parseCanonicalView,
  serializeCanonicalItemsToBody,
} from "./canonical"
import { shouldIntercept } from "./filters"
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

export interface InterceptRequestOutcome {
  action: "forward" | "drop"
  body: string
  headers: Record<string, string>
  modified: boolean
  /** Saved context so a matching response intercept has the full request context. */
  requestSnapshot: {
    method: string
    path: string
    model?: string
    body: string
    headers: Record<string, string>
    sessionId?: string
  }
}

export interface InterceptResponseInput {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  response: Response
  requestSnapshot: InterceptRequestOutcome["requestSnapshot"]
  signal?: AbortSignal | null
}

type PendingResolution =
  | {
      action: "forward"
      body: string
      headers: Record<string, string>
      modified: boolean
    }
  | {
      action: "drop"
      reason: string
    }

interface PendingSlot {
  item: InterceptPendingItem
  resolve: (result: PendingResolution) => void
  timer: ReturnType<typeof setTimeout>
  cleanupAbort?: () => void
}

export type InterceptEvent =
  | { type: "snapshot"; snapshot: InterceptSnapshot }
  | { type: "config"; config: InterceptConfig }
  | { type: "queued"; item: InterceptItemSummary }
  | { type: "updated"; item: InterceptItemSummary }
  | { type: "resolved"; id: string; status: InterceptItemStatus }

type InterceptListener = (event: InterceptEvent) => void

const MAX_RECENT_ITEMS = 60

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
      (entry) => entry.kind !== "system" && entry.content,
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
  }
}

function createDroppedResponse(reason: string): {
  body: Record<string, unknown>
  response: Response
} {
  const body = {
    error: {
      code: "intercept_dropped",
      type: "api_error",
      message: `Request dropped by Intercept proxy: ${reason}`,
    },
  }
  return { body, response: Response.json(body, { status: 499 }) }
}
export class InterceptEngine {
  private config: InterceptConfig = cloneConfig(DEFAULT_INTERCEPT_CONFIG)
  private readonly pending = new Map<string, PendingSlot>()
  private readonly recent: Array<InterceptPendingItem> = []
  private readonly listeners = new Set<InterceptListener>()
  private stats = {
    forwardedCount: 0,
    droppedCount: 0,
    modifiedCount: 0,
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

    // When master toggle turns OFF, release all held items immediately
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
    const recentList = this.recent.map((item) => summarizeItem(item))
    return {
      config: this.getConfig(),
      pending: pendingList,
      recent: recentList,
      stats: {
        pendingCount: pendingList.length,
        forwardedCount: this.stats.forwardedCount,
        droppedCount: this.stats.droppedCount,
        modifiedCount: this.stats.modifiedCount,
      },
    }
  }

  getItem(id: string): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (slot) return slot.item
    return this.recent.find((entry) => entry.id === id)
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
        // Ignore subscriber failures
      }
    }
  }

  private pushRecent(item: InterceptPendingItem): void {
    this.recent.unshift(item)
    if (this.recent.length > MAX_RECENT_ITEMS) {
      this.recent.length = MAX_RECENT_ITEMS
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

    slot.item.status = status
    slot.item.resolvedAt = new Date().toISOString()
    if (resolution.action === "forward") {
      slot.item.currentBody = resolution.body
      slot.item.headers = resolution.headers
      slot.item.modified = resolution.modified
      this.stats.forwardedCount += 1
      if (resolution.modified) this.stats.modifiedCount += 1
    } else {
      this.stats.droppedCount += 1
    }

    this.pushRecent(slot.item)
    this.emit({ type: "resolved", id, status })
    slot.resolve(resolution)
    return true
  }

  editPendingItem(
    id: string,
    update: {
      body?: string
      canonicalItems?: Array<CanonicalItem>
      headers?: Record<string, string>
    },
  ): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined

    let nextBody = slot.item.currentBody
    if (update.canonicalItems) {
      nextBody = serializeCanonicalItemsToBody({
        originalBody: slot.item.currentBody,
        canonical: slot.item.canonical,
        items: update.canonicalItems,
        contentType: slot.item.responseContentType,
      })
    } else if (update.body !== undefined) {
      nextBody = update.body
    }

    slot.item.currentBody = nextBody
    if (update.headers) {
      slot.item.headers = { ...update.headers }
    }
    slot.item.modified = nextBody !== slot.item.originalBody
    slot.item.canonical = parseCanonicalView({
      path: slot.item.path,
      phase: slot.item.phase,
      body: nextBody,
      contentType: slot.item.responseContentType,
    })
    this.emit({ type: "updated", item: summarizeItem(slot.item) })
    return slot.item
  }

  applyAssistantDiff(
    id: string,
    selectedOperations?: Array<AssistantDiffOp>,
  ): InterceptPendingItem | undefined {
    const slot = this.pending.get(id)
    if (!slot) return undefined
    const ops =
      selectedOperations ?? slot.item.assistantSuggestion?.operations ?? []
    if (ops.length === 0) return slot.item

    const nextItems = applyCanonicalDiffOps(slot.item.canonical.items, ops)
    // An applied suggestion is consumed: its item IDs address the pre-edit payload.
    slot.item.assistantSuggestion = undefined
    slot.item.assistantStatus = "idle"
    return this.editPendingItem(id, { canonicalItems: nextItems })
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

    slot.item.assistantStatus = "running"
    slot.item.assistantError = undefined
    this.emit({ type: "updated", item: summarizeItem(slot.item) })

    try {
      const suggestion = await runInterceptAssistant({
        item: slot.item,
        config: this.config.assistant,
        instructionOverride: options?.instruction,
        modelOverride: options?.model,
      })
      if (!this.pending.has(id)) return slot.item
      slot.item.assistantStatus = "ready"
      slot.item.assistantSuggestion = suggestion
      this.emit({ type: "updated", item: summarizeItem(slot.item) })
      return slot.item
    } catch (error) {
      if (!this.pending.has(id)) return slot.item
      slot.item.assistantStatus = "error"
      slot.item.assistantError =
        error instanceof Error ? error.message : String(error)
      this.emit({ type: "updated", item: summarizeItem(slot.item) })
      return slot.item
    }
  }

  forwardItem(
    id: string,
    override?: {
      body?: string
      canonicalItems?: Array<CanonicalItem>
      headers?: Record<string, string>
    },
  ): boolean {
    const slot = this.pending.get(id)
    if (!slot) return false
    if (override) {
      this.editPendingItem(id, override)
    }
    return this.finalizeSlot(id, "forwarded", {
      action: "forward",
      body: slot.item.currentBody,
      headers: slot.item.headers,
      modified: slot.item.currentBody !== slot.item.originalBody,
    })
  }

  dropItem(id: string, reason = "Dropped by operator"): boolean {
    return this.finalizeSlot(id, "dropped", { action: "drop", reason })
  }

  forwardAllPending(): number {
    const ids = [...this.pending.keys()]
    let count = 0
    for (const id of ids) {
      if (this.forwardItem(id)) count += 1
    }
    return count
  }

  dropAllPending(reason = "Dropped all pending items"): number {
    const ids = [...this.pending.keys()]
    let count = 0
    for (const id of ids) {
      if (this.dropItem(id, reason)) count += 1
    }
    return count
  }

  clearRecent(): void {
    this.recent.length = 0
    this.emit({ type: "snapshot", snapshot: this.getSnapshot() })
  }

  private maybeAutoRunAssistant(item: InterceptPendingItem): void {
    const cfg = this.config.assistant
    if (!cfg.enabled || !cfg.autoRun || !cfg.model.trim()) return
    const instruction = resolveAssistantInstruction(cfg, item.phase)
    if (!instruction) return
    void this.triggerAssistant(item.id)
  }

  private enqueueItem(
    item: InterceptPendingItem,
    signal?: AbortSignal | null,
  ): Promise<PendingResolution> {
    return new Promise<PendingResolution>((resolve) => {
      const timeoutMs = this.config.timeoutSeconds * 1000
      const timer = setTimeout(() => {
        if (this.config.timeoutAction === "drop") {
          this.finalizeSlot(item.id, "timed_out", {
            action: "drop",
            reason: `Intercept timed out after ${this.config.timeoutSeconds}s`,
          })
        } else {
          this.finalizeSlot(item.id, "timed_out", {
            action: "forward",
            body: item.currentBody,
            headers: item.headers,
            modified: item.currentBody !== item.originalBody,
          })
        }
      }, timeoutMs)

      let cleanupAbort: (() => void) | undefined
      if (signal) {
        const onAbort = () => {
          this.finalizeSlot(item.id, "aborted", {
            action: "drop",
            reason: "Client aborted connection while held in intercept queue",
          })
        }
        if (signal.aborted) {
          clearTimeout(timer)
          resolve({
            action: "drop",
            reason: "Client aborted connection",
          })
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
        cleanupAbort = () => signal.removeEventListener("abort", onAbort)
      }

      this.pending.set(item.id, { item, resolve, timer, cleanupAbort })
      this.emit({ type: "queued", item: summarizeItem(item) })
      this.maybeAutoRunAssistant(item)
    })
  }

  async interceptRequest(
    input: InterceptRequestInput,
  ): Promise<InterceptRequestOutcome> {
    const model = extractModelFromBody(input.body)
    const sessionId = getClientSessionId()
    const requestSnapshot: InterceptRequestOutcome["requestSnapshot"] = {
      method: input.method,
      path: input.path,
      model,
      body: input.body,
      headers: { ...input.headers },
      sessionId,
    }

    if (isInterceptBypassed()) {
      return {
        action: "forward",
        body: input.body,
        headers: input.headers,
        modified: false,
        requestSnapshot,
      }
    }

    const matches = shouldIntercept(this.config, {
      phase: "request",
      path: input.path,
      upstream: input.upstream,
      providerId: input.providerId,
      model,
      sessionId,
      headers: input.headers,
      requestBody: input.body,
    })

    if (!matches) {
      return {
        action: "forward",
        body: input.body,
        headers: input.headers,
        modified: false,
        requestSnapshot,
      }
    }

    const now = Date.now()
    const canonical = parseCanonicalView({
      path: input.path,
      phase: "request",
      body: input.body,
    })

    const item: InterceptPendingItem = {
      id: randomUUID(),
      phase: "request",
      status: "pending",
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      expiresAtMs: now + this.config.timeoutSeconds * 1000,
      modified: false,
      method: input.method,
      path: input.path,
      url: input.url,
      upstream: input.upstream,
      providerId: input.providerId,
      model: model ?? canonical.model,
      sessionId,
      requestId: getRequestId(),
      stream: canonical.stream,
      headers: { ...input.headers },
      originalBody: input.body,
      currentBody: input.body,
      canonical,
      assistantStatus: "idle",
    }

    consola.info(
      `[Intercept] Holding REQUEST ${item.id.slice(0, 8)} ${input.method} ${input.path} (model=${item.model ?? "unknown"})`,
    )

    const resolution = await this.enqueueItem(item, input.signal)
    if (resolution.action === "drop") {
      const dropped = createDroppedResponse(resolution.reason)
      throw new LocalHTTPError(
        resolution.reason,
        dropped.response,
        dropped.body,
      )
    }

    const updatedSnapshot = {
      ...requestSnapshot,
      body: resolution.body,
      headers: resolution.headers,
      model: extractModelFromBody(resolution.body) ?? model,
    }

    return {
      action: "forward",
      body: resolution.body,
      headers: resolution.headers,
      modified: resolution.modified,
      requestSnapshot: updatedSnapshot,
    }
  }

  async interceptResponse(input: InterceptResponseInput): Promise<Response> {
    if (isInterceptBypassed()) return input.response
    if (!this.config.enabled) return input.response
    if (this.config.direction === "request") return input.response

    const responseHeaders = Object.fromEntries(input.response.headers.entries())
    const contentType = input.response.headers.get("content-type") ?? undefined

    // Buffer full body (including SSE) so we can inspect, filter on responseBody, and edit
    const rawBody = await input.response.text()

    const matches = shouldIntercept(this.config, {
      phase: "response",
      path: input.path,
      upstream: input.upstream,
      providerId: input.providerId,
      model: input.requestSnapshot.model ?? extractModelFromBody(rawBody),
      sessionId: input.requestSnapshot.sessionId,
      headers: responseHeaders,
      requestBody: input.requestSnapshot.body,
      responseBody: rawBody,
    })

    if (!matches) {
      return rebuildResponse(input.response, rawBody, responseHeaders)
    }

    const now = Date.now()
    const canonical = parseCanonicalView({
      path: input.path,
      phase: "response",
      body: rawBody,
      contentType,
    })
    const reqCanonical = parseCanonicalView({
      path: input.requestSnapshot.path,
      phase: "request",
      body: input.requestSnapshot.body,
    })

    const item: InterceptPendingItem = {
      id: randomUUID(),
      phase: "response",
      status: "pending",
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      expiresAtMs: now + this.config.timeoutSeconds * 1000,
      modified: false,
      method: input.method,
      path: input.path,
      url: input.url,
      upstream: input.upstream,
      providerId: input.providerId,
      model: input.requestSnapshot.model ?? canonical.model,
      sessionId: input.requestSnapshot.sessionId,
      requestId: getRequestId(),
      stream: canonical.stream,
      responseStatus: input.response.status,
      responseStatusText: input.response.statusText,
      responseContentType: contentType,
      headers: responseHeaders,
      originalBody: rawBody,
      currentBody: rawBody,
      requestContext: {
        method: input.requestSnapshot.method,
        path: input.requestSnapshot.path,
        model: input.requestSnapshot.model,
        body: input.requestSnapshot.body,
        canonical: reqCanonical,
      },
      canonical,
      assistantStatus: "idle",
    }

    consola.info(
      `[Intercept] Holding RESPONSE ${item.id.slice(0, 8)} ${input.response.status} ${input.path} (model=${item.model ?? "unknown"})`,
    )

    const resolution = await this.enqueueItem(item, input.signal)
    if (resolution.action === "drop") {
      return createDroppedResponse(resolution.reason).response
    }

    return rebuildResponse(input.response, resolution.body, resolution.headers)
  }

  /** Test helper to reset engine state between test cases. */
  resetForTest(): void {
    this.dropAllPending("Test reset")
    this.recent.length = 0
    this.config = cloneConfig(DEFAULT_INTERCEPT_CONFIG)
    this.stats = { forwardedCount: 0, droppedCount: 0, modifiedCount: 0 }
  }
}

function rebuildResponse(
  original: Response,
  body: string,
  headersRecord: Record<string, string>,
): Response {
  const headers = new Headers(headersRecord)
  // Body may have changed length or been decompressed during buffering
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  return new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers,
  })
}

export const interceptEngine = new InterceptEngine()
