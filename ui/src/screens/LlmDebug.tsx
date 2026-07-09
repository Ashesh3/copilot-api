import type { StatusDotProps } from "@astryxdesign/core/StatusDot"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { IconButton } from "@astryxdesign/core/IconButton"
import { List, ListItem } from "@astryxdesign/core/List"
import { Section } from "@astryxdesign/core/Section"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Switch } from "@astryxdesign/core/Switch"
import {
  pixel,
  proportional,
  Table,
  useTableSortable,
  useTableSortableState,
} from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useMemo, useState } from "react"

import type { LlmDebugDetail, LlmDebugEntry } from "../lib/types"

import {
  ConfirmButton,
  EmptyState,
  IconAction,
  MonoText,
  RelTime,
} from "../components/common"
import { Page } from "../components/Page"
import {
  BugIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
} from "../icons"
import { ApiError, del, get } from "../lib/api"
import { navigate, useHashRoute } from "../lib/router"
import { useToast } from "../lib/toast"
import { useAsyncData, usePolling } from "../lib/usePolling"

const POLL_INTERVAL_MS = 10_000

// The real /api/llm-debug endpoint wraps the entries in a small envelope
// rather than returning a bare array (verified against
// src/lib/llm-debug-log.ts#listLlmDebugLogs). Not exported from lib/types.ts,
// so it's declared locally here.
interface LlmDebugListResponse {
  count: number
  entries: Array<LlmDebugEntry>
  generatedAt: string
  retentionMs: number
}

type DebugRow = LlmDebugEntry & Record<string, unknown>

type StatusFilter = "all" | LlmDebugEntry["status"]

function loadEntries(): Promise<LlmDebugListResponse> {
  return get<LlmDebugListResponse>("/dashboard/api/llm-debug")
}

function loadDetail(id: string): Promise<LlmDebugDetail> {
  return get<LlmDebugDetail>(`/dashboard/api/llm-debug/${id}`)
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function totalBytes(entry: LlmDebugEntry): number {
  return entry.requestBodyBytes + (entry.responseBodyBytes ?? 0)
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function buildCurl(request: LlmDebugDetail["request"]): string {
  const lines = [
    `curl -X ${request.method.toUpperCase()} ${JSON.stringify(request.url)}`,
  ]
  for (const [key, value] of Object.entries(request.headers)) {
    lines.push(`  -H ${JSON.stringify(`${key}: ${value}`)}`)
  }
  if (request.body) {
    lines.push(`  --data-raw ${JSON.stringify(request.body)}`)
  }
  return lines.join(" \\\n")
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function statusDotVariant(
  status: LlmDebugEntry["status"],
): StatusDotProps["variant"] {
  if (status === "complete") return "success"
  if (status === "error") return "error"
  return "accent"
}

function canReplay(request: LlmDebugDetail["request"]): boolean {
  return (
    request.method.toUpperCase() === "POST"
    && (request.path === "/chat/completions" || request.path === "/responses")
  )
}

export default function LlmDebugScreen() {
  const { param } = useHashRoute()

  return param ? <LlmDebugDetailView id={param} /> : <LlmDebugListView />
}

function LlmDebugListView() {
  const { data, error, loading, reload, reloadSilently } = useAsyncData(
    loadEntries,
    [],
  )

  usePolling(() => reloadSilently(), POLL_INTERVAL_MS, [])

  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [isExporting, setIsExporting] = useState(false)

  const entries = useMemo(() => data?.entries ?? [], [data])
  const retentionMs = data?.retentionMs

  const filtered = useMemo<Array<DebugRow>>(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (statusFilter !== "all" && entry.status !== statusFilter) return false
      if (!needle) return true
      const haystack =
        `${entry.method} ${entry.path} ${entry.model ?? ""} ${entry.requestId ?? ""}`.toLowerCase()
      return haystack.includes(needle)
    }) as Array<DebugRow>
  }, [entries, query, statusFilter])

  const { sortedData, sortConfig } = useTableSortableState<DebugRow>({
    data: filtered,
    defaultSort: [{ sortKey: "startedAt", direction: "descending" }],
    comparators: {
      startedAt: (a, b) =>
        new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      size: (a, b) => totalBytes(a) - totalBytes(b),
    },
  })
  const sortPlugin = useTableSortable<DebugRow>(sortConfig)

  async function handleClearAll() {
    await del("/dashboard/api/llm-debug")
    reload()
  }

  async function handleExport() {
    setIsExporting(true)
    try {
      const details = await Promise.all(
        entries.map((entry) => loadDetail(entry.id).catch(() => null)),
      )
      const full = details.filter(
        (detail): detail is LlmDebugDetail => detail !== null,
      )
      const blob = new Blob([JSON.stringify(full, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `llm-debug-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } finally {
      setIsExporting(false)
    }
  }

  const columns: Array<TableColumn<DebugRow>> = [
    {
      key: "status",
      header: "Status",
      width: pixel(128),
      sortable: true,
      renderCell: (row) => (
        <HStack gap={2} vAlign="center">
          <StatusDot
            variant={statusDotVariant(row.status)}
            label={row.status}
            isPulsing={row.status === "pending"}
          />
          <Text
            type="supporting"
            style={
              row.status === "error" ?
                { color: "var(--color-error)" }
              : undefined
            }
          >
            {capitalize(row.status)}
          </Text>
        </HStack>
      ),
    },
    {
      key: "path",
      header: "Endpoint",
      width: proportional(2, { minWidth: 220 }),
      sortable: true,
      renderCell: (row) => (
        <MonoText>
          {row.method} {row.path}
        </MonoText>
      ),
    },
    {
      key: "model",
      header: "Model",
      width: proportional(1, { minWidth: 120 }),
      sortable: true,
      renderCell: (row) =>
        row.model ?
          <MonoText>{row.model}</MonoText>
        : <Text type="supporting" color="secondary">
            —
          </Text>,
    },
    {
      key: "size",
      header: "Req / Resp",
      width: pixel(120),
      align: "end",
      sortable: { sortKey: "size" },
      renderCell: (row) => (
        <Text type="supporting" color="secondary">
          {fmtBytes(row.requestBodyBytes)} / {fmtBytes(row.responseBodyBytes)}
        </Text>
      ),
    },
    {
      key: "durationMs",
      header: "Duration",
      width: pixel(96),
      align: "end",
      sortable: true,
      renderCell: (row) =>
        row.durationMs === undefined ?
          <Text type="supporting" color="secondary">
            —
          </Text>
        : <Text type="supporting" color="secondary">
            {row.durationMs} ms
          </Text>,
    },
    {
      key: "startedAt",
      header: "Time",
      width: pixel(116),
      align: "end",
      sortable: true,
      renderCell: (row) => <RelTime ts={row.startedAt} />,
    },
    {
      key: "actions",
      header: "",
      width: pixel(48),
      align: "end",
      renderCell: (row) => (
        <IconAction
          label="Inspect request"
          icon={<ChevronRightIcon />}
          onClick={() => navigate("llm-debug", row.id)}
        />
      ),
    },
  ]

  return (
    <Page
      kicker="Monitor"
      title="LLM Debug"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        entries.length > 0 ?
          <HStack gap={2}>
            <Button
              label="Export"
              variant="secondary"
              icon={<DownloadIcon />}
              isLoading={isExporting}
              onClick={handleExport}
            />
            <ConfirmButton
              label="Clear All"
              confirmTitle="Clear all debug logs?"
              confirmDescription="This permanently deletes every captured LLM debug log entry. This cannot be undone."
              confirmActionLabel="Clear All"
              icon={<Trash2Icon />}
              onConfirm={handleClearAll}
            />
          </HStack>
        : undefined
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load debug logs"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={56} index={index} />
          ))}
        </VStack>
      : null}

      {data && entries.length === 0 ?
        <EmptyState
          icon={<BugIcon />}
          title="No debug logs yet"
          description="LLM requests and responses will appear here as they are captured."
        />
      : null}

      {entries.length > 0 ?
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <TextInput
                label="Search debug logs"
                isLabelHidden
                placeholder="Search method, path, or model…"
                value={query}
                onChange={setQuery}
              />
            </StackItem>
            <SegmentedControl
              label="Filter by status"
              size="sm"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SegmentedControlItem value="all" label="All" />
              <SegmentedControlItem value="error" label="Errors" />
              <SegmentedControlItem value="pending" label="Pending" />
              <SegmentedControlItem value="complete" label="Complete" />
            </SegmentedControl>
          </HStack>

          <HStack hAlign="between" vAlign="center">
            <Text type="supporting" color="secondary">
              {filtered.length === entries.length ?
                `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
              : `${filtered.length} of ${entries.length} entries`}
            </Text>
            {retentionMs === undefined ? null : (
              <Text type="supporting" color="secondary">
                Retained for {fmtDuration(retentionMs)}
              </Text>
            )}
          </HStack>

          {filtered.length === 0 ?
            <EmptyState
              icon={<SearchIcon />}
              title="No matching logs"
              description="No debug logs match your search and filter. Try broadening them."
              actions={
                <Button
                  label="Clear filters"
                  variant="secondary"
                  onClick={() => {
                    setQuery("")
                    setStatusFilter("all")
                  }}
                />
              }
            />
          : <Table
              data={sortedData}
              columns={columns}
              idKey="id"
              density="compact"
              textOverflow="truncate"
              dividers="rows"
              hasHover
              plugins={{ sort: sortPlugin }}
            />
          }
        </VStack>
      : null}
    </Page>
  )
}

function HeaderList({
  headers,
  onCopy,
}: {
  headers: Record<string, string>
  onCopy: (value: string) => void
}) {
  const entries = Object.entries(headers)

  if (entries.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        No headers
      </Text>
    )
  }

  return (
    <List hasDividers density="compact">
      {entries.map(([key, value]) => (
        <ListItem
          key={key}
          label={key}
          description={value}
          endContent={
            <IconButton
              label={`Copy ${key}`}
              tooltip="Copy value"
              icon={<CopyIcon />}
              variant="ghost"
              size="sm"
              onClick={() => onCopy(value)}
            />
          }
        />
      ))}
    </List>
  )
}

function PayloadBlock({
  label,
  body,
  emptyText,
  viewMode,
  wrap,
  onCopy,
}: {
  label: string
  body: string | null
  emptyText: string
  viewMode: "pretty" | "raw"
  wrap: boolean
  onCopy: () => void
}) {
  if (body === null) {
    return (
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {label}
        </Text>
        <Text type="supporting" color="secondary">
          {emptyText}
        </Text>
      </VStack>
    )
  }

  const pretty = prettyJson(body)
  const reformatted = viewMode === "pretty" && pretty !== body

  return (
    <Collapsible defaultIsOpen trigger={label}>
      <VStack gap={1}>
        {reformatted ?
          <Badge variant="neutral" label="Reformatted, not exact bytes" />
        : null}
        <CodeBlock
          code={reformatted ? pretty : body}
          language="json"
          isWrapped={wrap}
          onCopy={onCopy}
        />
      </VStack>
    </Collapsible>
  )
}

function LlmDebugDetailView({ id }: { id: string }) {
  const { data, error, loading, reload, reloadSilently } = useAsyncData(
    () => loadDetail(id),
    [id],
  )
  const toast = useToast()
  const [viewMode, setViewMode] = useState<"pretty" | "raw">("pretty")
  const [wrap, setWrap] = useState(false)

  usePolling(
    () => {
      if (data?.status === "pending") reloadSilently()
    },
    POLL_INTERVAL_MS,
    [data?.status],
  )

  function copy(text: string) {
    void navigator.clipboard.writeText(text)
    toast.success("Copied")
  }

  const showReplay = data ? canReplay(data.request) : false
  const notFound = error instanceof ApiError && error.status === 404

  return (
    <Page
      kicker="Monitor"
      title="LLM Debug"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <HStack gap={2}>
          <Button
            label="Copy as cURL"
            variant="ghost"
            size="sm"
            icon={<CopyIcon />}
            isDisabled={!data}
            onClick={() => {
              if (data) copy(buildCurl(data.request))
            }}
          />
          <Button
            label="Copy link"
            variant="ghost"
            size="sm"
            icon={<ExternalLinkIcon />}
            onClick={() => copy(globalThis.location.href)}
          />
          <Button
            label="Replay"
            variant="primary"
            icon={<PlayIcon />}
            isDisabled={!showReplay}
            tooltip={
              data && !showReplay ?
                "Only POST /chat/completions and /responses can be replayed"
              : undefined
            }
            onClick={() => navigate("llm-replay", id)}
          />
          <Button
            label="Back to list"
            variant="secondary"
            onClick={() => navigate("llm-debug")}
          />
        </HStack>
      }
    >
      {error && !notFound ?
        <Banner
          status="error"
          title="Failed to load debug log entry"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={4}>
          <Skeleton height={120} />
          <Skeleton height={240} index={1} />
        </VStack>
      : null}

      {notFound || (!data && !loading && !error) ?
        <EmptyState
          icon={<BugIcon />}
          title="Entry not found"
          description="This debug log entry could not be found. It may have expired or been cleared."
          actions={
            <Button
              label="Back to list"
              variant="secondary"
              onClick={() => navigate("llm-debug")}
            />
          }
        />
      : null}

      {data ?
        <VStack gap={4}>
          <HStack gap={3} vAlign="center" hAlign="end">
            <SegmentedControl
              label="Body format"
              size="sm"
              value={viewMode}
              onChange={(value) => setViewMode(value as "pretty" | "raw")}
            >
              <SegmentedControlItem value="pretty" label="Pretty" />
              <SegmentedControlItem value="raw" label="Raw" />
            </SegmentedControl>
            <Switch label="Wrap" value={wrap} onChange={setWrap} />
          </HStack>

          {data.error ?
            <Banner
              status="error"
              title={data.error.name}
              description={data.error.message}
            >
              {data.error.stack ?
                <CodeBlock
                  code={data.error.stack}
                  language="plaintext"
                  container="section"
                  title="Stack trace"
                  isWrapped={wrap}
                  onCopy={() => toast.success("Copied")}
                />
              : null}
            </Banner>
          : null}

          <Section dividers={["bottom"]}>
            <VStack gap={3}>
              <HStack gap={3} vAlign="center">
                <MonoText>{data.request.method}</MonoText>
                <MonoText>{data.request.path}</MonoText>
                <RelTime ts={data.startedAt} />
                {data.durationMs === undefined ? null : (
                  <Text type="supporting" color="secondary">
                    {data.durationMs} ms
                  </Text>
                )}
              </HStack>
              <Text type="code" color="secondary">
                {data.request.url}
              </Text>

              <Collapsible
                trigger={`Request Headers (${Object.keys(data.request.headers).length})`}
                defaultIsOpen={false}
              >
                <HeaderList headers={data.request.headers} onCopy={copy} />
              </Collapsible>

              <PayloadBlock
                label="Request Body"
                body={data.request.body}
                emptyText="No request body"
                viewMode={viewMode}
                wrap={wrap}
                onCopy={() => toast.success("Copied")}
              />
            </VStack>
          </Section>

          {data.response ?
            <Section>
              <VStack gap={3}>
                <HStack gap={3} vAlign="center">
                  <MonoText>
                    {data.response.status} {data.response.statusText}
                  </MonoText>
                </HStack>

                <Collapsible
                  trigger={`Response Headers (${Object.keys(data.response.headers).length})`}
                  defaultIsOpen={false}
                >
                  <HeaderList headers={data.response.headers} onCopy={copy} />
                </Collapsible>

                <VStack gap={1}>
                  <PayloadBlock
                    label="Response Body"
                    body={data.response.body}
                    emptyText="No response body"
                    viewMode={viewMode}
                    wrap={wrap}
                    onCopy={() => toast.success("Copied")}
                  />
                  {data.response.bodyReadError ?
                    <Banner
                      status="warning"
                      title="Response body read error"
                      description={data.response.bodyReadError.message}
                    />
                  : null}
                </VStack>
              </VStack>
            </Section>
          : <Section>
              <Text type="supporting" color="secondary">
                {data.status === "pending" ?
                  "Awaiting response…"
                : "No response was received."}
              </Text>
            </Section>
          }
        </VStack>
      : null}
    </Page>
  )
}
