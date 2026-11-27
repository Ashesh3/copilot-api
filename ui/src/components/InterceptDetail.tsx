import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Switch } from "@astryxdesign/core/Switch"
import { proportional } from "@astryxdesign/core/Table"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Text } from "@astryxdesign/core/Text"
import { useEffect, useMemo, useState } from "react"

import type {
  AssistantDiffOp,
  CanonicalItem,
  InterceptPendingItem,
  InterceptTimeoutAction,
} from "../../../src/lib/intercept/types"

import { PlayIcon, RefreshCwIcon, SparklesIcon, XIcon } from "../icons"
import { post, put } from "../lib/api"
import {
  formatCountdown,
  STATUS_DOT,
  STATUS_LABEL,
  useNow,
} from "../lib/intercept-view"
import { validateReplayDocument } from "../lib/json-document"
import { useToast } from "../lib/toast"
import { CodeMirrorDocument } from "./CodeMirrorDocument"
import { DataTable } from "./common"
import { InterceptDiffViewer } from "./InterceptDiffViewer"
import { JsonCodeEditor } from "./JsonCodeEditor"
import { StructuredMessageEditor } from "./StructuredMessageEditor"

type DetailTab = "suggestion" | "messages" | "raw" | "headers" | "context"
type DraftSource = "none" | "structured" | "raw"
type DraftPayload = { canonicalItems: Array<CanonicalItem> } | { body: string }

interface HeaderRow extends Record<string, unknown> {
  name: string
  value: string
}

const HEADER_COLUMNS: Array<TableColumn<HeaderRow>> = [
  {
    key: "name",
    header: "Header",
    width: proportional(1),
    renderCell: (row) => <span className="intercept-mono">{row.name}</span>,
  },
  {
    key: "value",
    header: "Value",
    width: proportional(3),
    renderCell: (row) => <span className="intercept-mono">{row.value}</span>,
  },
]

function itemPath(id: string, suffix = ""): string {
  return `/dashboard/api/intercept/items/${encodeURIComponent(id)}${suffix}`
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function HoldCountdown({
  expiresAtMs,
  timeoutAction,
}: {
  expiresAtMs: number
  timeoutAction: InterceptTimeoutAction
}) {
  const now = useNow()
  return (
    <Text type="supporting">
      Held · {timeoutAction === "drop" ? "drops" : "forwards"} in{" "}
      <span className="intercept-mono">
        {formatCountdown(expiresAtMs - now)}
      </span>
    </Text>
  )
}

export interface InterceptDetailProps {
  item: InterceptPendingItem
  timeoutAction: InterceptTimeoutAction
  onItemChange: (item: InterceptPendingItem) => void
  onResolved: () => Promise<void>
}

export function InterceptDetail({
  item,
  timeoutAction,
  onItemChange,
  onResolved,
}: InterceptDetailProps) {
  const toast = useToast()
  const isPending = item.status === "pending"
  // Only responses carry SSE bodies; a request asking for `stream: true` is JSON.
  const isStream =
    item.phase === "response"
    && (item.stream === true
      || item.responseContentType?.includes("text/event-stream") === true)

  const [tab, setTab] = useState<DetailTab>(
    item.assistantSuggestion ? "suggestion" : "messages",
  )
  const [wrap, setWrap] = useState(true)
  const [draftBody, setDraftBody] = useState(item.currentBody)
  const [draftItems, setDraftItems] = useState(item.canonical.items)
  const [draftSource, setDraftSource] = useState<DraftSource>("none")
  const [syncedBody, setSyncedBody] = useState(item.currentBody)
  const [isActing, setIsActing] = useState(false)
  const [isRunningAssistant, setIsRunningAssistant] = useState(false)

  // Server-side changes (applied suggestion, revert, live updates) replace the
  // drafts only while the operator has no unsaved edits of their own.
  if (syncedBody !== item.currentBody && draftSource === "none") {
    setSyncedBody(item.currentBody)
    setDraftBody(item.currentBody)
    setDraftItems(item.canonical.items)
  }

  let activeTab = tab
  if (
    (tab === "suggestion" && !item.assistantSuggestion)
    || (tab === "context" && !item.requestContext)
  ) {
    activeTab = "messages"
  }

  const rawDiagnostic = useMemo(() => {
    if (isStream || item.canonical.protocol === "raw_text") return null
    const result = validateReplayDocument(draftBody)
    return result.ok ? null : result.diagnostic
  }, [draftBody, isStream, item.canonical.protocol])

  const headerRows = useMemo<Array<HeaderRow>>(
    () =>
      Object.entries(item.headers).map(([name, value]) => ({ name, value })),
    [item.headers],
  )

  function draftPayload(): DraftPayload | undefined {
    if (draftSource === "structured") return { canonicalItems: draftItems }
    if (draftSource === "raw") return { body: draftBody }
    return undefined
  }

  /** Persist local edits server-side so every view and the assistant see them. */
  async function commitDraft(): Promise<boolean> {
    const payload = draftPayload()
    if (!payload) return true
    try {
      const updated = await put<InterceptPendingItem>(
        itemPath(item.id),
        payload,
      )
      setDraftSource("none")
      onItemChange(updated)
      return true
    } catch (err) {
      toast.error(errorMessage(err, "Could not save your edits"))
      return false
    }
  }

  function discardDraft() {
    setDraftSource("none")
    setSyncedBody(item.currentBody)
    setDraftBody(item.currentBody)
    setDraftItems(item.canonical.items)
  }

  async function revertToOriginal() {
    setIsActing(true)
    try {
      onItemChange(
        await put<InterceptPendingItem>(itemPath(item.id), {
          body: item.originalBody,
        }),
      )
    } catch (err) {
      toast.error(errorMessage(err, "Could not revert"))
    } finally {
      setIsActing(false)
    }
  }

  async function forward() {
    if (!isPending || isActing) return
    if (draftSource === "raw" && rawDiagnostic) {
      toast.error("Fix the JSON error before forwarding")
      return
    }
    setIsActing(true)
    try {
      await post(itemPath(item.id, "/forward"), draftPayload())
      setDraftSource("none")
      toast.success(
        item.phase === "request" ?
          "Request sent upstream"
        : "Response sent to client",
      )
      await onResolved()
    } catch (err) {
      toast.error(errorMessage(err, "Could not forward"))
    } finally {
      setIsActing(false)
    }
  }

  async function drop() {
    setIsActing(true)
    try {
      await post(itemPath(item.id, "/drop"), {
        reason: "Dropped by operator",
      })
      toast.success(
        item.phase === "request" ?
          "Request dropped; client received an error"
        : "Response dropped; client received an error",
      )
      await onResolved()
    } catch (err) {
      toast.error(errorMessage(err, "Could not drop"))
    } finally {
      setIsActing(false)
    }
  }

  async function runAssistant() {
    setIsRunningAssistant(true)
    try {
      if (!(await commitDraft())) return
      const updated = await post<InterceptPendingItem>(
        itemPath(item.id, "/assistant"),
      )
      onItemChange(updated)
      if (updated.assistantError) {
        toast.error(updated.assistantError)
      } else {
        setTab("suggestion")
      }
    } catch (err) {
      toast.error(errorMessage(err, "AI Assist failed"))
    } finally {
      setIsRunningAssistant(false)
    }
  }

  async function applySuggestion(operations: Array<AssistantDiffOp>) {
    setIsActing(true)
    try {
      onItemChange(
        await post<InterceptPendingItem>(
          itemPath(item.id, "/assistant/apply"),
          { operations },
        ),
      )
      setTab("messages")
      toast.success(
        `Applied ${operations.length} change${operations.length === 1 ? "" : "s"}. Review, then forward.`,
      )
    } catch (err) {
      toast.error(errorMessage(err, "Could not apply the suggestion"))
    } finally {
      setIsActing(false)
    }
  }

  async function rejectSuggestion() {
    try {
      onItemChange(
        await post<InterceptPendingItem>(
          itemPath(item.id, "/assistant/reject"),
        ),
      )
    } catch (err) {
      toast.error(errorMessage(err, "Could not dismiss the suggestion"))
    }
  }

  function handleTabChange(next: string) {
    const nextTab = next as DetailTab
    const leavingEdits =
      (activeTab === "messages" && draftSource === "structured")
      || (activeTab === "raw" && draftSource === "raw")
    if (!leavingEdits || (nextTab !== "messages" && nextTab !== "raw")) {
      setTab(nextTab)
      return
    }
    if (draftSource === "raw" && rawDiagnostic) {
      toast.error("Fix the JSON error before switching views")
      return
    }
    void commitDraft().then((saved) => {
      if (saved) setTab(nextTab)
    })
  }

  useEffect(() => {
    if (!isPending) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey)
        && event.key === "Enter"
        && !event.defaultPrevented
      ) {
        event.preventDefault()
        void forward()
      }
    }
    globalThis.addEventListener("keydown", handleKeyDown)
    return () => globalThis.removeEventListener("keydown", handleKeyDown)
  })

  let revertAction = null
  if (draftSource !== "none") {
    revertAction = (
      <Button
        label="Discard edits"
        size="sm"
        variant="ghost"
        onClick={discardDraft}
      />
    )
  } else if (item.modified) {
    revertAction = (
      <Button
        label="Revert to original"
        size="sm"
        variant="ghost"
        icon={<RefreshCwIcon />}
        isDisabled={isActing}
        onClick={() => void revertToOriginal()}
      />
    )
  }

  function renderBody() {
    switch (activeTab) {
      case "suggestion": {
        return item.assistantSuggestion ?
            <InterceptDiffViewer
              key={item.assistantSuggestion.id}
              suggestion={item.assistantSuggestion}
              currentItems={item.canonical.items}
              readOnly={!isPending}
              canApply={draftSource === "none"}
              isApplying={isActing}
              onApply={(ops) => void applySuggestion(ops)}
              onReject={() => void rejectSuggestion()}
            />
          : null
      }
      case "raw": {
        if (!isPending || isStream) {
          return (
            <CodeMirrorDocument
              ariaLabel={isStream ? "Raw event stream" : "Raw JSON"}
              language={isStream ? "text" : "json"}
              readOnly={!isPending}
              value={draftBody}
              wrap={wrap}
              onChange={(value) => {
                setDraftBody(value)
                setDraftSource("raw")
              }}
            />
          )
        }
        return (
          <JsonCodeEditor
            diagnostic={rawDiagnostic}
            label="Raw JSON"
            value={draftBody}
            wrap={wrap}
            onChange={(value) => {
              setDraftBody(value)
              setDraftSource("raw")
            }}
          />
        )
      }
      case "headers": {
        return (
          <DataTable data={headerRows} columns={HEADER_COLUMNS} idKey="name" />
        )
      }
      case "context": {
        return item.requestContext ?
            <>
              <Text type="supporting">
                The request that produced this response. Read-only.
              </Text>
              <StructuredMessageEditor
                items={item.requestContext.canonical.items}
                readOnly
                editable={false}
              />
            </>
          : null
      }
      default: {
        return (
          <>
            {item.canonical.note ?
              <Text type="supporting">{item.canonical.note}</Text>
            : null}
            {item.canonical.editable ? null : (
              <Text type="supporting">
                This payload has no message structure. Edit it in Raw.
              </Text>
            )}
            <StructuredMessageEditor
              items={draftItems}
              readOnly={!isPending}
              editable={item.canonical.editable}
              onChange={(next) => {
                setDraftItems(next)
                setDraftSource("structured")
              }}
            />
          </>
        )
      }
    }
  }

  return (
    <section className="intercept-detail" aria-label="Intercepted item">
      <header className="intercept-detail-head">
        <div className="intercept-detail-title">
          <div className="intercept-detail-title-row">
            <Badge
              variant="neutral"
              label={
                item.phase === "request" ?
                  "Request"
                : `Response ${item.responseStatus ?? ""}`.trim()
              }
            />
            <Text type="code" weight="semibold" maxLines={1}>
              {item.model ?? item.path}
            </Text>
            <span className="intercept-row-status">
              <StatusDot
                variant={STATUS_DOT[item.status]}
                label={STATUS_LABEL[item.status]}
                isPulsing={isPending}
              />
              {isPending ?
                <HoldCountdown
                  expiresAtMs={item.expiresAtMs}
                  timeoutAction={timeoutAction}
                />
              : <Text type="supporting">{STATUS_LABEL[item.status]}</Text>}
            </span>
          </div>
          <div className="intercept-detail-meta">
            <code>
              {item.method} {item.path}
            </code>
            <code>{item.canonical.protocol}</code>
            {item.stream ?
              <span>{isStream ? "event stream" : "streaming"}</span>
            : null}
            <span>
              {item.upstream === "custom" ?
                <>
                  provider <code>{item.providerId}</code>
                </>
              : "Copilot"}
            </span>
            {item.sessionId ?
              <span>
                session <code>{item.sessionId}</code>
              </span>
            : null}
          </div>
        </div>

        {isPending ?
          <div className="intercept-detail-actions">
            <Button
              label="Run AI Assist"
              size="sm"
              variant="secondary"
              icon={<SparklesIcon />}
              isLoading={
                isRunningAssistant || item.assistantStatus === "running"
              }
              isDisabled={isActing}
              onClick={() => void runAssistant()}
            />
            {revertAction}
            <Button
              label="Drop"
              size="sm"
              variant="destructive"
              icon={<XIcon />}
              isDisabled={isActing}
              onClick={() => void drop()}
            />
            <Button
              label="Forward"
              size="sm"
              variant="primary"
              icon={<PlayIcon />}
              tooltip="Forward (Ctrl+Enter)"
              isLoading={isActing}
              onClick={() => void forward()}
            />
          </div>
        : null}
      </header>

      <div className="intercept-detail-tabs">
        <TabList size="sm" value={activeTab} onChange={handleTabChange}>
          {item.assistantSuggestion ?
            <Tab
              value="suggestion"
              label="AI suggestion"
              endContent={
                <Badge
                  variant="neutral"
                  label={String(item.assistantSuggestion.operations.length)}
                />
              }
            />
          : null}
          <Tab
            value="messages"
            label="Messages"
            endContent={
              <Badge variant="neutral" label={String(draftItems.length)} />
            }
          />
          <Tab value="raw" label="Raw" />
          <Tab
            value="headers"
            label="Headers"
            endContent={
              <Badge variant="neutral" label={String(headerRows.length)} />
            }
          />
          {item.requestContext ?
            <Tab value="context" label="Request" />
          : null}
        </TabList>
        {activeTab === "raw" ?
          <Switch label="Wrap lines" value={wrap} onChange={setWrap} />
        : null}
      </div>

      <div
        className={
          activeTab === "raw" ?
            "intercept-detail-body is-fill"
          : "intercept-detail-body"
        }
      >
        {item.assistantError ?
          <Banner
            status="error"
            title="AI Assist failed"
            description={item.assistantError}
          />
        : null}
        {renderBody()}
      </div>
    </section>
  )
}
