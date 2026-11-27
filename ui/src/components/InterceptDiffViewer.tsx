/* eslint-disable no-nested-ternary */
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { useEffect, useState } from "react"

import type {
  AssistantDiffOp,
  AssistantSuggestion,
  CanonicalItem,
} from "../../../src/lib/intercept/types"

import { CheckIcon, XIcon } from "../icons"

interface InterceptDiffViewerProps {
  suggestion: AssistantSuggestion
  currentItems: ReadonlyArray<CanonicalItem>
  readOnly: boolean
  isApplying: boolean
  onAccept: (selectedOps: Array<AssistantDiffOp>) => void
  onReject: () => void
}

function opBadgeVariant(op: AssistantDiffOp["op"]): BadgeVariant {
  if (op === "replace") return "warning"
  if (op === "delete") return "error"
  return "success"
}

export function InterceptDiffViewer({
  suggestion,
  currentItems,
  readOnly,
  isApplying,
  onAccept,
  onReject,
}: InterceptDiffViewerProps) {
  const [selected, setSelected] = useState<Array<boolean>>(() =>
    suggestion.operations.map(() => true),
  )

  useEffect(() => {
    setSelected(suggestion.operations.map(() => true))
  }, [suggestion.id, suggestion.operations])

  const selectedOps = suggestion.operations.filter((_, idx) => selected[idx])

  return (
    <div className="intercept-diff-panel">
      <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Badge variant="purple" label="AI Suggestion" />
          <Text weight="semibold">{suggestion.summary}</Text>
          <Text type="supporting" color="secondary">
            {suggestion.model} · {suggestion.durationMs}ms ·{" "}
            {suggestion.operations.length} op
            {suggestion.operations.length === 1 ? "" : "s"}
          </Text>
        </HStack>

        {!readOnly ?
          <HStack gap={2}>
            <Button
              label="Reject"
              size="sm"
              variant="ghost"
              icon={<XIcon />}
              isDisabled={isApplying}
              onClick={onReject}
            />
            <Button
              label={
                selectedOps.length === suggestion.operations.length ?
                  "Accept & Apply Diff"
                : `Apply Selected (${selectedOps.length})`
              }
              size="sm"
              variant="primary"
              icon={<CheckIcon />}
              isLoading={isApplying}
              isDisabled={selectedOps.length === 0}
              onClick={() => onAccept(selectedOps)}
            />
          </HStack>
        : null}
      </HStack>

      {suggestion.operations.length === 0 ?
        <Banner
          status="info"
          title="No modifications suggested"
          description="The assistant determined this payload already satisfies your scenario instructions."
        />
      : <VStack gap={2}>
          {suggestion.operations.map((op, index) => {
            const targetItem =
              op.op === "replace" || op.op === "delete" ?
                currentItems.find((entry) => entry.id === op.id)
              : undefined
            const key = `${op.op}-${index}`
            return (
              <div key={key} className="intercept-diff-op">
                <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
                  <HStack gap={2} vAlign="center">
                    {!readOnly ?
                      <CheckboxInput
                        label={`Select operation ${index + 1}`}
                        isLabelHidden
                        value={selected[index]}
                        onChange={(checked) =>
                          setSelected((prev) =>
                            prev.map((v, i) => (i === index ? checked : v)),
                          )
                        }
                      />
                    : null}
                    <Badge
                      variant={opBadgeVariant(op.op)}
                      label={op.op.toUpperCase()}
                    />
                    {op.op === "insert_after" ?
                      <Text type="supporting">
                        Insert <strong>{op.kind}</strong>{" "}
                        {op.afterId ?
                          <>
                            after <code>{op.afterId}</code>
                          </>
                        : "at start"}
                      </Text>
                    : <Text type="supporting">
                        Target <code>{op.id}</code>
                        {targetItem ? ` (${targetItem.label})` : ""}
                      </Text>
                    }
                  </HStack>
                  {op.reason ?
                    <Text type="supporting" color="secondary">
                      {op.reason}
                    </Text>
                  : null}
                </HStack>

                {op.op === "replace" ?
                  <div className="intercept-diff-grid">
                    <div className="intercept-diff-box is-removed">
                      <div className="intercept-diff-box-title">Before</div>
                      <pre>{targetItem?.content ?? "(missing item)"}</pre>
                    </div>
                    <div className="intercept-diff-box is-added">
                      <div className="intercept-diff-box-title">After</div>
                      <pre>
                        {op.toolArguments
                          ?? op.content
                          ?? targetItem?.content
                          ?? ""}
                      </pre>
                    </div>
                  </div>
                : op.op === "delete" ?
                  <div className="intercept-diff-box is-removed">
                    <div className="intercept-diff-box-title">Removing</div>
                    <pre>{targetItem?.content ?? "(missing item)"}</pre>
                  </div>
                : <div className="intercept-diff-box is-added">
                    <div className="intercept-diff-box-title">
                      Inserting ({op.kind}
                      {op.toolName ? `: ${op.toolName}` : ""})
                    </div>
                    <pre>{op.toolArguments ?? op.content}</pre>
                  </div>
                }
              </div>
            )
          })}
        </VStack>
      }
    </div>
  )
}
