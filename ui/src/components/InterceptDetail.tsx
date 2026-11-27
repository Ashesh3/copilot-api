import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Switch } from "@astryxdesign/core/Switch"
import { proportional } from "@astryxdesign/core/Table"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Text } from "@astryxdesign/core/Text"
import { useEffect, useMemo, useRef, useState } from "react"

import type {
  CanonicalItem,
  InterceptPendingItem,
  InterceptTimeoutAction,
} from "../../../src/lib/intercept/types"

import { PlayIcon, RefreshCwIcon, SparklesIcon, XIcon } from "../icons"
import { ApiError, post, put } from "../lib/api"
import { clearInterceptDraftsOnAuthError } from "../lib/intercept-drafts"
import {
  formatCountdown,
  type InterceptDraft,
  type InterceptDraftUpdate,
  responseJsonDiagnostic,
  STATUS_DOT,
  STATUS_LABEL,
  useNow,
} from "../lib/intercept-view"
import { validateReplayDocument } from "../lib/json-document"
import { useToast } from "../lib/toast"
import { CodeMirrorDocument } from "./CodeMirrorDocument"
import { DataTable } from "./common"
import {
  type AssistantApplyRequest,
  InterceptDiffViewer,
} from "./InterceptDiffViewer"
import { JsonCodeEditor } from "./JsonCodeEditor"
import { StructuredMessageEditor } from "./StructuredMessageEditor"

type DetailTab = "suggestion" | "messages" | "raw" | "headers" | "context"
// `baseRevision` makes the server refuse (409) an edit written against an
// older revision instead of silently overwriting newer changes.
type DraftPayload =
  | { canonicalItems: Array<CanonicalItem>; baseRevision: number }
  | { body: string; baseRevision: number }

const CONFLICT_MESSAGE =
  "This item changed on the server. Resolve the notice above your edits first."

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
  /** Unsaved edits for this item; the screen owns them so they outlive the inspector. */
  draft: InterceptDraft | undefined
  timeoutAction: InterceptTimeoutAction
  onDraftUpdate: (id: string, update: InterceptDraftUpdate) => void
  onItemChange: (item: InterceptPendingItem) => void
  /** Refetches this item (and the queue) after the server reported it stale. */
  onReload: () => Promise<void>
  onResolved: () => Promise<void>
}

export function InterceptDetail({
  item,
  draft: heldDraft,
  timeoutAction,
  onDraftUpdate,
  onItemChange,
  onReload,
  onResolved,
}: InterceptDetailProps) {
  const toast = useToast()
  const isPending = item.status === "pending"
  // Only responses carry SSE bodies; a request asking for `stream: true` is JSON.
  const isStream =
    item.phase === "response"
    && (item.stream === true
      || item.responseContentType?.includes("text/event-stream") === true)
  const isText = isStream || item.canonical.protocol === "raw_text"

  // A resolved item can no longer change, so any leftover draft is moot.
  const draft = isPending ? heldDraft : undefined
  const isSaving = draft?.savingEdits !== undefined
  // The server item changed under an unsaved draft (another operator, a
  // revert, an applied suggestion). Neither side wins until the operator chooses.
  const hasConflict =
    draft !== undefined && !isSaving && draft.baseRevision !== item.revision
  const structuredItems =
    draft?.source === "structured" ? draft.items : item.canonical.items
  const rawBody = draft?.source === "raw" ? draft.body : item.currentBody

  const [tab, setTab] = useState<DetailTab>(
    item.assistantSuggestion ? "suggestion" : "messages",
  )
  const [wrap, setWrap] = useState(true)
  const [isActing, setIsActing] = useState(false)
  const [isRunningAssistant, setIsRunningAssistant] = useState(false)

  let activeTab = tab
  if (
    (tab === "suggestion" && !item.assistantSuggestion)
    || (tab === "context" && !item.requestContext)
  ) {
    activeTab = "messages"
  }
  // Only the editor that owns a draft may show the payload; the other one
  // would display a stale document.
  if (activeTab === "messages" && draft?.source === "raw") {
    activeTab = "raw"
  } else if (activeTab === "raw" && draft?.source === "structured") {
    activeTab = "messages"
  }

  const rawDiagnostic = useMemo(() => {
    if (isText) return null
    // Responses (including upstream errors) need not look like a request.
    if (item.phase === "response") return responseJsonDiagnostic(rawBody)
    const result = validateReplayDocument(rawBody)
    return result.ok ? null : result.diagnostic
  }, [isText, item.phase, rawBody])

  const headerRows = useMemo<Array<HeaderRow>>(
    () =>
      Object.entries(item.headers).map(([name, value]) => ({ name, value })),
    [item.headers],
  )

  const updateDraft = (update: InterceptDraftUpdate) =>
    onDraftUpdate(item.id, update)

  /**
   * 401: the admin session ended, so every draft goes. 409: the item moved on
   * (new revision or suggestion); refetch so the operator sees the current state.
   */
  function reportError(err: unknown, fallback: string) {
    clearInterceptDraftsOnAuthError(err)
    if (err instanceof ApiError && err.status === 409) void onReload()
    toast.error(err instanceof Error ? err.message : fallback)
  }

  function editStructured(items: Array<CanonicalItem>) {
    updateDraft((prev) => ({
      source: "structured",
      items,
      baseRevision: prev?.baseRevision ?? item.revision,
      edits: (prev?.edits ?? 0) + 1,
      savingEdits: prev?.savingEdits,
    }))
  }

  function editRaw(body: string) {
    updateDraft((prev) => ({
      source: "raw",
      body,
      baseRevision: prev?.baseRevision ?? item.revision,
      edits: (prev?.edits ?? 0) + 1,
      savingEdits: prev?.savingEdits,
    }))
  }

  /** Persist local edits server-side so every view and the assistant see them. */
  async function commitDraft(): Promise<boolean> {
    if (!draft) return true
    if (isSaving) return false
    if (hasConflict) {
      toast.error(CONFLICT_MESSAGE)
      return false
    }
    if (draft.source === "raw" && rawDiagnostic) {
      toast.error("Fix the JSON error first")
      return false
    }
    const sentEdits = draft.edits
    const payload: DraftPayload =
      draft.source === "structured" ?
        { canonicalItems: draft.items, baseRevision: draft.baseRevision }
      : { body: draft.body, baseRevision: draft.baseRevision }
    updateDraft((prev) => prev && { ...prev, savingEdits: sentEdits })
    try {
      const updated = await put<InterceptPendingItem>(
        itemPath(item.id),
        payload,
      )
      // Edits typed while the save was in flight stay dirty, now based on
      // the body the server acknowledged.
      updateDraft((prev) => {
        if (!prev || prev.edits === sentEdits) return undefined
        return {
          ...prev,
          savingEdits: undefined,
          baseRevision: updated.revision,
        }
      })
      onItemChange(updated)
      return true
    } catch (err) {
      updateDraft((prev) => prev && { ...prev, savingEdits: undefined })
      reportError(err, "Could not save your edits")
      return false
    }
  }

  function discardDraft() {
    updateDraft(() => undefined)
  }

  /**
   * Raw drafts only: a raw body is a full replacement, so it may overwrite.
   * Rebasing onto the current revision makes the next save that overwrite.
   */
  function keepDraft() {
    updateDraft((prev) =>
      prev?.source === "raw" ? { ...prev, baseRevision: item.revision } : prev,
    )
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
      reportError(err, "Could not revert")
    } finally {
      setIsActing(false)
    }
  }

  async function forward() {
    if (!isPending || isActing || isSaving) return
    if (hasConflict) {
      toast.error(CONFLICT_MESSAGE)
      return
    }
    if (draft?.source === "raw" && rawDiagnostic) {
      toast.error("Fix the JSON error before forwarding")
      return
    }
    let payload: DraftPayload | undefined
    if (draft?.source === "structured") {
      payload = {
        canonicalItems: draft.items,
        baseRevision: draft.baseRevision,
      }
    } else if (draft?.source === "raw") {
      payload = { body: draft.body, baseRevision: draft.baseRevision }
    }
    setIsActing(true)
    try {
      await post(itemPath(item.id, "/forward"), payload)
      updateDraft(() => undefined)
      toast.success(
        item.phase === "request" ?
          "Request sent upstream"
        : "Response sent to client",
      )
      await onResolved()
    } catch (err) {
      // The draft stays dirty so the operator can fix it and try again.
      reportError(err, "Could not forward")
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
      reportError(err, "Could not drop")
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
      reportError(err, "AI Assist failed")
    } finally {
      setIsRunningAssistant(false)
    }
  }

  async function applySuggestion(request: AssistantApplyRequest) {
    setIsActing(true)
    try {
      onItemChange(
        await post<InterceptPendingItem>(
          itemPath(item.id, "/assistant/apply"),
          request,
        ),
      )
      setTab("messages")
      const count = request.operations.length
      toast.success(
        `Applied ${count} change${count === 1 ? "" : "s"}. Review, then forward.`,
      )
    } catch (err) {
      reportError(err, "Could not apply the suggestion")
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
      reportError(err, "Could not dismiss the suggestion")
    }
  }

  function handleTabChange(next: string) {
    const nextTab = next as DetailTab
    // Opening the other editor from any tab first saves the draft, so the
    // destination shows (and Forward sends) the same document.
    const opensOtherEditor =
      (nextTab === "raw" && draft?.source === "structured")
      || (nextTab === "messages" && draft?.source === "raw")
    if (!opensOtherEditor) {
      setTab(nextTab)
      return
    }
    void commitDraft().then((saved) => {
      if (saved) setTab(nextTab)
    })
  }

  // The listener registers once per held item and always calls the latest
  // `forward`, which closes over the current draft.
  const forwardRef = useRef(forward)
  useEffect(() => {
    forwardRef.current = forward
  })

  useEffect(() => {
    if (!isPending) return
    // Capture phase on the window runs before CodeMirror's keymap, which
    // would otherwise turn Mod-Enter into a newline while Raw has focus.
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.key !== "Enter") return
      // Dialogs own their keyboard; Mod-Enter there must not forward.
      if (
        event.target instanceof Element
        && event.target.closest("dialog, [role='dialog'], [role='alertdialog']")
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      // A held key repeats; forward once.
      if (!event.repeat) void forwardRef.current()
    }
    globalThis.addEventListener("keydown", handleKeyDown, { capture: true })
    return () =>
      globalThis.removeEventListener("keydown", handleKeyDown, {
        capture: true,
      })
  }, [isPending])

  let revertAction = null
  if (draft) {
    revertAction = (
      <Button
        label="Discard edits"
        size="sm"
        variant="ghost"
        isDisabled={isSaving}
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
              canApply={draft === undefined}
              isApplying={isActing}
              onApply={(request) => void applySuggestion(request)}
              onReject={() => void rejectSuggestion()}
            />
          : null
      }
      case "raw": {
        if (!isPending || isText) {
          let ariaLabel = "Raw JSON"
          if (isStream) ariaLabel = "Raw event stream"
          else if (isText) ariaLabel = "Raw text"
          return (
            <CodeMirrorDocument
              ariaLabel={ariaLabel}
              language={isText ? "text" : "json"}
              readOnly={!isPending}
              value={rawBody}
              wrap={wrap}
              onChange={editRaw}
            />
          )
        }
        return (
          <JsonCodeEditor
            diagnostic={rawDiagnostic}
            label="Raw JSON"
            value={rawBody}
            wrap={wrap}
            onChange={editRaw}
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
                {item.canonical.readOnlyReason
                  ?? "This payload has no message structure."}
                {isPending ? " Edit it in Raw." : null}
              </Text>
            )}
            <StructuredMessageEditor
              items={structuredItems}
              originalItems={item.canonical.items}
              readOnly={!isPending}
              editable={item.canonical.editable}
              isDisabled={isSaving || isActing}
              onChange={editStructured}
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
              : <Text type="supporting">
                  {item.autopilot && item.status === "forwarded" ?
                    "Forwarded by Autopilot"
                  : STATUS_LABEL[item.status]}
                </Text>
              }
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
              isDisabled={isActing || isSaving}
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
              isDisabled={isSaving}
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
              <Badge variant="neutral" label={String(structuredItems.length)} />
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
        {hasConflict && draft.source === "structured" ?
          <Banner
            status="warning"
            title="Changed on the server"
            description="The held payload changed while you had unsaved message edits, so they can't be re-applied safely. Copy any text you want to keep, then discard your edits to load the server version."
            endContent={
              <Button
                label="Discard mine"
                size="sm"
                variant="secondary"
                onClick={discardDraft}
              />
            }
          />
        : null}
        {hasConflict && draft.source === "raw" ?
          <Banner
            status="warning"
            title="Changed on the server"
            description="This item changed while you had unsaved raw edits. Discard yours to load the server version, or keep yours to replace it when you save or forward."
            endContent={
              <HStack gap={2}>
                <Button
                  label="Discard mine"
                  size="sm"
                  variant="ghost"
                  onClick={discardDraft}
                />
                <Button
                  label="Keep mine"
                  size="sm"
                  variant="secondary"
                  onClick={keepDraft}
                />
              </HStack>
            }
          />
        : null}
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
