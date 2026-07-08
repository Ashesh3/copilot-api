import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Grid } from "@astryxdesign/core/Grid"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"

import type { UsageData, UsageSection } from "../lib/types"

import { EmptyState, fmtRelative } from "../components/common"
import { Page } from "../components/Page"
import { ChartBarIcon } from "../icons"
import { get } from "../lib/api"
import { useAsyncData } from "../lib/usePolling"

function loadUsage(): Promise<UsageData> {
  return get<UsageData>("/dashboard/api/usage")
}

function humanizeKey(key: string): string {
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function progressVariant(utilization: number): "success" | "warning" | "error" {
  if (utilization > 0.9) return "error"
  if (utilization >= 0.7) return "warning"
  return "success"
}

function fmtCountdown(resetsAtSeconds: number): string {
  const diffSec = Math.max(0, resetsAtSeconds - Math.floor(Date.now() / 1000))
  const days = Math.floor(diffSec / 86400)
  const hours = Math.floor((diffSec % 86400) / 3600)
  const minutes = Math.floor((diffSec % 3600) / 60)

  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${minutes}m`
  return `resets in ${minutes}m`
}

interface NumericField {
  key: keyof UsageSection
  label: string
}

const NUMERIC_FIELDS: Array<NumericField> = [
  { key: "tokens_used", label: "Tokens Used" },
  { key: "request_count", label: "Requests" },
  { key: "total_tokens", label: "Total Tokens" },
  { key: "total_input_tokens", label: "Input Tokens" },
  { key: "total_output_tokens", label: "Output Tokens" },
  { key: "total_requests", label: "Total Requests" },
]

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <VStack gap={0.5}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      <Text type="large" weight="semibold">
        {value.toLocaleString()}
      </Text>
    </VStack>
  )
}

function UsageSectionCard({
  name,
  section,
}: {
  name: string
  section: UsageSection
}) {
  const numericFields = NUMERIC_FIELDS.filter(
    ({ key }) => typeof section[key] === "number",
  )

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={3}>{humanizeKey(name)}</Heading>

        {section.utilization !== undefined ?
          <VStack gap={1}>
            <ProgressBar
              label={`${humanizeKey(name)} utilization`}
              value={section.utilization * 100}
              hasValueLabel
              formatValueLabel={(value) => `${value.toFixed(1)}% used`}
              variant={progressVariant(section.utilization)}
            />
            {section.resets_at !== undefined ?
              <Text type="supporting" color="secondary">
                {fmtCountdown(section.resets_at)}
              </Text>
            : null}
          </VStack>
        : null}

        {section.first_request_at != null ?
          <HStack gap={1}>
            <Text type="supporting" color="secondary">
              First request:
            </Text>
            <Text type="supporting" color="secondary">
              {fmtRelative(section.first_request_at * 1000)}
            </Text>
          </HStack>
        : null}

        {numericFields.length > 0 ?
          <Grid columns={{ minWidth: 120 }} gap={3}>
            {numericFields.map(({ key, label }) => (
              <MiniStat
                key={key}
                label={label}
                value={section[key] as number}
              />
            ))}
          </Grid>
        : null}
      </VStack>
    </Card>
  )
}

export default function UsageScreen() {
  const { data, error, loading, reload } = useAsyncData(loadUsage, [])

  const sectionEntries = data ? Object.entries(data) : []

  return (
    <Page
      kicker="Monitor"
      title="Usage"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load usage"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <Grid columns={{ minWidth: 320 }} gap={4}>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={160} index={index} />
          ))}
        </Grid>
      : null}

      {data && sectionEntries.length === 0 ?
        <EmptyState
          icon={<ChartBarIcon />}
          title="No usage data"
          description="Usage sections will appear here once requests start flowing."
        />
      : null}

      {sectionEntries.length > 0 ?
        <Grid columns={{ minWidth: 320 }} gap={4}>
          {sectionEntries.map(([name, section]) => (
            <UsageSectionCard key={name} name={name} section={section} />
          ))}
        </Grid>
      : null}
    </Page>
  )
}
