import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { Markdown } from "@astryxdesign/core/Markdown"
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useMemo, useState } from "react"

import type { JsonValue } from "../lib/json-tree"
import type {
  ParsedResponsesBody,
  ResponsesStreamEvent,
} from "../lib/responses-body"

import { CopyIcon } from "../icons"
import { JsonTreeViewer } from "./JsonTreeViewer"

interface ResponsesBodyViewerProps {
  labelId: string
  parsed: ParsedResponsesBody
  wrap: boolean
  onCopy: () => void
}

interface MetadataItem {
  label: string
  value: string
}

type JsonRecord = { [key: string]: JsonValue }

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textValue(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return null
}

function formatTimestamp(value: JsonValue | undefined): string | null {
  if (typeof value !== "number") return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function formatCount(value: JsonValue | undefined): string | null {
  return typeof value === "number" ? value.toLocaleString() : null
}

function metadataItems(parsed: ParsedResponsesBody): Array<MetadataItem> {
  const response = parsed.response
  if (!response) return []
  const reasoning = isRecord(response.reasoning) ? response.reasoning : null

  const items: Array<{ label: string; value: string | null }> = [
    { label: "Status", value: textValue(response.status) ?? parsed.status },
    { label: "Finish reason", value: textValue(response.finish_reason) },
    { label: "Error", value: textValue(response.error_message) },
    { label: "Model", value: textValue(response.model) },
    { label: "Response ID", value: textValue(response.id) },
    { label: "Service tier", value: textValue(response.service_tier) },
    { label: "Created", value: formatTimestamp(response.created_at) },
    { label: "Completed", value: formatTimestamp(response.completed_at) },
    { label: "Reasoning effort", value: textValue(reasoning?.effort) },
    { label: "Reasoning mode", value: textValue(reasoning?.mode) },
    {
      label: "System fingerprint",
      value: textValue(response.system_fingerprint),
    },
    {
      label: "Tool calls",
      value: parsed.toolCallCount > 0 ? String(parsed.toolCallCount) : null,
    },
  ]
  return items.flatMap((item) =>
    item.value === null ? [] : [{ label: item.label, value: item.value }],
  )
}

function usageItems(usage: JsonRecord | null): Array<MetadataItem> {
  if (!usage) return []
  const inputDetails =
    isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null
  const outputDetails =
    isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null

  const items: Array<{ label: string; value: string | null }> = [
    { label: "Input", value: formatCount(usage.input_tokens) },
    { label: "Cached", value: formatCount(inputDetails?.cached_tokens) },
    {
      label: "Cache write",
      value: formatCount(inputDetails?.cache_write_tokens),
    },
    { label: "Output", value: formatCount(usage.output_tokens) },
    { label: "Reasoning", value: formatCount(outputDetails?.reasoning_tokens) },
    {
      label: "Accepted prediction",
      value: formatCount(outputDetails?.accepted_prediction_tokens),
    },
    {
      label: "Rejected prediction",
      value: formatCount(outputDetails?.rejected_prediction_tokens),
    },
    { label: "Total", value: formatCount(usage.total_tokens) },
  ]
  return items.flatMap((item) =>
    item.value === null ? [] : [{ label: item.label, value: item.value }],
  )
}

function copilotUsageItems(usage: JsonRecord | null): Array<MetadataItem> {
  if (!usage) return []
  const details = Array.isArray(usage.token_details) ? usage.token_details : []
  const items = details
    .filter((detail) => isRecord(detail))
    .flatMap((detail) => {
      const type = textValue(detail.token_type)
      const count = formatCount(detail.token_count)
      return type && count ?
          [{ label: type.replaceAll("_", " "), value: count }]
        : []
    })
  const totalNanoAiu = formatCount(usage.total_nano_aiu)
  if (totalNanoAiu) items.push({ label: "Total nano AIU", value: totalNanoAiu })
  for (const [key, value] of Object.entries(usage)) {
    if (key === "token_details" || key === "total_nano_aiu") continue
    const formatted = formatCount(value)
    if (formatted) {
      items.push({ label: key.replaceAll("_", " "), value: formatted })
    }
  }
  return items
}

function MetadataSection({
  items,
  title,
}: {
  items: Array<MetadataItem>
  title: string
}) {
  if (items.length === 0) return null
  return (
    <VStack gap={2}>
      <Heading level={4}>{title}</Heading>
      <MetadataList columns="multi">
        {items.map((item) => (
          <MetadataListItem key={item.label} label={item.label}>
            <Text type="code">{item.value}</Text>
          </MetadataListItem>
        ))}
      </MetadataList>
    </VStack>
  )
}

function eventLabel(event: ResponsesStreamEvent, index: number): string {
  const sequence =
    event.sequenceNumber === undefined ? "" : ` #${event.sequenceNumber}`
  return `${index + 1}. ${event.type}${sequence}`
}

function EventViewer({
  event,
  index,
  onCopy,
  wrap,
}: {
  event: ResponsesStreamEvent
  index: number
  onCopy: () => void
  wrap: boolean
}) {
  const formatted = useMemo(() => JSON.stringify(event.data, null, 2), [event])
  const value = event.data

  return (
    <div className="responses-event-detail">
      <JsonTreeViewer
        key={`${index}:${event.type}:${event.sequenceNumber ?? ""}`}
        formatted={formatted}
        label={`Response event ${index + 1}`}
        value={value}
        wrap={wrap}
        onCopy={onCopy}
      />
    </div>
  )
}

export function ResponsesBodyViewer({
  labelId,
  parsed,
  wrap,
  onCopy,
}: ResponsesBodyViewerProps) {
  const [selectedEvent, setSelectedEvent] = useState(
    String(Math.max(0, parsed.events.length - 1)),
  )
  const selectedIndex = Math.min(
    Number.parseInt(selectedEvent, 10) || 0,
    Math.max(0, parsed.events.length - 1),
  )
  const event = parsed.events[selectedIndex]

  async function copyText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    onCopy()
  }

  return (
    <VStack gap={4} className="responses-pretty-view">
      {parsed.isPartial ?
        <Banner
          status="info"
          title="Partial response capture"
          description="The terminal stream marker has not been captured yet. The assembled output below uses only the available events."
        />
      : null}

      <section aria-labelledby={labelId}>
        <VStack gap={2}>
          <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
            <Heading id={labelId} level={4}>
              Assistant output
            </Heading>
            <Button
              label="Copy output"
              variant="ghost"
              size="sm"
              icon={<CopyIcon />}
              isDisabled={!parsed.assistantText}
              onClick={() => void copyText(parsed.assistantText)}
            />
          </HStack>
          {parsed.assistantText ?
            <div
              className="responses-output"
              role="region"
              aria-label="Assembled assistant output"
              tabIndex={0}
            >
              <Markdown contentWidth="100%" headingLevelStart={5}>
                {parsed.assistantText}
              </Markdown>
            </div>
          : <Text
              as="p"
              type="supporting"
              color="secondary"
              aria-live={parsed.isPartial ? "polite" : undefined}
            >
              {parsed.isPartial ?
                "No assistant output captured yet."
              : "The response did not contain assistant text."}
            </Text>
          }
        </VStack>
      </section>

      <MetadataSection items={metadataItems(parsed)} title="Response details" />
      <MetadataSection items={usageItems(parsed.usage)} title="Token usage" />
      <MetadataSection
        items={copilotUsageItems(parsed.copilotUsage)}
        title="Copilot usage"
      />

      {parsed.reasoningText ?
        <Collapsible defaultIsOpen={false} trigger="Reasoning">
          <CodeBlock
            code={parsed.reasoningText}
            language="markdown"
            isWrapped
            width="100%"
            maxHeight="480px"
            onCopy={onCopy}
          />
        </Collapsible>
      : null}

      <Collapsible
        defaultIsOpen={false}
        trigger={`Stream events (${parsed.events.length})`}
      >
        <VStack gap={3}>
          <Selector
            label="Event"
            value={String(selectedIndex)}
            options={parsed.events.map((item, index) => ({
              label: eventLabel(item, index),
              value: String(index),
            }))}
            width="100%"
            onChange={setSelectedEvent}
          />
          <EventViewer
            event={event}
            index={selectedIndex}
            wrap={wrap}
            onCopy={onCopy}
          />
        </VStack>
      </Collapsible>
    </VStack>
  )
}
