/* eslint-disable max-lines, no-nested-ternary */
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge"
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  AssistantDiffOp,
  CanonicalItem,
  InterceptConfig,
  InterceptDirection,
  InterceptItemSummary,
  InterceptPendingItem,
  InterceptSnapshot,
} from "../../../src/lib/intercept/types"
import type { CodeMirrorDocumentHandle } from "../components/CodeMirrorDocument"

import { CodeMirrorDocument } from "../components/CodeMirrorDocument"
import { EmptyState, MonoText, RelTime } from "../components/common"
import { InterceptAssistantPanel } from "../components/InterceptAssistantPanel"
import { InterceptDiffViewer } from "../components/InterceptDiffViewer"
import { InterceptFiltersPanel } from "../components/InterceptFiltersPanel"
import { JsonCodeEditor } from "../components/JsonCodeEditor"
import { Page } from "../components/Page"
import { StructuredMessageEditor } from "../components/StructuredMessageEditor"
import {
  ArrowRightLeftIcon,
  FilterIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "../icons"
import { ApiError, del, get, post, put } from "../lib/api"
import { validateReplayDocument } from "../lib/json-document"
import { useToast } from "../lib/toast"

interface InterceptStateResponse extends InterceptSnapshot {
  availableModels: Array<string>
}

type EditorTab = "structured" | "raw" | "headers" | "context"
type QueueTab = "pending" | "recent"
type DrawerTab = "none" | "filters" | "assistant"

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusBadgeVariant(
  status: InterceptItemSummary["status"],
): BadgeVariant {
  switch (status) {
    case "pending": {
      return "warning"
    }
    case "forwarded": {
      return "success"
    }
    case "dropped":
    case "aborted": {
      return "error"
    }
    case "timed_out": {
      return "orange"
    }
    default: {
      return "neutral"
    }
  }
}

export default function InterceptScreen() {
  const toast = useToast()
  const rawEditorRef = useRef<CodeMirrorDocumentHandle>(null)

  const [snapshot, setSnapshot] = useState<InterceptSnapshot | null>(null)
  const [availableModels, setAvailableModels] = useState<Array<string>>([])
  const [draftConfig, setDraftConfig] = useState<InterceptConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [queueTab, setQueueTab] = useState<QueueTab>("pending")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] =
    useState<InterceptPendingItem | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const [editorTab, setEditorTab] = useState<EditorTab>("structured")
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("none")
  const [wrapRaw, setWrapRaw] = useState(true)

  // Local editable buffer for the currently selected pending item
  const [draftBody, setDraftBody] = useState("")
  const [draftItems, setDraftItems] = useState<Array<CanonicalItem>>([])
  const [dirtySource, setDirtySource] = useState<"none" | "structured" | "raw">(
    "none",
  )

  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [isActing, setIsActing] = useState(false)
  const [isRunningAssistant, setIsRunningAssistant] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const refreshSnapshot = useCallback(async () => {
    try {
      const data = await get<InterceptStateResponse>("/dashboard/api/intercept")
      setSnapshot(data)
      setAvailableModels(data.availableModels)
      setDraftConfig((prev) => prev ?? data.config)
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load intercept state",
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const loadItemDetail = useCallback(async (id: string) => {
    setLoadingDetail(true)
    try {
      const detail = await get<InterceptPendingItem>(
        `/dashboard/api/intercept/items/${encodeURIComponent(id)}`,
      )
      setSelectedDetail(detail)
      setDraftBody(detail.currentBody)
      setDraftItems(detail.canonical.items)
      setDirtySource("none")
    } catch {
      setSelectedDetail(null)
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  // Initial load + SSE live updates + fallback poll
  useEffect(() => {
    void refreshSnapshot()

    const es = new EventSource("/dashboard/api/intercept/events")
    const onEvent = () => {
      void refreshSnapshot()
    }
    es.addEventListener("snapshot", onEvent)
    es.addEventListener("config", onEvent)
    es.addEventListener("queued", onEvent)
    es.addEventListener("updated", (ev) => {
      void refreshSnapshot()
      try {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as {
          item?: { id?: string }
        }
        if (parsed.item?.id && parsed.item.id === selectedId) {
          void loadItemDetail(parsed.item.id)
        }
      } catch {
        // ignore parse error
      }
    })
    es.addEventListener("resolved", (ev) => {
      void refreshSnapshot()
      try {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as {
          id?: string
        }
        if (parsed.id && parsed.id === selectedId) {
          void loadItemDetail(parsed.id)
        }
      } catch {
        // ignore
      }
    })

    const timer = setInterval(() => setNowMs(Date.now()), 1000)

    return () => {
      es.close()
      clearInterval(timer)
    }
  }, [refreshSnapshot, loadItemDetail, selectedId])

  // Auto-select first pending item when queue gets populated
  useEffect(() => {
    if (!snapshot) return
    const list = queueTab === "pending" ? snapshot.pending : snapshot.recent
    if (list.length === 0) return
    if (!selectedId || !list.some((item) => item.id === selectedId)) {
      const firstId = list[0].id
      setSelectedId(firstId)
      void loadItemDetail(firstId)
    }
  }, [snapshot, queueTab, selectedId, loadItemDetail])

  const persistConfig = useCallback(
    async (next: InterceptConfig, toastMsg?: string) => {
      setIsSavingConfig(true)
      try {
        const res = await put<{
          config: InterceptConfig
          snapshot: InterceptSnapshot
        }>("/dashboard/api/intercept/config", next)
        setDraftConfig(res.config)
        setSnapshot(res.snapshot)
        if (toastMsg) toast.success(toastMsg)
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to save config",
        )
      } finally {
        setIsSavingConfig(false)
      }
    },
    [toast],
  )

  const handleToggleEnabled = (enabled: boolean) => {
    if (!draftConfig) return
    const next = { ...draftConfig, enabled }
    setDraftConfig(next)
    void persistConfig(
      next,
      enabled ? "Interception enabled" : "Interception paused (queue released)",
    )
  }

  const handleDirectionChange = (direction: string) => {
    if (!draftConfig) return
    const next = { ...draftConfig, direction: direction as InterceptDirection }
    setDraftConfig(next)
    void persistConfig(next)
  }

  const handleSelectQueueItem = (id: string) => {
    setSelectedId(id)
    void loadItemDetail(id)
  }

  const handleForward = useCallback(async () => {
    if (!selectedDetail || selectedDetail.status !== "pending") return
    setIsActing(true)
    try {
      const payload =
        dirtySource === "structured" ? { canonicalItems: draftItems }
        : dirtySource === "raw" ? { body: draftBody }
        : undefined
      await post(
        `/dashboard/api/intercept/items/${encodeURIComponent(selectedDetail.id)}/forward`,
        payload,
      )
      toast.success(`Forwarded ${selectedDetail.phase}`)
      setDirtySource("none")
      await refreshSnapshot()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to forward")
    } finally {
      setIsActing(false)
    }
  }, [
    selectedDetail,
    dirtySource,
    draftItems,
    draftBody,
    toast,
    refreshSnapshot,
  ])

  const handleDrop = useCallback(async () => {
    if (!selectedDetail || selectedDetail.status !== "pending") return
    setIsActing(true)
    try {
      await post(
        `/dashboard/api/intercept/items/${encodeURIComponent(selectedDetail.id)}/drop`,
        { reason: "Dropped by operator in Intercept tab" },
      )
      toast.success(`Dropped ${selectedDetail.phase}`)
      await refreshSnapshot()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to drop")
    } finally {
      setIsActing(false)
    }
  }, [selectedDetail, toast, refreshSnapshot])

  const handleForwardAll = async () => {
    setIsActing(true)
    try {
      const res = await post<{ count: number }>(
        "/dashboard/api/intercept/forward-all",
      )
      toast.success(`Forwarded ${res.count} queued item(s)`)
      await refreshSnapshot()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to forward all")
    } finally {
      setIsActing(false)
    }
  }

  const handleDropAll = async () => {
    setIsActing(true)
    try {
      const res = await post<{ count: number }>(
        "/dashboard/api/intercept/drop-all",
      )
      toast.success(`Dropped ${res.count} queued item(s)`)
      await refreshSnapshot()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to drop all")
    } finally {
      setIsActing(false)
    }
  }

  const handleRunAssistant = async () => {
    if (!selectedDetail || selectedDetail.status !== "pending") return
    setIsRunningAssistant(true)
    try {
      // Save unsaved edits first so assistant sees current draft
      if (dirtySource !== "none") {
        await put(
          `/dashboard/api/intercept/items/${encodeURIComponent(selectedDetail.id)}`,
          dirtySource === "structured" ?
            { canonicalItems: draftItems }
          : { body: draftBody },
        )
        setDirtySource("none")
      }
      const updated = await post<InterceptPendingItem>(
        `/dashboard/api/intercept/items/${encodeURIComponent(selectedDetail.id)}/assistant`,
      )
      setSelectedDetail(updated)
      if (updated.assistantError) {
        toast.error(updated.assistantError)
      } else {
        toast.success("AI diff ready for review")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assistant run failed")
    } finally {
      setIsRunningAssistant(false)
    }
  }

  const handleAcceptAssistantDiff = async (ops: Array<AssistantDiffOp>) => {
    if (!selectedDetail) return
    setIsActing(true)
    try {
      const updated = await post<InterceptPendingItem>(
        `/dashboard/api/intercept/items/${encodeURIComponent(selectedDetail.id)}/assistant/apply`,
        { operations: ops },
      )
      setSelectedDetail(updated)
      setDraftBody(updated.currentBody)
      setDraftItems(updated.canonical.items)
      setDirtySource("none")
      toast.success(
        `Applied ${ops.length} AI edit(s) — review and click Forward`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply diff")
    } finally {
      setIsActing(false)
    }
  }

  const handleRejectAssistantDiff = async () => {
    if (!selectedDetail) return
    try {
      const updated = await post<InterceptPendingItem>(
        `/dashboard/api/intercept/items/${encodeURIComponent(selectedDetail.id)}/assistant/reject`,
      )
      setSelectedDetail(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject")
    }
  }

  const handleResetEdits = () => {
    if (!selectedDetail) return
    setDraftBody(selectedDetail.originalBody)
    setDraftItems(selectedDetail.canonical.items)
    setDirtySource("none")
  }

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter to Forward active pending item
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey)
        && e.key === "Enter"
        && selectedDetail?.status === "pending"
        && !isActing
      ) {
        e.preventDefault()
        void handleForward()
      }
    }
    globalThis.addEventListener("keydown", onKeyDown)
    return () => globalThis.removeEventListener("keydown", onKeyDown)
  }, [selectedDetail, isActing, handleForward])

  const rawJsonDiagnostic = useMemo(() => {
    if (!selectedDetail || selectedDetail.stream) return null
    if (
      selectedDetail.canonical.protocol === "raw_text"
      || selectedDetail.responseContentType?.includes("text/event-stream")
    ) {
      return null
    }
    const validation = validateReplayDocument(draftBody)
    return validation.ok ? null : validation.diagnostic
  }, [draftBody, selectedDetail])

  const queueItems =
    snapshot ?
      queueTab === "pending" ?
        snapshot.pending
      : snapshot.recent
    : []

  const isPending = selectedDetail?.status === "pending"
  const activeFilterCount =
    draftConfig?.filters.enabled ?
      draftConfig.filters.conditions.filter((c) => c.enabled).length
    : 0

  if (loading && !snapshot) {
    return (
      <Page kicker="Control" title="Intercept">
        <Skeleton height={48} />
        <Skeleton height={420} />
      </Page>
    )
  }

  return (
    <Page
      kicker="Control"
      title="Intercept"
      onRefresh={() => void refreshSnapshot()}
      actions={
        draftConfig ?
          <HStack gap={2} vAlign="center" wrap="wrap">
            <div
              className="intercept-master-toggle"
              data-active={draftConfig.enabled}
            >
              <StatusDot
                variant={draftConfig.enabled ? "success" : "neutral"}
                label={
                  draftConfig.enabled ? "Intercept active" : "Intercept off"
                }
              />
              <Switch
                label={draftConfig.enabled ? "Intercept ON" : "Intercept OFF"}
                value={draftConfig.enabled}
                onChange={handleToggleEnabled}
              />
            </div>

            <SegmentedControl
              label="Capture direction"
              value={draftConfig.direction}
              onChange={handleDirectionChange}
            >
              <SegmentedControlItem value="both" label="Req & Res" />
              <SegmentedControlItem value="request" label="Req Only" />
              <SegmentedControlItem value="response" label="Res Only" />
            </SegmentedControl>

            <Button
              label={
                activeFilterCount > 0 ?
                  `Filters (${activeFilterCount})`
                : "Filters"
              }
              size="sm"
              variant={drawerTab === "filters" ? "primary" : "secondary"}
              icon={<FilterIcon />}
              onClick={() =>
                setDrawerTab((cur) => (cur === "filters" ? "none" : "filters"))
              }
            />

            <Button
              label={
                draftConfig.assistant.enabled ? "AI Assist: ON" : "AI Assist"
              }
              size="sm"
              variant={drawerTab === "assistant" ? "primary" : "secondary"}
              icon={<SparklesIcon />}
              onClick={() =>
                setDrawerTab((cur) =>
                  cur === "assistant" ? "none" : "assistant",
                )
              }
            />
          </HStack>
        : null
      }
    >
      {error ?
        <Banner status="error" title="Intercept error" description={error} />
      : null}

      {/* Expandable configuration drawers for Filters or AI Assist */}
      {drawerTab === "filters" && draftConfig ?
        <InterceptFiltersPanel
          filters={draftConfig.filters}
          isSaving={isSavingConfig}
          onChange={(filters) => setDraftConfig({ ...draftConfig, filters })}
          onSave={() =>
            void persistConfig(draftConfig, "Interception filters saved")
          }
        />
      : null}

      {drawerTab === "assistant" && draftConfig ?
        <InterceptAssistantPanel
          assistant={draftConfig.assistant}
          availableModels={availableModels}
          isSaving={isSavingConfig}
          onChange={(assistant) =>
            setDraftConfig({ ...draftConfig, assistant })
          }
          onSave={() =>
            void persistConfig(draftConfig, "AI Assist settings saved")
          }
        />
      : null}

      {/* Stats & bulk actions toolbar */}
      {snapshot && draftConfig ?
        <div className="intercept-toolbar">
          <HStack gap={3} vAlign="center" wrap="wrap">
            <HStack gap={1.5} vAlign="center">
              <Badge
                variant={
                  snapshot.stats.pendingCount > 0 ? "warning" : "neutral"
                }
                label={`${snapshot.stats.pendingCount} Queued`}
              />
              <Badge
                variant="success"
                label={`${snapshot.stats.forwardedCount} Forwarded`}
              />
              <Badge
                variant="info"
                label={`${snapshot.stats.modifiedCount} Modified`}
              />
              <Badge
                variant="error"
                label={`${snapshot.stats.droppedCount} Dropped`}
              />
            </HStack>

            <HStack gap={2} vAlign="center">
              <Text type="supporting" color="secondary">
                Hold timeout (s):
              </Text>
              <div style={{ width: 88 }}>
                <TextInput
                  label="Timeout seconds"
                  isLabelHidden
                  size="sm"
                  value={String(draftConfig.timeoutSeconds)}
                  onChange={(val) => {
                    const num = Number(val)
                    if (!Number.isNaN(num)) {
                      setDraftConfig({ ...draftConfig, timeoutSeconds: num })
                    }
                  }}
                  onBlur={() => void persistConfig(draftConfig)}
                />
              </div>
            </HStack>
          </HStack>

          <HStack gap={2} vAlign="center" wrap="wrap">
            {snapshot.stats.pendingCount > 0 ?
              <>
                <Button
                  label="Forward All"
                  size="sm"
                  variant="secondary"
                  icon={<PlayIcon />}
                  isDisabled={isActing}
                  onClick={() => void handleForwardAll()}
                />
                <Button
                  label="Drop All"
                  size="sm"
                  variant="destructive"
                  icon={<XIcon />}
                  isDisabled={isActing}
                  onClick={() => void handleDropAll()}
                />
              </>
            : null}
            {queueTab === "recent" && snapshot.recent.length > 0 ?
              <Button
                label="Clear History"
                size="sm"
                variant="ghost"
                icon={<Trash2Icon />}
                onClick={() => {
                  void del("/dashboard/api/intercept/recent").then(() =>
                    refreshSnapshot(),
                  )
                }}
              />
            : null}
          </HStack>
        </div>
      : null}

      {/* Burp-style master-detail split workbench */}
      <div className="intercept-workbench">
        {/* Left Queue Sidebar */}
        <aside className="intercept-queue-pane">
          <div className="intercept-queue-header">
            <SegmentedControl
              label="Queue view"
              value={queueTab}
              onChange={(val) => {
                setQueueTab(val as QueueTab)
                setSelectedId(null)
                setSelectedDetail(null)
              }}
            >
              <SegmentedControlItem
                value="pending"
                label={`Queue (${snapshot?.pending.length ?? 0})`}
              />
              <SegmentedControlItem
                value="recent"
                label={`History (${snapshot?.recent.length ?? 0})`}
              />
            </SegmentedControl>
          </div>

          <div className="intercept-queue-list">
            {queueItems.length === 0 ?
              <div className="intercept-queue-empty">
                <Text type="supporting" color="secondary">
                  {queueTab === "pending" ?
                    draftConfig?.enabled ?
                      "Waiting for matching AI traffic…"
                    : "Turn Intercept ON above to hold and edit live traffic."
                  : "No intercepted history yet."}
                </Text>
              </div>
            : queueItems.map((item) => {
                const remainingSec = Math.max(
                  0,
                  Math.ceil((item.expiresAtMs - nowMs) / 1000),
                )
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="intercept-queue-item"
                    data-selected={selectedId === item.id}
                    onClick={() => handleSelectQueueItem(item.id)}
                  >
                    <HStack hAlign="between" vAlign="center" gap={1}>
                      <HStack gap={1} vAlign="center">
                        <Badge
                          variant={item.phase === "request" ? "blue" : "purple"}
                          label={item.phase === "request" ? "REQ" : "RES"}
                        />
                        {item.status !== "pending" ?
                          <Badge
                            variant={statusBadgeVariant(item.status)}
                            label={item.status}
                          />
                        : null}
                        {item.modified ?
                          <Badge variant="orange" label="Edited" />
                        : null}
                        {item.assistantStatus === "ready" ?
                          <Badge variant="purple" label="AI Diff" />
                        : item.assistantStatus === "running" ?
                          <Badge variant="info" label="AI…" />
                        : null}
                      </HStack>
                      <Text type="supporting" color="secondary">
                        {item.status === "pending" ?
                          `${remainingSec}s`
                        : <RelTime ts={item.createdAt} />}
                      </Text>
                    </HStack>

                    <div className="intercept-queue-model">
                      {item.model ?? item.path}
                    </div>
                    <div className="intercept-queue-meta">
                      <span>{item.path}</span>
                      <span>·</span>
                      <span>{fmtBytes(item.bodyBytes)}</span>
                    </div>
                    {item.preview ?
                      <div className="intercept-queue-preview">
                        {item.preview}
                      </div>
                    : null}
                  </button>
                )
              })
            }
          </div>
        </aside>

        {/* Right Inspector & Editor Pane */}
        <section className="intercept-editor-pane">
          {!selectedId || (!selectedDetail && !loadingDetail) ?
            <Card padding={6}>
              <EmptyState
                icon={<ArrowRightLeftIcon />}
                title="No intercepted item selected"
                description={
                  draftConfig?.enabled ?
                    "Intercept is active. Send an AI request through copilot-api and it will pause here for inspection, editing, or AI-assisted diffing."
                  : "Enable Intercept in the top bar, choose Request / Response / Both, optionally configure Filters or AI Assist, and inspect live traffic here."
                }
              />
            </Card>
          : loadingDetail && !selectedDetail ?
            <Skeleton height={360} />
          : selectedDetail ?
            <VStack gap={3}>
              {/* Action header bar */}
              <Card padding={3}>
                <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
                  <VStack gap={0.5}>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Badge
                        variant={
                          selectedDetail.phase === "request" ? "blue" : "purple"
                        }
                        label={
                          selectedDetail.phase === "request" ?
                            "OUTGOING REQUEST"
                          : `INCOMING RESPONSE${selectedDetail.responseStatus ? ` (${selectedDetail.responseStatus})` : ""}`
                        }
                      />
                      <Badge
                        variant={statusBadgeVariant(selectedDetail.status)}
                        label={selectedDetail.status.toUpperCase()}
                      />
                      <Heading level={3}>
                        {selectedDetail.model ?? selectedDetail.path}
                      </Heading>
                      {selectedDetail.stream ?
                        <Badge variant="cyan" label="SSE Stream" />
                      : null}
                    </HStack>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <MonoText>
                        {selectedDetail.method} {selectedDetail.path}
                      </MonoText>
                      {selectedDetail.sessionId ?
                        <Text type="supporting" color="secondary">
                          session:{" "}
                          <code>{selectedDetail.sessionId.slice(0, 16)}</code>
                        </Text>
                      : null}
                      <Text type="supporting" color="secondary">
                        protocol:{" "}
                        <code>{selectedDetail.canonical.protocol}</code>
                      </Text>
                    </HStack>
                  </VStack>

                  {isPending ?
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Button
                        label="Run AI Assist"
                        size="sm"
                        variant="secondary"
                        icon={<SparklesIcon />}
                        isLoading={
                          isRunningAssistant
                          || selectedDetail.assistantStatus === "running"
                        }
                        onClick={() => void handleRunAssistant()}
                      />
                      {dirtySource !== "none" || selectedDetail.modified ?
                        <Button
                          label="Reset"
                          size="sm"
                          variant="ghost"
                          icon={<RefreshCwIcon />}
                          onClick={handleResetEdits}
                        />
                      : null}
                      <Button
                        label="Drop"
                        size="sm"
                        variant="destructive"
                        icon={<ShieldAlertIcon />}
                        isLoading={isActing}
                        onClick={() => void handleDrop()}
                      />
                      <Button
                        label="Forward (Ctrl+Enter)"
                        size="sm"
                        variant="primary"
                        icon={<PlayIcon />}
                        isLoading={isActing}
                        onClick={() => void handleForward()}
                      />
                    </HStack>
                  : null}
                </HStack>
              </Card>

              {/* Assistant error or suggestion diff */}
              {selectedDetail.assistantError ?
                <Banner
                  status="error"
                  title="AI Assist failed"
                  description={selectedDetail.assistantError}
                />
              : null}

              {selectedDetail.assistantSuggestion ?
                <InterceptDiffViewer
                  suggestion={selectedDetail.assistantSuggestion}
                  currentItems={draftItems}
                  readOnly={!isPending}
                  isApplying={isActing}
                  onAccept={(ops) => void handleAcceptAssistantDiff(ops)}
                  onReject={() => void handleRejectAssistantDiff()}
                />
              : null}

              {/* Editor mode tabs */}
              <HStack hAlign="between" vAlign="center" wrap="wrap">
                <TabList
                  value={editorTab}
                  onChange={(key) => setEditorTab(key as EditorTab)}
                >
                  <Tab
                    value="structured"
                    label={`Structured (${draftItems.length})`}
                  />
                  <Tab value="raw" label="Raw Editor" />
                  <Tab
                    value="headers"
                    label={`Headers (${Object.keys(selectedDetail.headers).length})`}
                  />
                  {selectedDetail.requestContext ?
                    <Tab value="context" label="Request Context" />
                  : null}
                </TabList>

                {editorTab === "raw" ?
                  <Switch
                    label="Wrap lines"
                    value={wrapRaw}
                    onChange={setWrapRaw}
                  />
                : null}
              </HStack>

              {editorTab === "structured" ?
                <StructuredMessageEditor
                  items={draftItems}
                  readOnly={!isPending}
                  editable={selectedDetail.canonical.editable}
                  note={selectedDetail.canonical.note}
                  onChange={(nextItems) => {
                    setDraftItems(nextItems)
                    setDirtySource("structured")
                  }}
                />
              : editorTab === "raw" ?
                (
                  selectedDetail.stream
                  || selectedDetail.responseContentType?.includes(
                    "text/event-stream",
                  )
                ) ?
                  <div className="json-code-editor">
                    <div className="code-document-label">
                      Raw SSE / Text Body
                    </div>
                    <CodeMirrorDocument
                      ref={rawEditorRef}
                      ariaLabel="Raw SSE body"
                      language="text"
                      readOnly={!isPending}
                      value={draftBody}
                      wrap={wrapRaw}
                      onChange={(val) => {
                        setDraftBody(val)
                        setDirtySource("raw")
                      }}
                    />
                  </div>
                : <JsonCodeEditor
                    ref={rawEditorRef}
                    diagnostic={rawJsonDiagnostic}
                    label="Raw JSON Payload"
                    value={draftBody}
                    wrap={wrapRaw}
                    onChange={(val) => {
                      if (!isPending) return
                      setDraftBody(val)
                      setDirtySource("raw")
                    }}
                  />

              : editorTab === "headers" ?
                <Card padding={3}>
                  <div className="intercept-headers-table">
                    {Object.entries(selectedDetail.headers).map(
                      ([key, value]) => (
                        <div key={key} className="intercept-header-row">
                          <code className="intercept-header-key">{key}</code>
                          <code className="intercept-header-val">{value}</code>
                        </div>
                      ),
                    )}
                  </div>
                </Card>
              : selectedDetail.requestContext ?
                <StructuredMessageEditor
                  items={selectedDetail.requestContext.canonical.items}
                  readOnly
                  editable={false}
                  note="Read-only view of the outgoing request that triggered this response."
                  onChange={() => {}}
                />
              : null}
            </VStack>
          : null}
        </section>
      </div>
    </Page>
  )
}
