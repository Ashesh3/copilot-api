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
import type {
  InterceptDraft,
  InterceptDraftUpdate,
} from "../lib/intercept-view"

import { EmptyState } from "../components/common"
import { InterceptAssistantPanel } from "../components/InterceptAssistantPanel"
import { InterceptDetail } from "../components/InterceptDetail"
import { InterceptFiltersPanel } from "../components/InterceptFiltersPanel"
import {
  InterceptQueueRail,
  type QueueView,
} from "../components/InterceptQueueRail"
import { Page } from "../components/Page"
import { RadioIcon } from "../icons"
import { del, get, post, put } from "../lib/api"
import { useToast } from "../lib/toast"

const API = "/dashboard/api/intercept"

interface InterceptStateResponse extends InterceptSnapshot {
  availableModels: Array<string>
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

/** Item id carried by `queued` / `updated` (item.id) and `resolved` (id) events. */
function eventItemId(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { id?: unknown; item?: { id?: unknown } }
    const id = parsed.item?.id ?? parsed.id
    return typeof id === "string" ? id : undefined
  } catch {
    return undefined
  }
}

/** Drafts only matter while their item is held; resolved items cannot change. */
function retainHeldDrafts(
  drafts: ReadonlyMap<string, InterceptDraft>,
  pending: ReadonlyArray<InterceptItemSummary>,
): ReadonlyMap<string, InterceptDraft> {
  const held = new Set(pending.map((item) => item.id))
  if ([...drafts.keys()].every((id) => held.has(id))) return drafts
  return new Map([...drafts].filter(([id]) => held.has(id)))
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
  // Unsaved payload edits per held item; they outlive the inspector, so
  // switching items, lists, or views never discards them.
  const [drafts, setDrafts] = useState<ReadonlyMap<string, InterceptDraft>>(
    () => new Map(),
  )
  const [rulesDraft, setRulesDraft] = useState<RulesDraft | null>(null)
  const [assistantDraft, setAssistantDraft] =
    useState<InterceptAssistantConfig | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isActing, setIsActing] = useState(false)
  const effectiveIdRef = useRef<string | undefined>(undefined)
  const refreshSeqRef = useRef(0)
  // Bumped whenever an edit response replaces the detail, so a detail GET
  // that started earlier cannot overwrite it with an older body.
  const detailWriteRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    try {
      const next = await get<InterceptStateResponse>(API)
      if (seq !== refreshSeqRef.current) return
      setState(next)
      setDrafts((prev) => retainHeldDrafts(prev, next.pending))
      setLoadError(null)
    } catch (err) {
      if (seq !== refreshSeqRef.current) return
      setLoadError(errorMessage(err, "Could not load intercept state"))
    }
  }, [])

  /** Summaries and the selected item's detail, for reconnects and Refresh. */
  const refreshAll = useCallback(async () => {
    setDetailVersion((version) => version + 1)
    await refresh()
  }, [refresh])

  const updateDraft = useCallback(
    (id: string, update: InterceptDraftUpdate) => {
      setDrafts((prev) => {
        const current = prev.get(id)
        const next = update(current)
        if (next === current) return prev
        const updated = new Map(prev)
        if (next) updated.set(id, next)
        else updated.delete(id)
        return updated
      })
    },
    [],
  )

  /** Edit responses for an item that is no longer selected are dropped. */
  const handleItemChange = useCallback((item: InterceptPendingItem) => {
    if (item.id !== effectiveIdRef.current) return
    detailWriteRef.current += 1
    setDetail(item)
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource(`${API}/events`)
    let hasOpened = false
    // Events may have been missed while disconnected; reload the selected
    // detail as well as the summaries.
    const handleOpen = () => {
      if (hasOpened) void refreshAll()
      hasOpened = true
    }
    const handleStateEvent = () => {
      void refresh()
    }
    const handleItemEvent = (event: MessageEvent<string>) => {
      void refresh()
      const id = eventItemId(event.data)
      if (id !== undefined && id === effectiveIdRef.current) {
        setDetailVersion((version) => version + 1)
      }
    }
    source.addEventListener("open", handleOpen)
    source.addEventListener("snapshot", handleStateEvent)
    source.addEventListener("config", handleStateEvent)
    source.addEventListener("queued", handleStateEvent)
    source.addEventListener("updated", handleItemEvent)
    source.addEventListener("resolved", handleItemEvent)
    return () => {
      source.removeEventListener("open", handleOpen)
      source.removeEventListener("snapshot", handleStateEvent)
      source.removeEventListener("config", handleStateEvent)
      source.removeEventListener("queued", handleStateEvent)
      source.removeEventListener("updated", handleItemEvent)
      source.removeEventListener("resolved", handleItemEvent)
      source.close()
    }
  }, [refresh, refreshAll])

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

  const patchConfig = async (
    patch: Partial<InterceptConfig>,
  ): Promise<boolean> => {
    try {
      const res = await put<ConfigUpdateResponse>(`${API}/config`, patch)
      setState((prev) => (prev ? { ...prev, ...res.snapshot } : prev))
      setDrafts((prev) => retainHeldDrafts(prev, res.snapshot.pending))
      return true
    } catch (err) {
      toast.error(errorMessage(err, "Could not update Intercept"))
      void refresh()
      return false
    }
  }

  const handleEnabledChange = (enabled: boolean) => {
    const released = state.pending.length
    setState({ ...state, config: { ...config, enabled } })
    void patchConfig({ enabled }).then((saved) => {
      if (saved && !enabled && released > 0) {
        toast.success(
          `Intercept off. Forwarded ${released} held item${released === 1 ? "" : "s"}.`,
        )
      }
    })
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
          onDraftUpdate={updateDraft}
          onItemChange={handleItemChange}
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
              isDisabled={!assistantDirty}
              onClick={() => void saveAssistant()}
            />
          </HStack>
        </div>
        <InterceptAssistantPanel
          assistant={assistant}
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
    </Page>
  )
}
