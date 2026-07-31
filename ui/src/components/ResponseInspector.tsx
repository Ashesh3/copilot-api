import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { Markdown } from "@astryxdesign/core/Markdown"
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useMemo, useState, type ReactNode } from "react"

import type { CodeDocumentLanguage } from "../lib/code-mirror-document"
import type { HttpResponseExportSource } from "../lib/http-export"
import type { JsonValue } from "../lib/json-tree"
import type { ResponseInspectorTab } from "../lib/response-inspector"
import type { ParsedToolCall } from "../lib/response-tool-calls"
import type {
  ParsedResponsesBody,
  ResponsesStreamEvent,
} from "../lib/responses-body"

import { CopyIcon } from "../icons"
import { jsonCopyErrorMessage } from "../lib/json-tree"
import {
  initialResponseInspectorViewState,
  metadataItemKey,
  responseBodyLanguage,
  responseInspectorViewState,
} from "../lib/response-inspector"
import { describeResponseOutput } from "../lib/response-output"
import { parseResponsesBody } from "../lib/responses-body"
import { JsonTreeViewer } from "./JsonTreeViewer"
import { ResponseExportMenu } from "./ResponseExportMenu"
import { VirtualizedCodeViewer } from "./VirtualizedCodeViewer"

export interface ResponseInspectorProps {
  durationMs?: number
  id: string
  responseIdentity: string
  response: HttpResponseExportSource
  onCopyError: (message: string) => void
  onCopySuccess: () => void
  onExport: (format: string) => void
  onExportError: (message: string) => void
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

function compactMetadata(
  items: Array<{ label: string; value: string | null }>,
): Array<MetadataItem> {
  return items.flatMap((item) =>
    item.value === null ? [] : [{ label: item.label, value: item.value }],
  )
}

function metadataItems(parsed: ParsedResponsesBody): Array<MetadataItem> {
  const response = parsed.response
  const reasoning =
    response && isRecord(response.reasoning) ? response.reasoning : null

  return compactMetadata([
    {
      label: "Status",
      value: textValue(response?.status) ?? parsed.status,
    },
    { label: "Finish reason", value: textValue(response?.finish_reason) },
    {
      label: "Error",
      value: textValue(response?.error_message) ?? parsed.errorMessage,
    },
    { label: "Model", value: textValue(response?.model) },
    { label: "Response ID", value: textValue(response?.id) },
    { label: "Service tier", value: textValue(response?.service_tier) },
    { label: "Created", value: formatTimestamp(response?.created_at) },
    { label: "Completed", value: formatTimestamp(response?.completed_at) },
    { label: "Reasoning effort", value: textValue(reasoning?.effort) },
    { label: "Reasoning mode", value: textValue(reasoning?.mode) },
    {
      label: "System fingerprint",
      value: textValue(response?.system_fingerprint),
    },
    {
      label: "Tool calls",
      value:
        parsed.toolCalls.length > 0 ? String(parsed.toolCalls.length) : null,
    },
  ])
}

function usageItems(usage: JsonRecord | null): Array<MetadataItem> {
  if (!usage) return []
  const inputDetails =
    isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null
  const outputDetails =
    isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null

  return compactMetadata([
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
  ])
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
  source,
  title,
}: {
  items: Array<MetadataItem>
  source: string
  title: string
}) {
  if (items.length === 0) return null
  return (
    <VStack gap={2}>
      <Heading level={4}>{title}</Heading>
      <MetadataList columns="multi">
        {items.map((item, index) => (
          <MetadataListItem
            key={metadataItemKey(source, item.label, index)}
            label={item.label}
          >
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
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  event: ResponsesStreamEvent
  index: number
  wrap: boolean
  onCopyError: (message: string) => void
  onCopySuccess: () => void
}) {
  const formatted = useMemo(() => JSON.stringify(event.data, null, 2), [event])

  return (
    <div className="response-inspector-event-detail">
      <JsonTreeViewer
        key={`${index}:${event.type}:${event.sequenceNumber ?? ""}`}
        formatted={formatted}
        label={`Response event ${index + 1}`}
        value={event.data}
        wrap={wrap}
        onCopy={onCopySuccess}
        onCopyError={onCopyError}
      />
    </div>
  )
}

function ToolCallViewer({
  call,
  index,
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  call: ParsedToolCall
  index: number
  wrap: boolean
  onCopyError: (message: string) => void
  onCopySuccess: () => void
}) {
  const trigger = `Tool call ${index + 1}: ${call.name ?? "Unnamed tool"}`
  const details = compactMetadata([
    { label: "Call ID", value: call.callId },
    { label: "Item ID", value: call.id },
    { label: "Output index", value: String(call.outputIndex) },
  ])

  return (
    <Collapsible defaultIsOpen={false} trigger={trigger}>
      <VStack gap={3} className="response-inspector-tool-call">
        <MetadataSection
          items={details}
          source={`tool-call-${call.outputIndex}-${call.id ?? call.callId ?? index}`}
          title="Call details"
        />
        {call.argumentsJson === null ?
          <VirtualizedCodeViewer
            label={`${call.name ?? `Tool call ${index + 1}`} payload`}
            language="text"
            value={call.arguments}
            wrap={wrap}
            onCopyError={onCopyError}
            onCopySuccess={onCopySuccess}
          />
        : <JsonTreeViewer
            formatted={JSON.stringify(call.argumentsJson, null, 2)}
            label={`${call.name ?? `Tool call ${index + 1}`} payload`}
            value={call.argumentsJson}
            wrap={wrap}
            onCopy={onCopySuccess}
            onCopyError={onCopyError}
          />
        }
      </VStack>
    </Collapsible>
  )
}

function RawResponseBody({
  body,
  language,
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  body: string
  language: CodeDocumentLanguage
  wrap: boolean
  onCopyError: (message: string) => void
  onCopySuccess: () => void
}) {
  return (
    <VirtualizedCodeViewer
      label="Raw response body"
      language={language}
      value={body}
      wrap={wrap}
      onCopyError={onCopyError}
      onCopySuccess={onCopySuccess}
    />
  )
}

function OutputPanel({
  parsed,
  bodyIsEmpty,
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  parsed: ParsedResponsesBody | null
  bodyIsEmpty: boolean
  wrap: boolean
  onCopyError: (message: string) => void
  onCopySuccess: () => void
}) {
  if (bodyIsEmpty) {
    return <Text color="secondary">The response body is empty.</Text>
  }
  if (!parsed) {
    return (
      <Text color="secondary">
        This response format is not recognized. Use Raw.
      </Text>
    )
  }

  const description = describeResponseOutput(parsed)
  const assistantText = parsed.assistantText

  async function copyAssistantOutput(): Promise<void> {
    try {
      await navigator.clipboard.writeText(assistantText)
    } catch (error) {
      onCopyError(jsonCopyErrorMessage(error))
      return
    }
    onCopySuccess()
  }

  let responseOutput: ReactNode
  switch (description.kind) {
    case "assistant": {
      responseOutput = (
        <section aria-labelledby="response-inspector-output-heading">
          <VStack gap={2}>
            <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
              <Heading id="response-inspector-output-heading" level={4}>
                Assistant output
              </Heading>
              <Button
                label="Copy output"
                variant="ghost"
                size="sm"
                icon={<CopyIcon />}
                onClick={() => void copyAssistantOutput()}
              />
            </HStack>
            <div
              className="responses-output response-inspector-output"
              role="region"
              aria-label="Assembled assistant output"
              tabIndex={0}
            >
              <Markdown contentWidth="100%" headingLevelStart={5}>
                {assistantText}
              </Markdown>
            </div>
          </VStack>
        </section>
      )

      break
    }
    case "tool-only": {
      responseOutput = (
        <Banner
          status="info"
          title="Tool-only response"
          description={description.message}
        />
      )

      break
    }
    case "error": {
      responseOutput = null

      break
    }
    default: {
      responseOutput = (
        <Text
          color="secondary"
          aria-live={parsed.isPartial ? "polite" : undefined}
        >
          {description.message}
        </Text>
      )
    }
  }

  return (
    <VStack gap={4}>
      {parsed.isPartial ?
        <Banner
          status="warning"
          title="Partial response capture"
          description="The terminal stream marker has not been captured. Open the Events tab to inspect the available events."
        />
      : null}

      {description.errorMessage ?
        <Banner
          status="error"
          title="Response error"
          description={description.errorMessage}
        />
      : null}

      {responseOutput}

      {parsed.toolCalls.length > 0 ?
        <VStack gap={2}>
          <Heading level={4}>Tool calls ({parsed.toolCalls.length})</Heading>
          {parsed.toolCalls.map((call, index) => (
            <ToolCallViewer
              key={`${call.outputIndex}:${call.id ?? call.callId ?? index}`}
              call={call}
              index={index}
              wrap={wrap}
              onCopyError={onCopyError}
              onCopySuccess={onCopySuccess}
            />
          ))}
        </VStack>
      : null}

      {parsed.reasoningText ?
        <Collapsible defaultIsOpen={false} trigger="Reasoning summary">
          <VirtualizedCodeViewer
            label="Reasoning summary"
            language="text"
            value={parsed.reasoningText}
            wrap={wrap}
            onCopyError={onCopyError}
            onCopySuccess={onCopySuccess}
          />
        </Collapsible>
      : null}
    </VStack>
  )
}

function ResponseInspectorSession({
  durationMs,
  id,
  responseIdentity,
  response,
  onCopyError,
  onCopySuccess,
  onExport,
  onExportError,
}: ResponseInspectorProps) {
  const parsed = useMemo(
    () => (response.body ? parseResponsesBody(response.body) : null),
    [response.body],
  )
  const [storedViewState, setViewState] = useState(() =>
    initialResponseInspectorViewState(responseIdentity),
  )
  const viewState = responseInspectorViewState(
    storedViewState,
    responseIdentity,
  )
  const { selectedEvent, tab } = viewState
  const [rawLanguage] = useState(() =>
    responseBodyLanguage(response.body ?? "", response.headers),
  )
  const [wrap, setWrap] = useState(false)

  const events = parsed?.events ?? []
  const selectedIndex = Math.min(selectedEvent, Math.max(0, events.length - 1))
  const event = events[selectedIndex]
  const headers = Object.entries(response.headers).map(([label, value]) => ({
    label,
    value,
  }))

  let panel: ReactNode
  switch (tab) {
    case "output": {
      panel = (
        <OutputPanel
          parsed={parsed}
          bodyIsEmpty={!response.body}
          wrap={wrap}
          onCopyError={onCopyError}
          onCopySuccess={onCopySuccess}
        />
      )

      break
    }
    case "details": {
      panel = (
        <VStack gap={4}>
          {parsed ?
            <>
              <MetadataSection
                items={metadataItems(parsed)}
                source="response-details"
                title="Response details"
              />
              <MetadataSection
                items={usageItems(parsed.usage)}
                source="token-usage"
                title="Token usage"
              />
              <MetadataSection
                items={copilotUsageItems(parsed.copilotUsage)}
                source="copilot-usage"
                title="Copilot usage"
              />
            </>
          : null}
          <MetadataSection
            items={headers}
            source="response-headers"
            title="Response headers"
          />
        </VStack>
      )

      break
    }
    case "events": {
      panel =
        events.length === 0 ?
          <Text color="secondary">No response events were captured.</Text>
        : <VStack gap={3}>
            <Selector
              label="Event"
              value={String(selectedIndex)}
              options={events.map((item, index) => ({
                label: eventLabel(item, index),
                value: String(index),
              }))}
              width="100%"
              onChange={(value) =>
                setViewState({
                  ...viewState,
                  selectedEvent: Number.parseInt(value, 10) || 0,
                })
              }
            />
            <EventViewer
              event={event}
              index={selectedIndex}
              wrap={wrap}
              onCopyError={onCopyError}
              onCopySuccess={onCopySuccess}
            />
          </VStack>

      break
    }
    default: {
      panel = (
        <RawResponseBody
          body={response.body ?? ""}
          language={rawLanguage}
          wrap={wrap}
          onCopyError={onCopyError}
          onCopySuccess={onCopySuccess}
        />
      )
    }
  }

  return (
    <VStack gap={4} className="response-inspector">
      <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
        <HStack vAlign="center" gap={3} wrap="wrap">
          <Heading level={4}>Response</Heading>
          <Text type="code">
            {`${response.status} ${response.statusText}`.trim()}
          </Text>
          {durationMs === undefined ? null : (
            <Text type="supporting" color="secondary">
              {durationMs.toLocaleString()} ms
            </Text>
          )}
        </HStack>
        <HStack vAlign="center" gap={3} wrap="wrap">
          <Switch label="Wrap response" value={wrap} onChange={setWrap} />
          <ResponseExportMenu
            id={id}
            parsed={parsed}
            response={response}
            onError={onExportError}
            onExport={onExport}
          />
        </HStack>
      </HStack>

      <TabList
        aria-label="Response views"
        className="response-inspector-nav"
        hasDivider
        value={tab}
        onChange={(value) =>
          setViewState({ ...viewState, tab: value as ResponseInspectorTab })
        }
      >
        <Tab value="output" label="Output" />
        <Tab value="details" label="Details" />
        <Tab value="events" label={`Events (${events.length})`} />
        <Tab value="raw" label="Raw" />
      </TabList>

      <div
        className="response-inspector-panel"
        role="region"
        aria-label={`${tab} response view`}
      >
        {panel}
      </div>
    </VStack>
  )
}

export function ResponseInspector(props: ResponseInspectorProps) {
  return <ResponseInspectorSession key={props.responseIdentity} {...props} />
}
