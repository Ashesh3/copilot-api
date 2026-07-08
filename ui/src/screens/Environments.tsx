import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Link } from "@astryxdesign/core/Link"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"

import type { Environment } from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  IconAction,
  MonoText,
  RelTime,
  RowActions,
} from "../components/common"
import { Page } from "../components/Page"
import { PlayIcon, ServerIcon, Trash2Icon } from "../icons"
import { del, get, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData, usePolling } from "../lib/usePolling"

const POLL_INTERVAL_MS = 20_000

interface EnvironmentRow extends Record<string, unknown> {
  id: string
  machineName: string
  directory: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  createdAt: number
  pendingWorkCount: number
}

interface StartSessionResult {
  sessionId: string
  workId: string
  success: boolean
}

function loadEnvironments(): Promise<Array<Environment>> {
  return get<Array<Environment>>("/dashboard/api/environments")
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export default function EnvironmentsScreen() {
  const toast = useToast()
  const { data, error, loading, reload } = useAsyncData(loadEnvironments, [])

  usePolling(() => reload(), POLL_INTERVAL_MS, [])

  const handleStart = async (id: string, machineName: string) => {
    try {
      const result = await post<StartSessionResult>(
        `/dashboard/api/environments/${id}/start`,
      )
      toast.success(`Started session ${result.sessionId} on ${machineName}`)
    } catch (err) {
      toast.error(
        errorMessage(err, `Failed to start a session on ${machineName}`),
      )
    }
  }

  const handleDeregister = async (id: string, machineName: string) => {
    try {
      await del<unknown>(`/dashboard/api/environments/${id}`)
      reload()
    } catch (err) {
      toast.error(errorMessage(err, `Failed to deregister ${machineName}`))
    }
  }

  const rows: Array<EnvironmentRow> = (data ?? []).map((env) => ({ ...env }))

  const columns: Array<TableColumn<EnvironmentRow>> = [
    {
      key: "machineName",
      header: "Machine",
      width: proportional(1),
      renderCell: (row) => <Text weight="semibold">{row.machineName}</Text>,
    },
    {
      key: "directory",
      header: "Directory / Branch",
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0.5}>
          <MonoText>{row.directory}</MonoText>
          <HStack gap={1} vAlign="center">
            <Text type="supporting" color="secondary">
              {row.branch}
            </Text>
            {row.gitRepoUrl ?
              <Link
                href={row.gitRepoUrl}
                isExternalLink
                isStandalone
                tooltip={row.gitRepoUrl}
              >
                Repo
              </Link>
            : null}
          </HStack>
        </VStack>
      ),
    },
    {
      key: "maxSessions",
      header: "Max Sessions",
      width: pixel(90),
      renderCell: (row) => <Text>{row.maxSessions}</Text>,
    },
    {
      key: "pendingWorkCount",
      header: "Pending Work",
      width: pixel(90),
      renderCell: (row) =>
        row.pendingWorkCount > 0 ?
          <Badge variant="warning" label={String(row.pendingWorkCount)} />
        : <Text type="supporting" color="secondary">
            0
          </Text>,
    },
    {
      key: "createdAt",
      header: "Created",
      width: pixel(140),
      renderCell: (row) => <RelTime ts={row.createdAt} />,
    },
    {
      key: "actions",
      header: "",
      width: pixel(88),
      align: "end",
      renderCell: (row) => (
        <RowActions>
          <IconAction
            label="Start session"
            icon={<PlayIcon />}
            onClick={() => handleStart(row.id, row.machineName)}
          />
          <ConfirmButton
            label="Deregister"
            isIconOnly
            icon={<Trash2Icon />}
            size="sm"
            confirmTitle="Deregister environment?"
            confirmDescription={`Deregister "${row.machineName}"? It will no longer be available for new sessions.`}
            confirmActionLabel="Deregister"
            onConfirm={() => handleDeregister(row.id, row.machineName)}
          />
        </RowActions>
      ),
    },
  ]

  return (
    <Page
      kicker="Monitor"
      title="Environments"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load environments"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={56} index={index} />
          ))}
        </VStack>
      : null}

      {data && data.length === 0 ?
        <EmptyState
          icon={<ServerIcon />}
          title="No environments"
          description="Environments will appear here once they are registered."
        />
      : null}

      {data && data.length > 0 ?
        <DataTable data={rows} columns={columns} idKey="id" />
      : null}
    </Page>
  )
}
