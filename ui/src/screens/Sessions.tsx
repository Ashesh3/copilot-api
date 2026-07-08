import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { IconButton } from "@astryxdesign/core/IconButton"
import { List, ListItem } from "@astryxdesign/core/List"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { pixel, proportional, Table } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"

import type {
  Session,
  SessionEvent,
  SessionState,
  SessionType,
} from "../lib/types"

import {
  ConfirmButton,
  EmptyState,
  MonoText,
  RelTime,
} from "../components/common"
import { Page } from "../components/Page"
import { ActivityIcon, DownloadIcon, MonitorIcon, Trash2Icon } from "../icons"
import { del, get, post } from "../lib/api"
import { navigate, useHashRoute } from "../lib/router"
import { useToast } from "../lib/toast"
import { useAsyncData, usePolling } from "../lib/usePolling"

const POLL_INTERVAL_MS = 15_000

interface SessionRow extends Record<string, unknown> {
  id: string
  title: string
  state: SessionState
  type: SessionType
  createdAt: number
  lastHeartbeat: number | null
  tags: Array<string>
}

const STATE_VARIANT: Record<
  SessionState,
  "success" | "warning" | "error" | "accent" | "neutral"
> = {
  idle: "neutral",
  running: "success",
  requires_action: "warning",
  connected: "accent",
}

const STATE_LABEL: Record<SessionState, string> = {
  idle: "Idle",
  running: "Running",
  requires_action: "Requires Action",
  connected: "Connected",
}

const TYPE_LABEL: Record<SessionType, string> = {
  "code-session": "Code Session",
  "direct-connect": "Direct Connect",
}

function loadSessions(): Promise<Array<Session>> {
  return get<Array<Session>>("/dashboard/api/sessions")
}

function loadEvents(
  sessionId: string | undefined,
): Promise<Array<SessionEvent>> {
  if (!sessionId) return Promise.resolve([])
  return get<Array<SessionEvent>>(`/dashboard/api/sessions/${sessionId}/events`)
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function SessionEventsDetail({
  sessionId,
  sessionTitle,
}: {
  sessionId: string
  sessionTitle: string | undefined
}) {
  const { data, error, loading, reload } = useAsyncData(
    () => loadEvents(sessionId),
    [sessionId],
  )

  return (
    <Page
      kicker="Monitor"
      title="Sessions"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <Button
          label="Back"
          variant="secondary"
          onClick={() => navigate("sessions")}
        />
      }
    >
      <Heading level={2}>{sessionTitle ?? sessionId}</Heading>

      {error ?
        <Banner
          status="error"
          title="Failed to load events"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={64} index={index} />
          ))}
        </VStack>
      : null}

      {data && data.length === 0 ?
        <EmptyState
          icon={<ActivityIcon />}
          title="No events"
          description="This session has no recorded events yet."
        />
      : null}

      {data && data.length > 0 ?
        <List hasDividers header={<Heading level={3}>Recent Events</Heading>}>
          {data.map((event) => (
            <ListItem
              key={event.event_id}
              label={event.event_type}
              description={
                <VStack gap={1}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text type="supporting" color="secondary">
                      {event.source}
                    </Text>
                    <RelTime ts={event.created_at} />
                    {event.is_compaction ?
                      <Badge variant="warning" label="Compaction" />
                    : null}
                    {event.agent_id ?
                      <Badge variant="neutral" label={event.agent_id} />
                    : null}
                  </HStack>
                  <MonoText>{JSON.stringify(event.payload, null, 2)}</MonoText>
                </VStack>
              }
            />
          ))}
        </List>
      : null}
    </Page>
  )
}

export default function SessionsScreen() {
  const route = useHashRoute()
  const toast = useToast()
  const { data, error, loading, reload } = useAsyncData(loadSessions, [])

  usePolling(() => reload(), POLL_INTERVAL_MS, [])

  const handleArchive = async (id: string, title: string) => {
    try {
      await post<unknown>(`/dashboard/api/sessions/${id}/archive`)
      reload()
    } catch (err) {
      toast.error(errorMessage(err, `Failed to archive "${title}"`))
    }
  }

  const handleDestroy = async (id: string, title: string) => {
    try {
      await del<unknown>(`/dashboard/api/sessions/${id}`)
      reload()
    } catch (err) {
      toast.error(errorMessage(err, `Failed to destroy "${title}"`))
    }
  }

  if (route.param) {
    const session = data?.find((item) => item.id === route.param)
    return (
      <SessionEventsDetail
        sessionId={route.param}
        sessionTitle={session?.title}
      />
    )
  }

  const rows: Array<SessionRow> = (data ?? []).map((session) => ({
    ...session,
  }))

  const columns: Array<TableColumn<SessionRow>> = [
    {
      key: "title",
      header: "Session",
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0.5}>
          <Text weight="semibold">{row.title}</Text>
          <MonoText>{row.id}</MonoText>
        </VStack>
      ),
    },
    {
      key: "type",
      header: "Type",
      width: proportional(1),
      renderCell: (row) => (
        <Badge
          variant={row.type === "code-session" ? "blue" : "purple"}
          label={TYPE_LABEL[row.type]}
        />
      ),
    },
    {
      key: "state",
      header: "State",
      width: proportional(1),
      renderCell: (row) => (
        <HStack gap={2} vAlign="center">
          <StatusDot
            variant={STATE_VARIANT[row.state]}
            label={STATE_LABEL[row.state]}
            isPulsing={row.state === "running"}
          />
          <Text type="supporting">{STATE_LABEL[row.state]}</Text>
        </HStack>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      width: proportional(1),
      renderCell: (row) => <RelTime ts={row.createdAt} />,
    },
    {
      key: "lastHeartbeat",
      header: "Last Heartbeat",
      width: proportional(1),
      renderCell: (row) =>
        row.lastHeartbeat === null ?
          <Text type="supporting" color="secondary">
            —
          </Text>
        : <RelTime ts={row.lastHeartbeat} />,
    },
    {
      key: "tags",
      header: "Tags",
      width: proportional(1),
      renderCell: (row) =>
        row.tags.length === 0 ?
          <Text type="supporting" color="secondary">
            —
          </Text>
        : <HStack gap={1} wrap="wrap">
            {row.tags.map((tag) => (
              <Badge key={tag} variant="neutral" label={tag} />
            ))}
          </HStack>,
    },
    {
      key: "actions",
      header: "",
      width: pixel(160),
      align: "end",
      renderCell: (row) => (
        <HStack gap={1} hAlign="end">
          <IconButton
            label="View events"
            tooltip="View events"
            icon={<ActivityIcon />}
            variant="ghost"
            size="sm"
            onClick={() => navigate("sessions", row.id)}
          />
          <ConfirmButton
            label="Archive"
            icon={<DownloadIcon />}
            isIconOnly
            size="sm"
            variant="secondary"
            confirmTitle="Archive session?"
            confirmDescription={`Archive "${row.title}"? It will no longer be active.`}
            confirmActionLabel="Archive"
            onConfirm={() => handleArchive(row.id, row.title)}
          />
          <ConfirmButton
            label="Destroy"
            icon={<Trash2Icon />}
            isIconOnly
            size="sm"
            confirmTitle="Destroy session?"
            confirmDescription={`Permanently destroy "${row.title}"? This can't be undone.`}
            confirmActionLabel="Destroy"
            onConfirm={() => handleDestroy(row.id, row.title)}
          />
        </HStack>
      ),
    },
  ]

  return (
    <Page
      kicker="Monitor"
      title="Sessions"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load sessions"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} height={56} index={index} />
          ))}
        </VStack>
      : null}

      {data && data.length === 0 ?
        <EmptyState
          icon={<MonitorIcon />}
          title="No sessions"
          description="Sessions will appear here once they are created."
        />
      : null}

      {data && data.length > 0 ?
        <Table
          data={rows}
          columns={columns}
          idKey="id"
          density="compact"
          hasHover
        />
      : null}
    </Page>
  )
}
