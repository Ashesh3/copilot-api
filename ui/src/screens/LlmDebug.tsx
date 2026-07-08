import type { StatusDotProps } from "@astryxdesign/core/StatusDot"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { IconButton } from "@astryxdesign/core/IconButton"
import { List, ListItem } from "@astryxdesign/core/List"
import { Section } from "@astryxdesign/core/Section"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Text } from "@astryxdesign/core/Text"

import type { LlmDebugDetail, LlmDebugEntry } from "../lib/types"

import {
  ConfirmButton,
  EmptyState,
  MonoText,
  RelTime,
} from "../components/common"
import { Page } from "../components/Page"
import { BugIcon, CopyIcon, PlayIcon, Trash2Icon } from "../icons"
import { del, get } from "../lib/api"
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

function loadEntries(): Promise<Array<LlmDebugEntry>> {
  return get<LlmDebugListResponse>("/dashboard/api/llm-debug").then(
    (response) => response.entries,
  )
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
  const { data, error, loading, reload } = useAsyncData(loadEntries, [])
  const toast = useToast()

  usePolling(() => reload(), POLL_INTERVAL_MS, [])

  const entries = data ?? []

  async function handleClearAll() {
    await del("/dashboard/api/llm-debug")
    toast.success("Cleared all debug logs")
    reload()
  }

  return (
    <Page
      kicker="Monitor"
      title="LLM Debug"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        entries.length > 0 ?
          <ConfirmButton
            label="Clear All"
            confirmTitle="Clear all debug logs?"
            confirmDescription="This permanently deletes every captured LLM debug log entry. This cannot be undone."
            confirmActionLabel="Clear All"
            icon={<Trash2Icon />}
            onConfirm={handleClearAll}
          />
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
        <List hasDividers>
          {entries.map((entry) => (
            <ListItem
              key={entry.id}
              label={`${entry.method} ${entry.path}`}
              description={entry.model}
              startContent={
                <HStack gap={2} vAlign="center">
                  <StatusDot
                    variant={statusDotVariant(entry.status)}
                    label={entry.status}
                    isPulsing={entry.status === "pending"}
                  />
                  <Text type="supporting" color="secondary">
                    {capitalize(entry.status)}
                  </Text>
                </HStack>
              }
              endContent={
                <HStack gap={4} vAlign="center">
                  <Text type="supporting" color="secondary">
                    {fmtBytes(entry.requestBodyBytes)} /{" "}
                    {fmtBytes(entry.responseBodyBytes)}
                  </Text>
                  {entry.durationMs === undefined ? null : (
                    <Text type="supporting" color="secondary">
                      {entry.durationMs} ms
                    </Text>
                  )}
                  <RelTime ts={entry.startedAt} />
                </HStack>
              }
              onClick={() => navigate("llm-debug", entry.id)}
            />
          ))}
        </List>
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

function LlmDebugDetailView({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsyncData(
    () => loadDetail(id),
    [id],
  )
  const toast = useToast()

  function copy(text: string) {
    void navigator.clipboard.writeText(text)
    toast.success("Copied")
  }

  const showReplay = data ? canReplay(data.request) : false

  return (
    <Page
      kicker="Monitor"
      title="LLM Debug"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <HStack gap={2}>
          {showReplay ?
            <Button
              label="Replay"
              variant="primary"
              icon={<PlayIcon />}
              onClick={() => navigate("llm-replay", id)}
            />
          : null}
          <Button
            label="Back to list"
            variant="secondary"
            onClick={() => navigate("llm-debug")}
          />
        </HStack>
      }
    >
      {error ?
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

      {!data && !loading && !error ?
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
              <Text type="supporting" color="secondary">
                {data.request.url}
              </Text>

              <Collapsible
                trigger={`Request Headers (${Object.keys(data.request.headers).length})`}
                defaultIsOpen={false}
              >
                <HeaderList headers={data.request.headers} onCopy={copy} />
              </Collapsible>

              <VStack gap={1}>
                <Text type="label" color="secondary">
                  Request Body
                </Text>
                {data.request.body === null ?
                  <Text type="supporting" color="secondary">
                    No request body
                  </Text>
                : <CodeBlock
                    code={data.request.body}
                    language="json"
                    maxHeight={400}
                    onCopy={() => toast.success("Copied")}
                  />
                }
              </VStack>
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
                  <Text type="label" color="secondary">
                    Response Body
                  </Text>
                  {data.response.body === null ?
                    <Text type="supporting" color="secondary">
                      No response body
                    </Text>
                  : <CodeBlock
                      code={data.response.body}
                      language="json"
                      maxHeight={400}
                      onCopy={() => toast.success("Copied")}
                    />
                  }
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
          : null}
        </VStack>
      : null}
    </Page>
  )
}
