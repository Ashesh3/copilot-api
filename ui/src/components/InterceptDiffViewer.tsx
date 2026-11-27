import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
import { HStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { useState } from "react"

import type {
  AssistantDiffOp,
  AssistantSuggestion,
  CanonicalItem,
} from "../../../src/lib/intercept/types"

import { CheckIcon, XIcon } from "../icons"
import { KIND_LABEL } from "../lib/intercept-view"

interface InterceptDiffViewerProps {
  suggestion: AssistantSuggestion
  currentItems: ReadonlyArray<CanonicalItem>
  readOnly: boolean
  /** False while the operator has unsaved manual edits the suggestion did not see. */
  canApply: boolean
  isApplying: boolean
  onApply: (selectedOps: Array<AssistantDiffOp>) => void
  onReject: () => void
}

const OP_LABEL: Record<AssistantDiffOp["op"], string> = {
  replace: "Replace",
  delete: "Delete",
  insert_after: "Insert",
}

function DiffSide({
  tone,
  label,
  text,
}: {
  tone: "before" | "after"
  label: string
  text: string
}) {
  return (
    <div className={`intercept-diff-side is-${tone}`}>
      <div className="intercept-diff-label">{label}</div>
      <pre>{text}</pre>
    </div>
  )
}

function OpDiff({
  op,
  target,
}: {
  op: AssistantDiffOp
  target: CanonicalItem | undefined
}) {
  if (op.op === "delete") {
    return (
      <div className="intercept-diff is-single">
        <DiffSide
          tone="before"
          label="Removed"
          text={target?.content ?? "(item not found)"}
        />
      </div>
    )
  }
  if (op.op === "insert_after") {
    return (
      <div className="intercept-diff is-single">
        <DiffSide
          tone="after"
          label="Added"
          text={op.toolArguments ?? op.content}
        />
      </div>
    )
  }
  return (
    <div className="intercept-diff">
      <DiffSide
        tone="before"
        label="Before"
        text={target?.content ?? "(item not found)"}
      />
      <DiffSide
        tone="after"
        label="After"
        text={op.toolArguments ?? op.content ?? target?.content ?? ""}
      />
    </div>
  )
}

/** Remount with `key={suggestion.id}` so the selection resets per suggestion. */
export function InterceptDiffViewer({
  suggestion,
  currentItems,
  readOnly,
  canApply,
  isApplying,
  onApply,
  onReject,
}: InterceptDiffViewerProps) {
  const [selected, setSelected] = useState<Array<boolean>>(() =>
    suggestion.operations.map(() => true),
  )
  const selectedOps = suggestion.operations.filter(
    (_, index) => selected[index],
  )
  const opCount = suggestion.operations.length

  return (
    <section className="intercept-suggestion" aria-label="AI suggestion">
      <div className="intercept-suggestion-head">
        <div className="intercept-detail-title">
          <Text weight="semibold">{suggestion.summary}</Text>
          <Text type="supporting">
            <span className="intercept-mono">{suggestion.model}</span> ·{" "}
            {suggestion.durationMs} ms · {opCount} change
            {opCount === 1 ? "" : "s"}
          </Text>
        </div>
        {readOnly ? null : (
          <HStack gap={2}>
            <Button
              label={opCount === 0 ? "Dismiss" : "Reject"}
              size="sm"
              variant="ghost"
              icon={<XIcon />}
              isDisabled={isApplying}
              onClick={onReject}
            />
            {opCount > 0 ?
              <Button
                label={
                  selectedOps.length === opCount ?
                    "Apply changes"
                  : `Apply ${selectedOps.length} of ${opCount}`
                }
                size="sm"
                variant="secondary"
                icon={<CheckIcon />}
                isLoading={isApplying}
                isDisabled={!canApply || selectedOps.length === 0}
                onClick={() => onApply(selectedOps)}
              />
            : null}
          </HStack>
        )}
      </div>

      {!readOnly && !canApply ?
        <Banner
          status="info"
          title="You have unsaved edits"
          description="Discard or forward them first. The suggestion targets the payload as the assistant read it."
        />
      : null}

      {opCount === 0 ?
        <Banner
          status="info"
          title="No changes suggested"
          description="The assistant found nothing to change for your scenario."
        />
      : <ol className="intercept-ops">
          {suggestion.operations.map((op, index) => {
            const target =
              op.op === "insert_after" ?
                undefined
              : currentItems.find((entry) => entry.id === op.id)
            return (
              // Operations have no ids and never reorder; the viewer remounts per suggestion.
              // eslint-disable-next-line @eslint-react/no-array-index-key
              <li key={`${op.op}-${index}`} className="intercept-op">
                <div className="intercept-op-head">
                  {readOnly ? null : (
                    <CheckboxInput
                      label={`Apply change ${index + 1}`}
                      isLabelHidden
                      value={selected[index]}
                      onChange={(checked) =>
                        setSelected((prev) =>
                          prev.map((value, i) =>
                            i === index ? checked : value,
                          ),
                        )
                      }
                    />
                  )}
                  <Text weight="semibold">{OP_LABEL[op.op]}</Text>
                  {op.op === "insert_after" ?
                    <Text type="supporting">
                      {KIND_LABEL[op.kind]}{" "}
                      {op.afterId ?
                        <>
                          after <code>{op.afterId}</code>
                        </>
                      : "at start"}
                    </Text>
                  : <Text type="supporting">
                      <code>{op.id}</code>
                      {target ?
                        ` · ${KIND_LABEL[target.kind]}`
                      : " · not found"}
                    </Text>
                  }
                  {op.reason ?
                    <span className="intercept-op-reason">{op.reason}</span>
                  : null}
                </div>
                <OpDiff op={op} target={target} />
              </li>
            )
          })}
        </ol>
      }
    </section>
  )
}
