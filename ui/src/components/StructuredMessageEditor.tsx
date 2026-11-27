/* eslint-disable no-nested-ternary */
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

import type {
  CanonicalItem,
  CanonicalItemKind,
} from "../../../src/lib/intercept/types"

import { PlusIcon, Trash2Icon } from "../icons"

interface StructuredMessageEditorProps {
  items: Array<CanonicalItem>
  readOnly: boolean
  editable: boolean
  note?: string
  onChange: (next: Array<CanonicalItem>) => void
}

const KIND_OPTIONS: Array<{ label: string; value: CanonicalItemKind }> = [
  { label: "System", value: "system" },
  { label: "Developer", value: "developer" },
  { label: "User", value: "user" },
  { label: "Assistant", value: "assistant" },
  { label: "Thinking", value: "thinking" },
  { label: "Tool Call", value: "tool_call" },
  { label: "Tool Result", value: "tool_result" },
]

export function StructuredMessageEditor({
  items,
  readOnly,
  editable,
  note,
  onChange,
}: StructuredMessageEditorProps) {
  const canEdit = !readOnly && editable

  const updateItem = (index: number, patch: Partial<CanonicalItem>) => {
    const next = items.map((item, idx) =>
      idx === index ? { ...item, ...patch } : item,
    )
    onChange(next)
  }

  const removeItem = (index: number) => {
    onChange(items.filter((_, idx) => idx !== index))
  }

  const insertItem = (afterIndex: number) => {
    const newItem: CanonicalItem = {
      id: `manual-${Date.now()}`,
      kind: "user",
      role: "user",
      label: "User",
      content: "",
    }
    const next = [...items]
    next.splice(afterIndex + 1, 0, newItem)
    onChange(next)
  }

  return (
    <VStack gap={3}>
      {note ?
        <Text type="supporting" color="secondary">
          {note}
        </Text>
      : null}

      {items.length === 0 ?
        <Card padding={4}>
          <VStack gap={2} hAlign="center">
            <Text color="secondary">No structured messages parsed.</Text>
            {canEdit ?
              <Button
                label="Add message"
                icon={<PlusIcon />}
                size="sm"
                variant="secondary"
                onClick={() => insertItem(-1)}
              />
            : null}
          </VStack>
        </Card>
      : items.map((item, index) => (
          <div
            key={item.id}
            className="intercept-msg-card"
            data-kind={item.kind}
          >
            <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Badge
                  variant="neutral"
                  label={item.kind.replace("_", " ").toUpperCase()}
                />
                <code className="intercept-item-id">{item.id}</code>
                {item.toolCallId ?
                  <Text type="supporting" color="secondary">
                    call_id: <code>{item.toolCallId}</code>
                  </Text>
                : null}
              </HStack>
              {canEdit ?
                <HStack gap={1} vAlign="center">
                  <Selector
                    label="Role / Kind"
                    isLabelHidden
                    size="sm"
                    value={item.kind}
                    options={KIND_OPTIONS}
                    onChange={(val) => {
                      const nextKind = val as CanonicalItemKind
                      updateItem(index, {
                        kind: nextKind,
                        role:
                          nextKind === "tool_call" || nextKind === "thinking" ?
                            "assistant"
                          : nextKind === "tool_result" ? "tool"
                          : nextKind,
                        label:
                          nextKind === "tool_call" ?
                            `Tool Call: ${item.toolName ?? "tool"}`
                          : nextKind.charAt(0).toUpperCase()
                            + nextKind.slice(1),
                      })
                    }}
                  />
                  <Button
                    label="Insert below"
                    size="sm"
                    variant="ghost"
                    icon={<PlusIcon />}
                    onClick={() => insertItem(index)}
                  />
                  <Button
                    label="Remove"
                    size="sm"
                    variant="ghost"
                    icon={<Trash2Icon />}
                    onClick={() => removeItem(index)}
                  />
                </HStack>
              : null}
            </HStack>

            {item.kind === "tool_call" ?
              <VStack gap={2}>
                <TextInput
                  label="Tool name"
                  size="sm"
                  value={item.toolName ?? ""}
                  isDisabled={!canEdit}
                  onChange={(val) =>
                    updateItem(index, {
                      toolName: val,
                      label: `Tool Call: ${val || "tool"}`,
                    })
                  }
                />
                <TextArea
                  label="Tool arguments (JSON)"
                  rows={Math.min(
                    12,
                    Math.max(
                      3,
                      (item.toolArguments ?? item.content).split("\n").length,
                    ),
                  )}
                  value={item.toolArguments ?? item.content}
                  isDisabled={!canEdit}
                  onChange={(val) =>
                    updateItem(index, { toolArguments: val, content: val })
                  }
                />
              </VStack>
            : <TextArea
                label={item.label}
                isLabelHidden
                rows={Math.min(
                  16,
                  Math.max(3, item.content.split("\n").length + 1),
                )}
                value={item.content}
                isDisabled={!canEdit}
                onChange={(val) => updateItem(index, { content: val })}
              />
            }
          </div>
        ))
      }
    </VStack>
  )
}
