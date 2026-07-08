import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Grid } from "@astryxdesign/core/Grid"
import { Skeleton } from "@astryxdesign/core/Skeleton"

import type { Overview } from "../lib/types"

import { StatCard } from "../components/common"
import { Page } from "../components/Page"
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  FlagIcon,
  MonitorIcon,
  RadioTowerIcon,
} from "../icons"
import { get } from "../lib/api"
import { useAsyncData, usePolling } from "../lib/usePolling"

const POLL_INTERVAL_MS = 30_000

function loadOverview(): Promise<Overview> {
  return get<Overview>("/dashboard/api/overview")
}

export default function OverviewScreen() {
  const { data, error, loading, reload } = useAsyncData(loadOverview, [])

  usePolling(() => reload(), POLL_INTERVAL_MS, [])

  return (
    <Page
      kicker="Monitor"
      title="Overview"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load overview"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <Grid columns={{ minWidth: 240 }} gap={4}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={88} index={index} />
          ))}
        </Grid>
      : null}

      {data ?
        <Grid columns={{ minWidth: 240 }} gap={4}>
          <StatCard
            icon={ActivityIcon}
            label="Active Sessions"
            value={data.activeSessions}
            tone="success"
          />
          <StatCard
            icon={RadioTowerIcon}
            label="Direct Connect"
            value={data.directConnectCount}
            tone="accent"
          />
          <StatCard
            icon={MonitorIcon}
            label="Environments"
            value={data.environmentsCount}
          />
          <StatCard
            icon={FlagIcon}
            label="Feature Flags"
            value={data.flagsCount}
          />
          <StatCard
            icon={ClockIcon}
            label="Server Uptime"
            value={data.uptime}
          />
          {data.health === "ok" ?
            <StatCard
              icon={CheckIcon}
              label="Health"
              value="OK"
              tone="success"
            />
          : <StatCard
              icon={AlertTriangleIcon}
              label="Health"
              value={data.health}
              tone="error"
            />
          }
        </Grid>
      : null}
    </Page>
  )
}
