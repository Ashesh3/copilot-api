import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Switch } from "@astryxdesign/core/Switch"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"

import type {
  InterceptAssistantConfig,
  InterceptConfig,
  InterceptDirection,
  InterceptFilterConfig,
  InterceptItemSummary,
  InterceptPendingItem,
  InterceptSnapshot,
  InterceptTimeoutAction,
} from "../../../src/lib/intercept/types"

import { EmptyState } from "../components/common"
import {
  assistantSettingsError,
  InterceptAssistantPanel,
  type InterceptAssistantDefaults,
} from "../components/InterceptAssistantPanel"
import { InterceptDetail } from "../components/InterceptDetail"
import { InterceptFiltersPanel } from "../components/InterceptFiltersPanel"
import {
  InterceptQueueRail,
  type QueueView,
} from "../components/InterceptQueueRail"
import { Page } from "../components/Page"
import { RadioIcon } from "../icons"
import { del, get, post, put } from "../lib/api"
import {
  beginInterceptDraftSnapshot,
  retainHeldInterceptDrafts,
  updateInterceptDraft,
  useInterceptDrafts,
} from "../lib/intercept-drafts"
import { useToast } from "../lib/toast"

const API = "/dashboard/api/intercept"
/** Live updates; while it is not open, the state is polled instead. */
const SOCKET_PATH = `${API}/ws`
const POLL_MS = 4000
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000

/** JSON text frames sent by the live-updates socket. */
type SocketMessage =
  | { event: "snapshot"; data: { snapshot: InterceptSnapshot } }
  | { event: "config"; data: { config: InterceptConfig } }
  | { event: "queued" | "updated"; data: { item: InterceptItemSummary } }
  | { event: "resolved"; data: { id: string } }
  | { event: "ping"; data: number }

interface InterceptStateResponse extends InterceptSnapshot {
  availableModels: Array<string>
  assistantDefaults: InterceptAssistantDefaults
}

interface ConfigUpdateResponse {
  config: InterceptConfig
  snapshot: InterceptSnapshot
}

type ScreenView = "traffic" | "rules" | "assistant"

interface RulesDraft {
  timeoutSeconds: string
  timeoutAction: InterceptTimeoutAction
  filters: InterceptFilterConfig
}

const DIRECTION_TEXT: Record<InterceptDirection, string> = {
  both: "requests and responses",
  request: "requests",
  response: "responses",
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function parseSocketMessage(data: unknown): SocketMessage | undefined {
  if (typeof data !== "string") return undefined
  try {
    return JSON.parse(data) as SocketMessage
  } catch {
    return undefined
  }
}

/** Held items stay ordered oldest first, as in the server snapshot. */
function withQueued(
  state: InterceptStateResponse,
  item: InterceptItemSummary,
): InterceptStateResponse {
  const pending = [
    ...state.pending.filter((entry) => entry.id !== item.id),
    item,
  ].sort((a, b) => a.createdAtMs - b.createdAtMs)
  return {
    ...state,
    pending,
    stats: { ...state.stats, pendingCount: pending.length },
  }
}

function replaceSummary(
  list: Array<InterceptItemSummary>,
  item: InterceptItemSummary,
): Array<InterceptItemSummary> | undefined {
  if (!list.some((entry) => entry.id === item.id)) return undefined
  return list.map((entry) => (entry.id === item.id ? item : entry))
}

/**
 * Items outside both lists have aged out of Recent (or are announced by a
 * later frame), so an update for one changes nothing shown.
 */
function withUpdated(
  state: InterceptStateResponse,
  item: InterceptItemSummary,
): InterceptStateResponse {
  const pending = replaceSummary(state.pending, item)
  if (pending) return { ...state, pending }
  const recent = replaceSummary(state.recent, item)
  return recent ? { ...state, recent } : state
}

function assistantFailureMessage(item: InterceptItemSummary): string {
  const name = `${item.phase} ${item.id.slice(0, 8)}`
  return item.assistantError ?
      `AI Assist failed for ${name}: ${item.assistantError}`
    : `AI Assist failed for ${name}`
}

function rulesFromConfig(config: InterceptConfig): RulesDraft {
  return {
    timeoutSeconds: String(config.timeoutSeconds),
    timeoutAction: config.timeoutAction,
    filters: config.filters,
  }
}

function timeoutError(value: string): string | undefined {
  const seconds = Number(value)
  return Number.isInteger(seconds) && seconds >= 15 && seconds <= 3600 ?
      undefined
    : "Enter a whole number from 15 to 3600."
}

export default function InterceptScreen() {
  const toast = useToast()
  const [state, setState] = useState<InterceptStateResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [view, setView] = useState<ScreenView>("traffic")
  const [queueView, setQueueView] = useState<QueueView>("pending")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InterceptPendingItem | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  // Unsaved payload edits per held item. The store outlives this screen, so
  // switching items, lists, views, or dashboard sections never discards them.
  const drafts = useInterceptDrafts()
  const [rulesDraft, setRulesDraft] = useState<RulesDraft | null>(null)
  const [assistantDraft, setAssistantDraft] =
    useState<InterceptAssistantConfig | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isActing, setIsActing] = useState(false)
  const [isConfirmingDisable, setIsConfirmingDisable] = useState(false)
  const [isDisabling, setIsDisabling] = useState(false)
  const effectiveIdRef = useRef<string | undefined>(undefined)
  const refreshSeqRef = useRef(0)
  /** Sequence number of the state GET still awaited, if any. */
  const refreshInFlightRef = useRef<number | undefined>(undefined)
  const hasStateRef = useRef(false)
  /** Last seen AI Assist status per item, to toast each new failure once. */
  const assistantStatusRef = useRef<ReadonlyMap<string, string> | null>(null)
  // Bumped whenever an edit response replaces the detail, so a detail GET
  // that started earlier cannot overwrite it with an older body.
  const detailWriteRef = useRef(0)

  // Each state request takes a sequence number; only the newest one, issued
  // while this screen is mounted, may update state.
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    refreshInFlightRef.current = seq
    const ticket = beginInterceptDraftSnapshot()
    try {
      const next = await get<InterceptStateResponse>(API)
      if (seq !== refreshSeqRef.current) return
      hasStateRef.current = true
      setState(next)
      retainHeldInterceptDrafts(ticket, next.pending)
      setLoadError(null)
    } catch (err) {
      if (seq !== refreshSeqRef.current) return
      setLoadError(errorMessage(err, "Could not load intercept state"))
    } finally {
      if (refreshInFlightRef.current === seq) {
        refreshInFlightRef.current = undefined
      }
    }
  }, [])

  /** Summaries and the selected item's detail, for polling and Refresh. */
  const refreshAll = useCallback(async () => {
    setDetailVersion((version) => version + 1)
    await refresh()
  }, [refresh])

  /** Edit responses for an item that is no longer selected are dropped. */
  const handleItemChange = useCallback((item: InterceptPendingItem) => {
    if (item.id !== effectiveIdRef.current) return
    detailWriteRef.current += 1
    setDetail(item)
  }, [])

  useEffect(() => {
    void refresh()
    let socket: WebSocket | undefined
    let hasOpened = false
    let retryDelay = RECONNECT_MIN_MS
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined

    // While the socket is down, poll so the page never goes stale.
    const startPolling = () => {
      pollTimer ??= setInterval(() => void refreshAll(), POLL_MS)
    }
    const stopPolling = () => {
      clearInterval(pollTimer)
      pollTimer = undefined
    }

    const reloadDetail = (id?: string) => {
      if (id === undefined || id === effectiveIdRef.current) {
        setDetailVersion((version) => version + 1)
      }
    }

    // Socket frames arrive in server order, so applying them supersedes any
    // state GET still in flight; that GET is reissued so nothing it was
    // fetched for is lost. Before the first GET lands there is nothing to
    // patch (the snapshot lacks the model list), so a GET loads everything.
    const applyEvent = (
      update: (prev: InterceptStateResponse) => InterceptStateResponse,
    ) => {
      if (!hasStateRef.current) {
        void refresh()
        return
      }
      const interrupted = refreshInFlightRef.current !== undefined
      refreshSeqRef.current += 1
      setState((prev) => (prev ? update(prev) : prev))
      if (interrupted) void refresh()
    }

    const applyMessage = (message: SocketMessage) => {
      switch (message.event) {
        case "snapshot": {
          // Drafts are pruned by GETs only: a snapshot sent by the server
          // cannot prove an item resolved before a draft for it was opened.
          const { snapshot } = message.data
          applyEvent((prev) => ({ ...prev, ...snapshot }))
          break
        }
        case "config": {
          const { config } = message.data
          applyEvent((prev) => ({ ...prev, config }))
          break
        }
        case "queued": {
          const { item } = message.data
          applyEvent((prev) => withQueued(prev, item))
          break
        }
        case "updated": {
          const { item } = message.data
          applyEvent((prev) => withUpdated(prev, item))
          reloadDetail(item.id)
          break
        }
        case "resolved": {
          // Moving an item to Recent changes counts the event does not carry.
          void refresh()
          reloadDetail(message.data.id)
          break
        }
        default: {
          // `ping` only keeps idle proxies from closing the socket.
          break
        }
      }
    }

    const handleOpen = () => {
      retryDelay = RECONNECT_MIN_MS
      stopPolling()
      // The first frame is a snapshot of the summaries; events for the
      // selected item may have been missed while disconnected.
      if (hasOpened) reloadDetail()
      hasOpened = true
    }
    const handleMessage = (event: MessageEvent) => {
      const message = parseSocketMessage(event.data)
      if (message) applyMessage(message)
    }
    // Reconnect with backoff; poll until the socket is open again.
    const handleClose = (event: CloseEvent) => {
      if (event.target !== socket) return
      socket = undefined
      startPolling()
      retryTimer = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS)
    }

    function connect() {
      retryTimer = undefined
      const url = new URL(SOCKET_PATH, globalThis.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      socket = new WebSocket(url)
      socket.addEventListener("open", handleOpen)
      socket.addEventListener("message", handleMessage)
      socket.addEventListener("close", handleClose)
    }

    startPolling()
    connect()
    const seqRef = refreshSeqRef
    return () => {
      // Responses still in flight belong to this mount; ignore them.
      seqRef.current += 1
      stopPolling()
      clearTimeout(retryTimer)
      socket?.removeEventListener("open", handleOpen)
      socket?.removeEventListener("message", handleMessage)
      socket?.removeEventListener("close", handleClose)
      socket?.close()
      socket = undefined
    }
  }, [refresh, refreshAll])

  // Toast each AI Assist failure once, when an item's status turns to error.
  useEffect(() => {
    if (!state) return
    const previous = assistantStatusRef.current
    const next = new Map<string, string>()
    for (const item of [...state.pending, ...state.recent]) {
      next.set(item.id, item.assistantStatus)
      if (
        previous
        && item.assistantStatus === "error"
        && previous.get(item.id) !== "error"
      ) {
        toast.error(assistantFailureMessage(item))
      }
    }
    assistantStatusRef.current = next
  }, [state, toast])

  const listItems =
    queueView === "pending" ? (state?.pending ?? []) : (state?.recent ?? [])
  const effectiveId =
    selectedId !== null && listItems.some((item) => item.id === selectedId) ?
      selectedId
    : listItems.at(0)?.id

  useEffect(() => {
    effectiveIdRef.current = effectiveId
  }, [effectiveId])

  useEffect(() => {
    if (effectiveId === undefined) return
    let isCurrent = true
    const writeAtStart = detailWriteRef.current
    get<InterceptPendingItem>(`${API}/items/${encodeURIComponent(effectiveId)}`)
      .then((item) => {
        if (isCurrent && writeAtStart === detailWriteRef.current) {
          setDetail(item)
        }
      })
      .catch(() => {
        // Keep what is shown for this item; the next event or Refresh retries.
        if (isCurrent) {
          setDetail((prev) => (prev?.id === effectiveId ? prev : null))
        }
      })
    return () => {
      isCurrent = false
    }
  }, [effectiveId, detailVersion])

  if (!state) {
    return (
      <Page kicker="Control" title="Intercept" fill>
        {loadError ?
          <div className="intercept-banner">
            <Banner
              status="error"
              title="Could not load Intercept"
              description={loadError}
              endContent={
                <Button
                  label="Retry"
                  variant="secondary"
                  onClick={() => void refresh()}
                />
              }
            />
          </div>
        : <div className="intercept-loading">
            <Skeleton height={32} />
            <Skeleton height={420} index={1} />
          </div>
        }
      </Page>
    )
  }

  const { config } = state
  const shownDetail = detail?.id === effectiveId ? detail : null
  const activeConditions =
    config.filters.enabled ?
      config.filters.conditions.filter((condition) => condition.enabled).length
    : 0

  const rules = rulesDraft ?? rulesFromConfig(config)
  const rulesDirty =
    rulesDraft !== null
    && JSON.stringify(rulesDraft) !== JSON.stringify(rulesFromConfig(config))
  const rulesTimeoutError = timeoutError(rules.timeoutSeconds)

  const assistant = assistantDraft ?? config.assistant
  const assistantDirty =
    assistantDraft !== null
    && JSON.stringify(assistantDraft) !== JSON.stringify(config.assistant)

  const heldDraftCount = state.pending.filter((item) =>
    drafts.has(item.id),
  ).length

  const patchConfig = async (
    patch: Partial<InterceptConfig>,
  ): Promise<boolean> => {
    const seq = ++refreshSeqRef.current
    const ticket = beginInterceptDraftSnapshot()
    try {
      const res = await put<ConfigUpdateResponse>(`${API}/config`, patch)
      if (seq === refreshSeqRef.current) {
        setState((prev) => (prev ? { ...prev, ...res.snapshot } : prev))
        retainHeldInterceptDrafts(ticket, res.snapshot.pending)
      }
      return true
    } catch (err) {
      toast.error(errorMessage(err, "Could not update Intercept"))
      void refresh()
      return false
    }
  }

  const setEnabled = async (enabled: boolean) => {
    const released = state.pending.length
    setState({ ...state, config: { ...config, enabled } })
    const saved = await patchConfig({ enabled })
    if (saved && !enabled && released > 0) {
      toast.success(
        `Intercept off. Forwarded ${released} held item${released === 1 ? "" : "s"}.`,
      )
    }
  }

  // Turning Intercept off forwards every held item as the server has it, so
  // unsaved edits would be lost silently; confirm first.
  const handleEnabledChange = (enabled: boolean) => {
    if (!enabled && heldDraftCount > 0) {
      setIsConfirmingDisable(true)
      return
    }
    void setEnabled(enabled)
  }

  const confirmDisable = async () => {
    setIsDisabling(true)
    try {
      await setEnabled(false)
      setIsConfirmingDisable(false)
    } finally {
      setIsDisabling(false)
    }
  }

  const handleDirectionChange = (value: string) => {
    const direction = value as InterceptDirection
    setState({ ...state, config: { ...config, direction } })
    void patchConfig({ direction })
  }

  const saveRules = async () => {
    if (rulesTimeoutError) return
    setIsSaving(true)
    const saved = await patchConfig({
      timeoutSeconds: Number(rules.timeoutSeconds),
      timeoutAction: rules.timeoutAction,
      filters: rules.filters,
    })
    setIsSaving(false)
    if (saved) {
      setRulesDraft(null)
      toast.success("Rules saved")
    }
  }

  const saveAssistant = async () => {
    if (assistantSettingsError(assistant)) return
    setIsSaving(true)
    const saved = await patchConfig({ assistant })
    setIsSaving(false)
    if (saved) {
      setAssistantDraft(null)
      toast.success("Assistant saved")
    }
  }

  const runBulk = async (action: "forward-all" | "drop-all") => {
    setIsActing(true)
    try {
      const res = await post<{ count: number }>(`${API}/${action}`)
      const verb = action === "forward-all" ? "Forwarded" : "Dropped"
      toast.success(
        `${verb} ${res.count} held item${res.count === 1 ? "" : "s"}`,
      )
      await refresh()
    } catch (err) {
      toast.error(errorMessage(err, "Could not update the queue"))
    } finally {
      setIsActing(false)
    }
  }

  const clearHistory = async () => {
    try {
      await del(`${API}/recent`)
      await refresh()
    } catch (err) {
      toast.error(errorMessage(err, "Could not clear history"))
    }
  }

  const renderDetail = () => {
    if (shownDetail) {
      return (
        <InterceptDetail
          key={shownDetail.id}
          item={shownDetail}
          draft={drafts.get(shownDetail.id)}
          timeoutAction={config.timeoutAction}
          onDraftUpdate={updateInterceptDraft}
          onItemChange={handleItemChange}
          onReload={refreshAll}
          onResolved={refresh}
        />
      )
    }
    if (effectiveId !== undefined) {
      return (
        <section className="intercept-detail is-empty">
          <VStack gap={3} width="100%">
            <Skeleton height={56} />
            <Skeleton height={320} index={1} />
          </VStack>
        </section>
      )
    }
    if (queueView === "recent") {
      return (
        <section className="intercept-detail is-empty">
          <EmptyState
            icon={<RadioIcon />}
            title="No history yet"
            description="Forwarded and dropped items appear here, with the edits you made."
          />
        </section>
      )
    }
    if (!config.enabled) {
      return (
        <section className="intercept-detail is-empty">
          <EmptyState
            icon={<RadioIcon />}
            title="Intercept is off"
            description="Turn it on to hold matching requests and responses here, so you can read, edit, forward, or drop them before they continue."
            actions={
              <Button
                label="Turn on Intercept"
                variant="primary"
                onClick={() => handleEnabledChange(true)}
              />
            }
          />
        </section>
      )
    }
    const filterText =
      activeConditions > 0 ?
        ` that match ${activeConditions} filter${activeConditions === 1 ? "" : "s"}`
      : ""
    const autopilotText =
      config.assistant.enabled && config.assistant.autopilot !== "off" ?
        ` Autopilot forwards ${DIRECTION_TEXT[config.assistant.autopilot]} once the assistant's changes are applied.`
      : ""
    return (
      <section className="intercept-detail is-empty">
        <EmptyState
          icon={<RadioIcon />}
          title="Nothing held right now"
          description={`Holding ${DIRECTION_TEXT[config.direction]}${filterText}. New traffic appears in the queue as it arrives.${autopilotText}`}
        />
      </section>
    )
  }

  const renderRules = () => (
    <div className="intercept-settings">
      <div className="intercept-settings-inner">
        <div className="intercept-settings-bar">
          <Text type="supporting">
            Choose what gets held, and what happens when a held item waits too
            long.
          </Text>
          <HStack gap={2}>
            {rulesDirty ?
              <Button
                label="Discard"
                variant="ghost"
                onClick={() => setRulesDraft(null)}
              />
            : null}
            <Button
              label="Save rules"
              variant="primary"
              isLoading={isSaving}
              isDisabled={!rulesDirty || rulesTimeoutError !== undefined}
              onClick={() => void saveRules()}
            />
          </HStack>
        </div>

        <Card>
          <VStack gap={3}>
            <VStack gap={0.5}>
              <Heading level={3}>Hold timeout</Heading>
              <Text type="supporting">
                A held item resolves on its own after this long, so clients
                never wait forever.
              </Text>
            </VStack>
            <div className="intercept-hold-grid">
              <TextInput
                label="Timeout (seconds)"
                description="15 to 3600"
                width={200}
                value={rules.timeoutSeconds}
                status={
                  rulesTimeoutError ?
                    { type: "error", message: rulesTimeoutError }
                  : undefined
                }
                onChange={(timeoutSeconds) =>
                  setRulesDraft({ ...rules, timeoutSeconds })
                }
              />
              <div className="intercept-field-group">
                <Text type="label">When time runs out</Text>
                <Text type="supporting">Applies to every held item</Text>
                <SegmentedControl
                  label="When time runs out"
                  value={rules.timeoutAction}
                  onChange={(value) =>
                    setRulesDraft({
                      ...rules,
                      timeoutAction: value === "drop" ? "drop" : "forward",
                    })
                  }
                >
                  <SegmentedControlItem value="forward" label="Forward" />
                  <SegmentedControlItem value="drop" label="Drop" />
                </SegmentedControl>
              </div>
            </div>
          </VStack>
        </Card>

        <InterceptFiltersPanel
          filters={rules.filters}
          onChange={(filters) => setRulesDraft({ ...rules, filters })}
        />
      </div>
    </div>
  )

  const renderAssistant = () => (
    <div className="intercept-settings">
      <div className="intercept-settings-inner">
        <div className="intercept-settings-bar">
          <Text type="supporting">
            Describe a scenario once. The assistant proposes matching edits for
            each held item.
          </Text>
          <HStack gap={2}>
            {assistantDirty ?
              <Button
                label="Discard"
                variant="ghost"
                onClick={() => setAssistantDraft(null)}
              />
            : null}
            <Button
              label="Save assistant"
              variant="primary"
              isLoading={isSaving}
              isDisabled={
                !assistantDirty
                || assistantSettingsError(assistant) !== undefined
              }
              onClick={() => void saveAssistant()}
            />
          </HStack>
        </div>
        <InterceptAssistantPanel
          assistant={assistant}
          assistantDefaults={state.assistantDefaults}
          availableModels={state.availableModels}
          onChange={setAssistantDraft}
        />
      </div>
    </div>
  )

  let assistantMarker: ReactNode
  if (config.assistant.enabled && config.assistant.autopilot !== "off") {
    assistantMarker = <Badge variant="neutral" label="Autopilot" />
  } else if (config.assistant.enabled) {
    assistantMarker = <StatusDot variant="success" label="Assistant on" />
  }

  let body = renderAssistant()
  if (view === "traffic") {
    body = (
      <div className="intercept-workbench">
        <InterceptQueueRail
          view={queueView}
          onViewChange={setQueueView}
          pending={state.pending}
          recent={state.recent}
          selectedId={effectiveId}
          onSelect={setSelectedId}
          draftIds={new Set(drafts.keys())}
          stats={state.stats}
          isIntercepting={config.enabled}
          isActing={isActing}
          onForwardAll={() => runBulk("forward-all")}
          onDropAll={() => runBulk("drop-all")}
          onClearHistory={clearHistory}
        />
        {renderDetail()}
      </div>
    )
  } else if (view === "rules") {
    body = renderRules()
  }

  return (
    <Page
      kicker="Control"
      title="Intercept"
      fill
      isRefreshing={isRefreshing}
      onRefresh={() => {
        setIsRefreshing(true)
        void refreshAll().finally(() => setIsRefreshing(false))
      }}
      actions={
        <HStack gap={3} vAlign="center" wrap="wrap">
          <HStack gap={2} vAlign="center">
            <Text type="supporting">Capture</Text>
            <SegmentedControl
              label="Capture direction"
              size="sm"
              value={config.direction}
              onChange={handleDirectionChange}
            >
              <SegmentedControlItem value="both" label="Both" />
              <SegmentedControlItem value="request" label="Requests" />
              <SegmentedControlItem value="response" label="Responses" />
            </SegmentedControl>
          </HStack>
          <Switch
            label="Intercept"
            value={config.enabled}
            onChange={handleEnabledChange}
          />
        </HStack>
      }
    >
      <div className="intercept-views">
        <TabList value={view} onChange={(next) => setView(next as ScreenView)}>
          <Tab
            value="traffic"
            label="Traffic"
            endContent={
              state.pending.length > 0 ?
                <Badge variant="neutral" label={String(state.pending.length)} />
              : undefined
            }
          />
          <Tab
            value="rules"
            label="Rules"
            endContent={
              activeConditions > 0 ?
                <Badge variant="neutral" label={String(activeConditions)} />
              : undefined
            }
          />
          <Tab
            value="assistant"
            label="AI Assist"
            endContent={assistantMarker}
          />
        </TabList>
      </div>
      {loadError ?
        <div className="intercept-banner">
          <Banner
            status="error"
            title="Lost connection to Intercept"
            description={loadError}
          />
        </div>
      : null}
      {body}
      <AlertDialog
        className="confirm-dialog"
        isOpen={isConfirmingDisable}
        onOpenChange={setIsConfirmingDisable}
        title={`Discard unsaved edits on ${heldDraftCount} item${heldDraftCount === 1 ? "" : "s"}?`}
        description="Turning Intercept off forwards every held item as the server has it. Your unsaved edits are not included."
        actionLabel="Turn off"
        actionVariant="secondary"
        isActionLoading={isDisabling}
        onAction={confirmDisable}
        width="min(400px, calc(100vw - 32px))"
      />
    </Page>
  )
}
