import type { SelectorOptionType } from "@astryxdesign/core/Selector"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Divider } from "@astryxdesign/core/Divider"
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import type { IpAllowlistEntry, SettingsData } from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  MonoText,
  RelTime,
  TogglePill,
} from "../components/common"
import { Page } from "../components/Page"
import { ResponsivePair } from "../components/ResponsivePair"
import { DownloadIcon, PlusIcon, Trash2Icon } from "../icons"
import { ApiError, api, del, get, patch, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

type IpRow = IpAllowlistEntry & Record<string, unknown>

interface SettingsBundle {
  settings: SettingsData
  allowlist: Array<IpAllowlistEntry>
}

function loadBundle(): Promise<SettingsBundle> {
  return Promise.all([
    get<SettingsData>("/dashboard/api/settings"),
    get<Array<IpAllowlistEntry>>("/dashboard/api/ip-allowlist"),
  ]).then(([settings, allowlist]) => ({ settings, allowlist }))
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback
}

function boolBadge(value: boolean, trueLabel = "Yes", falseLabel = "No") {
  return (
    <Badge
      variant={value ? "success" : "neutral"}
      label={value ? trueLabel : falseLabel}
    />
  )
}

export default function SettingsScreen() {
  const { data, error, loading, reload } = useAsyncData(loadBundle, [])
  const toast = useToast()

  const [cleanupDraft, setCleanupDraft] = useState<string>()
  const [isSavingCleanup, setIsSavingCleanup] = useState(false)
  const [newIp, setNewIp] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  const cleanupValue = cleanupDraft ?? data?.settings.codexCleanupModel ?? ""

  const handleExport = async () => {
    try {
      const response = await fetch("/dashboard/api/settings/export", {
        credentials: "same-origin",
      })
      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`)
      }
      const blob = await response.blob()
      const disposition = response.headers.get("content-disposition") ?? ""
      const match = /filename="?([^";]+)"?/.exec(disposition)
      const filename = match?.[1] ?? "copilot-api-config.zip"
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
      toast.success("Config exported")
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to export config",
      )
    }
  }

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match")
      return
    }
    setIsChangingPassword(true)
    try {
      await api("PUT", "/dashboard/auth/password", {
        currentPassword,
        newPassword,
      })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      toast.success("Administrator password changed; other sessions revoked")
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to change password"))
    } finally {
      setIsChangingPassword(false)
    }
  }

  const handleSaveCleanup = async () => {
    setIsSavingCleanup(true)
    try {
      await post("/dashboard/api/settings/codex-cleanup-model", {
        model: cleanupValue || null,
      })
      toast.success("Codex cleanup model updated")
      setCleanupDraft(undefined)
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update cleanup model"))
    } finally {
      setIsSavingCleanup(false)
    }
  }

  const handleAddIp = async () => {
    if (!newIp.trim()) {
      toast.error("IP address is required")
      return
    }
    try {
      await post("/dashboard/api/ip-allowlist", {
        ip: newIp.trim(),
        enabled: true,
      })
      toast.success("IP added")
      setNewIp("")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to add IP"))
    }
  }

  const handleToggleIp = async (ip: string, enabled: boolean) => {
    try {
      await patch(`/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`, {
        enabled,
      })
      toast.success(enabled ? "IP enabled" : "IP disabled")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update IP"))
    }
  }

  const handleRemoveIp = async (ip: string) => {
    try {
      await del(`/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`)
      toast.success("IP removed")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to remove IP"))
    }
  }

  const cleanupOptions: Array<SelectorOptionType> =
    data ?
      [
        {
          value: "",
          label: `Use default (${data.settings.codexCleanupModelDefault ?? "none"})`,
        },
        ...data.settings.availableModels.map((model) => ({
          value: model,
          label: model,
        })),
        ...((
          data.settings.codexCleanupModel
          && !data.settings.availableModels.includes(
            data.settings.codexCleanupModel,
          )
        ) ?
          [
            {
              value: data.settings.codexCleanupModel,
              label: data.settings.codexCleanupModel,
            },
          ]
        : []),
      ]
    : []

  const ipColumns: Array<TableColumn<IpRow>> = [
    {
      key: "ip",
      header: "IP",
      width: proportional(2),
      renderCell: (item) => <MonoText>{item.ip}</MonoText>,
    },
    {
      key: "enabled",
      header: "Enabled",
      width: pixel(72),
      renderCell: (item) => (
        <TogglePill
          label={`Toggle ${item.ip}`}
          value={item.enabled}
          onChange={(next) => handleToggleIp(item.ip, next)}
        />
      ),
    },
    {
      key: "source",
      header: "Source",
      width: pixel(120),
      renderCell: (item) => <Text type="supporting">{item.source}</Text>,
    },
    {
      key: "lastSeen",
      header: "Last Seen",
      width: pixel(140),
      renderCell: (item) =>
        item.lastSeenAt ?
          <RelTime ts={item.lastSeenAt} />
        : <Text type="supporting">—</Text>,
    },
    {
      key: "actions",
      header: "",
      width: pixel(56),
      align: "end",
      renderCell: (item) => (
        <ConfirmButton
          label="Remove"
          isIconOnly
          icon={<Trash2Icon />}
          size="sm"
          confirmTitle="Remove IP"
          confirmDescription={`Remove "${item.ip}" from the allowlist?`}
          onConfirm={() => handleRemoveIp(item.ip)}
        />
      ),
    },
  ]

  return (
    <Page
      kicker="System"
      title="Settings"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load settings"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <Skeleton height={480} />
      : null}

      {data ?
        <ResponsivePair minWidth={540}>
          <Card>
            <VStack gap={4}>
              <Heading level={3}>Server Configuration</Heading>
              <MetadataList columns={2}>
                <MetadataListItem label="Version">
                  {data.settings.version}
                </MetadataListItem>
                <MetadataListItem label="Port">
                  {data.settings.port}
                </MetadataListItem>
                <MetadataListItem label="Host">
                  {data.settings.host}
                </MetadataListItem>
                <MetadataListItem label="API Key Configured">
                  {boolBadge(data.settings.authEnabled)}
                </MetadataListItem>
                <MetadataListItem label="Multi-Token Mode">
                  {boolBadge(data.settings.multiToken)}
                </MetadataListItem>
                <MetadataListItem label="Sentry Enabled">
                  {boolBadge(data.settings.sentryEnabled)}
                </MetadataListItem>
                <MetadataListItem label="Groq Enabled">
                  {boolBadge(data.settings.groqEnabled)}
                </MetadataListItem>
                <MetadataListItem label="Data Directory">
                  <MonoText>{data.settings.dataDir}</MonoText>
                </MetadataListItem>
                <MetadataListItem label="Debug Mode">
                  {boolBadge(data.settings.debug)}
                </MetadataListItem>
                <MetadataListItem label="Verbose Logging">
                  {boolBadge(data.settings.verbose)}
                </MetadataListItem>
              </MetadataList>

              <Divider />

              <VStack gap={4}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Heading level={4}>Codex Dictation Cleanup</Heading>
                  <Badge variant="neutral" label="Used by /codex/responses" />
                </HStack>
                <Selector
                  label="Cleanup model"
                  options={cleanupOptions}
                  value={cleanupValue}
                  onChange={setCleanupDraft}
                />
                <HStack hAlign="end">
                  <Button
                    label="Save"
                    variant="primary"
                    isLoading={isSavingCleanup}
                    onClick={handleSaveCleanup}
                  />
                </HStack>
              </VStack>
            </VStack>
          </Card>

          <Card>
            <VStack gap={4}>
              <Heading level={3}>Administrator Security</Heading>
              <Button
                label="Export sanitized config"
                variant="secondary"
                icon={<DownloadIcon />}
                onClick={() => void handleExport()}
              />
              <TextInput
                type="password"
                label="Current admin password"
                value={currentPassword}
                onChange={setCurrentPassword}
              />
              <TextInput
                type="password"
                label="New admin password"
                value={newPassword}
                onChange={setNewPassword}
              />
              <TextInput
                type="password"
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
              <Button
                label="Change administrator password"
                variant="primary"
                isLoading={isChangingPassword}
                isDisabled={
                  !currentPassword || !newPassword || !confirmPassword
                }
                onClick={() => void handleChangePassword()}
              />
            </VStack>
          </Card>

          <Card>
            <VStack gap={4}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Heading level={3}>IP Allowlist</Heading>
                <Badge variant="neutral" label="Used by /transcribe" />
              </HStack>
              <HStack gap={2} vAlign="end" wrap="wrap">
                <TextInput
                  label="IP address"
                  value={newIp}
                  onChange={setNewIp}
                  placeholder="203.0.113.10"
                  width="min(100%, 320px)"
                />
                <Button
                  label="Add"
                  variant="secondary"
                  icon={<PlusIcon />}
                  onClick={handleAddIp}
                />
              </HStack>
              {data.allowlist.length === 0 ?
                <EmptyState
                  title="No allowlisted IPs"
                  description="Detect your public IP or add one manually."
                />
              : <DataTable
                  data={data.allowlist as Array<IpRow>}
                  columns={ipColumns}
                  idKey="ip"
                />
              }
            </VStack>
          </Card>
        </ResponsivePair>
      : null}
    </Page>
  )
}
