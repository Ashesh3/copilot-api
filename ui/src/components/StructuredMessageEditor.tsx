import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Selector } from "@astryxdesign/core/Selector"
import { Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

import type {
  CanonicalItem,
  CanonicalItemKind,
} from "../../../src/lib/intercept/types"

import { PlusIcon, Trash2Icon } from "../icons"
import { KIND_LABEL } from "../lib/intercept-view"
import { IconAction, RowActions } from "./common"

interface StructuredMessageEditorProps {
  items: Array<CanonicalItem>
  readOnly: boolean
  editable: boolean
  onChange?: (next: Array<CanonicalItem>) => void
}

const EDITABLE_KINDS: Array<Exclude<CanonicalItemKind, "other">> = [
  "system",
  "developer",
  "user",
  "assistant",
  "thinking",
  "tool_call",
  "tool_result",
]

const KIND_OPTIONS = EDITABLE_KINDS.map((kind) => ({
  label: KIND_LABEL[kind],
  value: kind,
}))

function roleForKind(kind: CanonicalItemKind): string {
  if (kind === "tool_call" || kind === "thinking") return "assistant"
  if (kind === "tool_result") return "tool"
  return kind
}

/** Grow with the content, within a sensible band, so short turns stay compact. */
function rowsFor(text: string, max: number): number {
  return Math.min(max, Math.max(2, text.split("\n").length + 1))
}

function MessageText({ item }: { item: CanonicalItem }) {
  const isMono = item.kind === "tool_call" || item.kind === "tool_result"
  const text =
    item.kind === "tool_call" ?
      (item.toolArguments ?? item.content)
    : item.content
  return (
    <pre
      className={
        isMono ? "intercept-message-text is-mono" : "intercept-message-text"
      }
    >
      {text || "(empty)"}
    </pre>
  )
}

export function StructuredMessageEditor({
  items,
  readOnly,
  editable,
  onChange,
}: StructuredMessageEditorProps) {
  const canEdit = !readOnly && editable && onChange !== undefined

  const update = (index: number, patch: Partial<CanonicalItem>) => {
    onChange?.(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    )
  }

  const insertAfter = (index: number) => {
    const next = [...items]
    next.splice(index + 1, 0, {
      id: `manual-${Date.now()}`,
      kind: "user",
      role: "user",
      label: KIND_LABEL.user,
      content: "",
    })
    onChange?.(next)
  }

  const renderContent = (item: CanonicalItem, index: number) => {
    if (!canEdit) return <MessageText item={item} />
    if (item.kind === "tool_call") {
      return (
        <>
          <TextInput
            className="intercept-mono-field"
            label="Tool name"
            size="sm"
            width={280}
            value={item.toolName ?? ""}
            onChange={(toolName) =>
              update(index, { toolName, label: `Tool call: ${toolName}` })
            }
          />
          <TextArea
            className="intercept-mono-field"
            label="Arguments (JSON)"
            rows={rowsFor(item.toolArguments ?? item.content, 14)}
            value={item.toolArguments ?? item.content}
            onChange={(value) =>
              update(index, { toolArguments: value, content: value })
            }
          />
        </>
      )
    }
    return (
      <TextArea
        className={
          item.kind === "tool_result" ? "intercept-mono-field" : undefined
        }
        label={`${KIND_LABEL[item.kind]} content`}
        isLabelHidden
        rows={rowsFor(item.content, 18)}
        value={item.content}
        onChange={(content) => update(index, { content })}
      />
    )
  }

  if (items.length === 0) {
    return (
      <div className="intercept-messages-empty">
        <Text type="supporting">This payload has no messages.</Text>
        {canEdit ?
          <Button
            label="Add message"
            size="sm"
            variant="secondary"
            icon={<PlusIcon />}
            onClick={() => insertAfter(-1)}
          />
        : null}
      </div>
    )
  }

  return (
    <div className="intercept-messages">
      {items.map((item, index) => (
        <div key={item.id} className="intercept-message">
          <div className="intercept-message-head">
            <div className="intercept-message-id">
              {canEdit ?
                <Selector
                  label="Message kind"
                  isLabelHidden
                  size="sm"
                  width={140}
                  value={item.kind}
                  options={KIND_OPTIONS}
                  onChange={(value) => {
                    const kind = value as CanonicalItemKind
                    update(index, {
                      kind,
                      role: roleForKind(kind),
                      label: KIND_LABEL[kind],
                    })
                  }}
                />
              : <Badge variant="neutral" label={KIND_LABEL[item.kind]} />}
              {item.kind === "tool_call" && item.toolName ?
                <code>{item.toolName}</code>
              : null}
              <code>{item.id}</code>
              {item.toolCallId ?
                <span>
                  call <code>{item.toolCallId}</code>
                </span>
              : null}
              {item.opaque ?
                <span>includes non-text parts</span>
              : null}
            </div>
            {canEdit ?
              <RowActions>
                <IconAction
                  label="Insert message below"
                  icon={<PlusIcon />}
                  onClick={() => insertAfter(index)}
                />
                <IconAction
                  label="Remove message"
                  icon={<Trash2Icon />}
                  onClick={() => onChange(items.filter((_, i) => i !== index))}
                />
              </RowActions>
            : null}
          </div>

          {renderContent(item, index)}
        </div>
      ))}
    </div>
  )
}
