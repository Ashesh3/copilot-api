import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { IconButton } from "@astryxdesign/core/IconButton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { CheckIcon, ChevronRightIcon, RefreshCwIcon } from "../icons"
import {
  canConfirmDistributionRow,
  canPublishDistribution,
  confirmDistributionRow,
  createDistributionDraft,
  distributionAllocations,
  distributionHasPendingRows,
  distributionIsDirty,
  distributionTotal,
  rebaseDistributionDraft,
  revertDistributionRow,
  setDistributionInput,
  shouldAcceptDistributionSnapshot,
  stepDistributionInput,
  syncDistributionAccounts,
  type AccountAllocation,
  type AccountDistribution,
  type DistributionDraft,
} from "../lib/account-distribution"

export interface DistributionAccount {
  id: number
  name: string
  detail: string
  statusLabel: string
  statusVariant: "neutral" | "success" | "warning"
}

interface AccountDistributionEditorProps {
  accounts: Array<DistributionAccount>
  distribution: AccountDistribution
  isSaving: boolean
  onSave: (
    allocations: Array<AccountAllocation>,
    expectedRevision: number,
  ) => Promise<AccountDistribution>
  onReloadLatest: () => Promise<AccountDistribution | undefined>
  renderAccountActions: (accountId: number) => ReactNode
  renderAccountContent: (accountId: number) => ReactNode
}

type ConflictState = {
  message: string
  latest?: AccountDistribution
} | null

function accountName(
  accounts: ReadonlyArray<DistributionAccount>,
  accountId: number,
): string {
  return (
    accounts.find((account) => account.id === accountId)?.name
    ?? `Account ${accountId}`
  )
}

function rowError(draft: DistributionDraft, accountId: number): string {
  const input =
    draft.rows.find((row) => row.accountId === accountId)?.input ?? ""
  const value = input.trim() === "" ? Number.NaN : Number(input)
  if (!Number.isInteger(value) || value < 0 || value > 100)
    return "Enter a whole percentage from 0 to 100."
  if (distributionTotal(draft) > 100)
    return "The total exceeds 100%. Reduce a share before confirming."
  return ""
}

export function AccountDistributionEditor({
  accounts,
  distribution,
  isSaving,
  onSave,
  onReloadLatest,
  renderAccountActions,
  renderAccountContent,
}: AccountDistributionEditorProps) {
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  )
  const [draft, setDraft] = useState(() =>
    createDistributionDraft(accountIds, distribution),
  )
  const [isReviewOpen, setIsReviewOpen] = useState(false)
  const [conflict, setConflict] = useState<ConflictState>(null)
  const [status, setStatus] = useState(
    "Existing conversations keep their assigned account.",
  )
  const inputRefs = useRef(new Map<number, HTMLInputElement>())

  useEffect(() => {
    // Polling updates must reconcile external account/policy state while keeping
    // an in-progress local draft intact.
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setDraft((current) => {
      if (!shouldAcceptDistributionSnapshot(current, distribution))
        return current
      if (
        !distributionIsDirty(current)
        && !distributionHasPendingRows(current)
        && !current.accountSetChanged
      )
        return createDistributionDraft(accountIds, distribution)
      return syncDistributionAccounts(current, accountIds)
    })
  }, [distribution, accountIds])

  const total = distributionTotal(draft)
  const available = 100 - total
  const hasNewerRemoteRevision = distribution.revision > draft.revision
  const isPublishReady = canPublishDistribution(draft, {
    hasConflict: Boolean(conflict),
    hasNewerRevision: hasNewerRemoteRevision,
    isSaving,
  })

  function updateInput(accountId: number, value: string) {
    setDraft((current) => setDistributionInput(current, accountId, value))
  }

  function step(accountId: number, delta: -5 | 5) {
    setDraft((current) => {
      const next = stepDistributionInput(current, accountId, delta)
      if (next === current && delta > 0)
        setStatus("No percentage is available. Reduce another account first.")
      return next
    })
  }

  function confirm(accountId: number) {
    setDraft((current) => {
      if (!canConfirmDistributionRow(current, accountId)) return current
      const next = confirmDistributionRow(current, accountId)
      const position =
        next.rows.findIndex((row) => row.accountId === accountId) + 1
      const name = accountName(accounts, accountId)
      setStatus(
        distributionTotal(next) === 100 ?
          `${name} confirmed, position ${position}. ${distributionHasPendingRows(next) ? "Confirm the other edited shares." : "Ready to save the distribution."}`
        : `${name} confirmed, position ${position}. Allocate the remaining ${100 - distributionTotal(next)}% to save.`,
      )
      queueMicrotask(() => inputRefs.current.get(accountId)?.focus())
      return next
    })
  }

  function discard() {
    setDraft(createDistributionDraft(accountIds, distribution))
    setConflict(null)
    setStatus("Draft discarded. The active routing behavior is unchanged.")
  }

  async function reloadLatest() {
    const latest =
      hasNewerRemoteRevision ? distribution : await onReloadLatest()
    if (!latest) return
    setDraft(createDistributionDraft(accountIds, latest))
    setConflict(null)
    setStatus(
      "Latest active distribution loaded. The previous draft was discarded.",
    )
  }

  async function rebaseLatest() {
    const latest =
      conflict?.latest
      ?? (hasNewerRemoteRevision ? distribution : await onReloadLatest())
    if (!latest) return
    setDraft((current) => rebaseDistributionDraft(current, accountIds, latest))
    setConflict(null)
    setStatus(
      "Your edits were kept on the latest account list and active revision. Review before saving.",
    )
  }

  async function save() {
    try {
      const saved = await onSave(distributionAllocations(draft), draft.revision)
      setDraft(createDistributionDraft(accountIds, saved))
      setConflict(null)
      setIsReviewOpen(false)
      setStatus(
        "Distribution saved. It applies to new conversations; existing conversations keep their account.",
      )
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      const statusCode = "status" in error ? Number(error.status) : 0
      if (statusCode === 409 || statusCode === 412) {
        const latest = await onReloadLatest().catch(() => undefined)
        setIsReviewOpen(false)
        setConflict({
          message:
            "The active distribution changed while you were editing. Your draft is preserved; reload the latest values or keep your edits before saving.",
          latest,
        })
      }
      throw error
    }
  }

  return (
    <Card className="account-distribution" padding={4}>
      <VStack gap={4}>
        <HStack gap={3} wrap="wrap" hAlign="between" vAlign="start">
          <VStack gap={1}>
            <Heading level={3}>New conversation distribution</Heading>
            <Text color="secondary">
              Choose which account receives each newly assigned conversation.
              Existing conversations keep their assigned account.
            </Text>
          </VStack>
          {draft.isEqualShareSuggestion ?
            <span className="account-distribution-badge">
              Equal-share suggestion
            </span>
          : <span className="account-distribution-badge">
              Active distribution
            </span>
          }
        </HStack>

        {draft.isEqualShareSuggestion ?
          <Banner
            status="info"
            title="Percentage routing is not active yet"
            description="The gateway keeps its existing equal routing until you save this suggested equal-share draft."
          />
        : null}
        {draft.accountSetChanged ?
          <Banner
            status="warning"
            title="The account list changed"
            description="Your draft is preserved, but saving is blocked until you reload the active values or keep your edits on the current account list."
            endContent={
              <HStack gap={2} wrap="wrap">
                <Button
                  label="Reload latest"
                  variant="secondary"
                  isDisabled={isSaving}
                  onClick={() => void reloadLatest()}
                />
                <Button
                  label="Keep my edits"
                  variant="primary"
                  isDisabled={isSaving}
                  onClick={() => void rebaseLatest()}
                />
              </HStack>
            }
          />
        : null}
        {conflict || hasNewerRemoteRevision ?
          <Banner
            status="warning"
            title="This draft is stale"
            description={
              conflict?.message
              ?? "The active distribution changed while you were editing. Your draft is preserved; reload the latest values or keep your edits before saving."
            }
            endContent={
              <HStack gap={2} wrap="wrap">
                <Button
                  label="Reload latest"
                  variant="secondary"
                  isDisabled={isSaving}
                  onClick={() => void reloadLatest()}
                />
                <Button
                  label="Keep my edits"
                  variant="primary"
                  isDisabled={isSaving}
                  onClick={() => void rebaseLatest()}
                />
              </HStack>
            }
          />
        : null}

        <div className="account-distribution-summary">
          <HStack gap={2} hAlign="between" vAlign="center">
            <Text weight="semibold">Allocated</Text>
            <Text weight="semibold" hasTabularNumbers>
              {total} / 100%
            </Text>
          </HStack>
          <div
            className="account-distribution-meter"
            role="progressbar"
            aria-label="Allocated percentage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.max(0, Math.min(100, total))}
          >
            <span style={{ width: `${Math.max(0, Math.min(100, total))}%` }} />
          </div>
          <HStack gap={2} hAlign="between" vAlign="center">
            <Text color="secondary" size="sm">
              {available < 0 ?
                `${-available}% over the limit`
              : `${available}% available`}
            </Text>
            <Text color="secondary" size="sm">
              {distributionIsDirty(draft) || distributionHasPendingRows(draft) ?
                "Draft · active shares unchanged"
              : "Active distribution"}
            </Text>
          </HStack>
        </div>

        <Text color="secondary" size="sm">
          Type a whole percentage or use the arrows for five-point changes.
          Confirm with the tick; rows then sort by confirmed share.
        </Text>

        <ol
          className="account-distribution-list"
          aria-label="GitHub accounts by allocation"
        >
          {draft.rows.map((row) => {
            const account = accounts.find(
              (candidate) => candidate.id === row.accountId,
            )
            if (!account) return null
            const error = rowError(draft, row.accountId)
            const value =
              row.input.trim() === "" ? Number.NaN : Number(row.input)
            const increaseDisabled =
              !Number.isInteger(value)
              || value + 5 > 100
              || distributionTotal(draft) + 5 > 100
            const accountContent = renderAccountContent(row.accountId)
            return (
              <li
                key={row.accountId}
                className="account-distribution-row"
                data-dirty={String(Number(row.input) !== row.confirmed)}
              >
                <div className="account-distribution-identity">
                  <div
                    className="account-distribution-avatar"
                    aria-hidden="true"
                  >
                    {account.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="account-distribution-account-copy">
                    <HStack gap={2} wrap="wrap" vAlign="center">
                      <Text weight="semibold">{account.name}</Text>
                      <span
                        className={`account-distribution-status account-distribution-status-${account.statusVariant}`}
                      >
                        {account.statusLabel}
                      </span>
                    </HStack>
                    <Text color="secondary" size="sm">
                      {account.detail} ·{" "}
                      {row.active === null ?
                        "Legacy equal routing active"
                      : `${row.active}% active`}{" "}
                      ·{" "}
                      {row.confirmed === 0 ?
                        "No new conversations in draft"
                      : `${row.confirmed}% confirmed`}
                    </Text>
                  </div>
                </div>
                <div className="account-distribution-controls">
                  <IconButton
                    label={`Decrease ${account.name} by 5 percent`}
                    icon={
                      <ChevronRightIcon className="account-distribution-decrease-icon" />
                    }
                    variant="secondary"
                    size="sm"
                    isDisabled={
                      isSaving || !Number.isFinite(value) || value <= 0
                    }
                    onClick={() => step(row.accountId, -5)}
                  />
                  <label className="account-distribution-input">
                    <span className="account-distribution-sr">
                      {account.name} allocation percentage
                    </span>
                    <input
                      ref={(element) => {
                        if (element)
                          inputRefs.current.set(row.accountId, element)
                        else inputRefs.current.delete(row.accountId)
                      }}
                      aria-label={`${account.name} allocation percentage`}
                      aria-describedby={`account-distribution-error-${row.accountId}`}
                      aria-invalid={Boolean(error)}
                      inputMode="numeric"
                      min="0"
                      max="100"
                      step="1"
                      type="number"
                      value={row.input}
                      disabled={isSaving}
                      onChange={(event) =>
                        updateInput(row.accountId, event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (
                          [
                            "ArrowDown",
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                          ].includes(event.key)
                        ) {
                          event.preventDefault()
                          step(
                            row.accountId,
                            ["ArrowDown", "ArrowLeft"].includes(event.key) ? -5
                            : 5,
                          )
                        } else if (event.key === "Enter") {
                          event.preventDefault()
                          confirm(row.accountId)
                        } else if (event.key === "Escape") {
                          event.preventDefault()
                          setDraft((current) =>
                            revertDistributionRow(current, row.accountId),
                          )
                          setStatus("Unconfirmed row edit canceled.")
                        }
                      }}
                    />
                    <span aria-hidden="true">%</span>
                  </label>
                  <IconButton
                    label={`Increase ${account.name} by 5 percent`}
                    icon={<ChevronRightIcon />}
                    variant="secondary"
                    size="sm"
                    isDisabled={isSaving || increaseDisabled}
                    onClick={() => step(row.accountId, 5)}
                  />
                  <IconButton
                    label={`Confirm ${account.name} percentage`}
                    icon={<CheckIcon />}
                    variant="primary"
                    size="sm"
                    isDisabled={
                      isSaving
                      || !canConfirmDistributionRow(draft, row.accountId)
                    }
                    onClick={() => confirm(row.accountId)}
                  />
                </div>
                <div
                  className="account-distribution-row-error"
                  id={`account-distribution-error-${row.accountId}`}
                  role="alert"
                >
                  {error}
                </div>
                <div className="account-distribution-account-actions">
                  {renderAccountActions(row.accountId)}
                </div>
                {accountContent ?
                  <div className="account-distribution-account-content">
                    {accountContent}
                  </div>
                : null}
              </li>
            )
          })}
        </ol>

        <Card variant="muted" padding={3}>
          <VStack gap={1}>
            <Text weight="semibold">Model availability</Text>
            <Text color="secondary" size="sm">
              The configured percentages are considered only among healthy,
              enabled accounts that can serve the requested model. Their
              positive shares are renormalized for that model; a 0% account
              receives no new conversations.
            </Text>
          </VStack>
        </Card>

        <HStack gap={3} wrap="wrap" hAlign="between" vAlign="center">
          <Text color="secondary" size="sm" role="status" aria-live="polite">
            {status}
          </Text>
          <HStack gap={2} wrap="wrap">
            <Button
              label="Discard draft"
              variant="secondary"
              isDisabled={
                isSaving
                || (!distributionIsDirty(draft)
                  && !distributionHasPendingRows(draft)
                  && !draft.accountSetChanged)
              }
              onClick={discard}
            />
            <Button
              label="Save distribution"
              variant="primary"
              isDisabled={!isPublishReady}
              onClick={() => setIsReviewOpen(true)}
            />
          </HStack>
        </HStack>
      </VStack>

      <Dialog
        className="account-distribution-dialog"
        isOpen={isReviewOpen}
        onOpenChange={(isOpen) => {
          if (!isSaving) setIsReviewOpen(isOpen)
        }}
        purpose="form"
        width="min(480px, calc(100vw - 32px))"
      >
        <VStack gap={4}>
          <DialogHeader
            title="Change the distribution?"
            subtitle="These shares apply to new conversations only. Existing conversations keep their assigned account. Actual usage also depends on conversation length and model availability."
            onOpenChange={(isOpen) => {
              if (!isSaving) setIsReviewOpen(isOpen)
            }}
          />
          <ul className="account-distribution-review">
            {draft.rows.map((row) => (
              <li key={row.accountId}>
                <span>{accountName(accounts, row.accountId)}</span>
                <strong>
                  {row.active === null ? "Legacy" : `${row.active}%`} →{" "}
                  {row.confirmed}%
                </strong>
              </li>
            ))}
          </ul>
          <HStack gap={2} hAlign="end" wrap="wrap">
            <Button
              label="Cancel"
              variant="secondary"
              isDisabled={isSaving}
              onClick={() => setIsReviewOpen(false)}
            />
            <Button
              label="Apply distribution"
              icon={<RefreshCwIcon />}
              variant="primary"
              isLoading={isSaving}
              isDisabled={!isPublishReady}
              onClick={() => void save().catch(() => undefined)}
            />
          </HStack>
        </VStack>
      </Dialog>
    </Card>
  )
}
