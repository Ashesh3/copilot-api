import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { List, ListItem } from "@astryxdesign/core/List"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { HStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Text } from "@astryxdesign/core/Text"

import type {
  InterceptItemSummary,
  InterceptSnapshot,
} from "../../../src/lib/intercept/types"

import { PlayIcon, Trash2Icon, XIcon } from "../icons"
import {
  fmtBytes,
  formatCountdown,
  STATUS_DOT,
  STATUS_LABEL,
  useNow,
} from "../lib/intercept-view"
import { ConfirmButton, RelTime } from "./common"

export type QueueView = "pending" | "recent"

interface InterceptQueueRailProps {
  view: QueueView
  onViewChange: (view: QueueView) => void
  pending: Array<InterceptItemSummary>
  recent: Array<InterceptItemSummary>
  selectedId: string | undefined
  onSelect: (id: string) => void
  /** Held items with unsaved local edits. */
  draftIds: ReadonlySet<string>
  stats: InterceptSnapshot["stats"]
  isIntercepting: boolean
  isActing: boolean
  onForwardAll: () => Promise<void>
  onDropAll: () => Promise<void>
  onClearHistory: () => Promise<void>
}

function QueueRow({
  item,
  isSelected,
  hasDraft,
  now,
  onSelect,
}: {
  item: InterceptItemSummary
  isSelected: boolean
  hasDraft: boolean
  now: number
  onSelect: (id: string) => void
}) {
  // The Autopilot status already accounts for any assistant edits; skip the extra flag.
  const statusLabel =
    item.autopilot && item.status === "forwarded" ?
      "Autopilot"
    : STATUS_LABEL[item.status]
  const flags = [
    hasDraft ? "unsaved edits" : null,
    item.modified && !item.autopilot ? "edited" : null,
    item.assistantStatus === "ready" ? "AI suggestion" : null,
    item.assistantStatus === "running" ? "AI running" : null,
  ].filter((flag) => flag !== null)

  return (
    <ListItem
      isSelected={isSelected}
      onClick={() => onSelect(item.id)}
      label={
        <span className="intercept-row-title">
          <Badge
            variant="neutral"
            label={item.phase === "request" ? "REQ" : "RES"}
          />
          <span className="intercept-mono intercept-ellipsis">
            {item.model ?? item.path}
          </span>
          <span className="intercept-row-time">
            {item.status === "pending" ?
              formatCountdown(item.expiresAtMs - now)
            : <RelTime ts={item.createdAt} />}
          </span>
        </span>
      }
      description={
        <span className="intercept-row-body">
          <span className="intercept-row-meta">
            <span className="intercept-row-status">
              <StatusDot
                variant={STATUS_DOT[item.status]}
                label={statusLabel}
              />
              {statusLabel}
            </span>
            <span className="intercept-mono">{item.path}</span>
            <span>{fmtBytes(item.bodyBytes)}</span>
            {flags.map((flag) => (
              <span key={flag}>{flag}</span>
            ))}
          </span>
          {item.preview ?
            <span className="intercept-row-preview">{item.preview}</span>
          : null}
        </span>
      }
    />
  )
}

export function InterceptQueueRail({
  view,
  onViewChange,
  pending,
  recent,
  selectedId,
  onSelect,
  draftIds,
  stats,
  isIntercepting,
  isActing,
  onForwardAll,
  onDropAll,
  onClearHistory,
}: InterceptQueueRailProps) {
  const now = useNow()
  const items = view === "pending" ? pending : recent
  const draftCount = pending.filter((item) => draftIds.has(item.id)).length

  let emptyText = "Nothing has been intercepted yet."
  if (view === "pending") {
    emptyText =
      isIntercepting ?
        "Waiting for matching traffic."
      : "Intercept is off. Traffic flows straight through."
  }

  return (
    <aside className="intercept-rail" aria-label="Intercepted traffic">
      <div className="intercept-rail-head">
        <SegmentedControl
          label="Traffic list"
          size="sm"
          layout="fill"
          value={view}
          onChange={(next) =>
            onViewChange(next === "recent" ? "recent" : "pending")
          }
        >
          <SegmentedControlItem
            value="pending"
            label={`Queue (${pending.length})`}
          />
          <SegmentedControlItem
            value="recent"
            label={`History (${recent.length})`}
          />
        </SegmentedControl>
      </div>

      <div className="intercept-rail-list">
        {items.length === 0 ?
          <div className="intercept-rail-empty">
            <Text type="supporting">{emptyText}</Text>
          </div>
        : <List density="compact" hasDividers>
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                isSelected={item.id === selectedId}
                hasDraft={draftIds.has(item.id)}
                now={now}
                onSelect={onSelect}
              />
            ))}
          </List>
        }
      </div>

      <div className="intercept-rail-foot">
        <div className="intercept-stats">
          <strong>{stats.forwardedCount}</strong> forwarded ·{" "}
          <strong>{stats.modifiedCount}</strong> edited ·{" "}
          <strong>{stats.droppedCount}</strong> dropped
        </div>
        {view === "pending" && pending.length > 0 ?
          <HStack gap={2}>
            {draftCount > 0 ?
              <ConfirmButton
                label="Forward all"
                size="sm"
                variant="secondary"
                icon={<PlayIcon />}
                isDisabled={isActing}
                confirmTitle={`Discard unsaved edits on ${draftCount} item${draftCount === 1 ? "" : "s"}?`}
                confirmDescription="Forward all sends each held item as the server has it. Your unsaved edits are not included."
                confirmActionLabel="Forward all"
                onConfirm={onForwardAll}
              />
            : <Button
                label="Forward all"
                size="sm"
                variant="secondary"
                icon={<PlayIcon />}
                isDisabled={isActing}
                onClick={() => void onForwardAll()}
              />
            }
            <ConfirmButton
              label="Drop all"
              size="sm"
              icon={<XIcon />}
              isDisabled={isActing}
              confirmTitle={`Drop ${pending.length} held item${pending.length === 1 ? "" : "s"}?`}
              confirmDescription="Each client receives an error instead of the upstream response. This can't be undone."
              confirmActionLabel="Drop all"
              onConfirm={onDropAll}
            />
          </HStack>
        : null}
        {view === "recent" && recent.length > 0 ?
          <HStack gap={2}>
            <ConfirmButton
              label="Clear history"
              size="sm"
              variant="secondary"
              icon={<Trash2Icon />}
              confirmTitle="Clear intercept history?"
              confirmDescription="Removes resolved items from this list. Held items are not affected."
              confirmActionLabel="Clear history"
              onConfirm={onClearHistory}
            />
          </HStack>
        : null}
      </div>
    </aside>
  )
}
