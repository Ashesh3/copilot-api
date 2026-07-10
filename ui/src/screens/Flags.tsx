/* eslint-disable max-lines */
import type { SelectorOptionType } from "@astryxdesign/core/Selector"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Heading } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import type {
  FlagApplication,
  FlagsMap,
  FlagValue,
  StatsigDynamicConfig,
  StatsigOverrideKind,
  StatsigOverrides,
} from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  MonoText,
  TogglePill,
} from "../components/common"
import { Page } from "../components/Page"
import { FlagIcon, PencilIcon, PlusIcon, Trash2Icon } from "../icons"
import { del, get, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

const APPLICATION_OPTIONS: Array<SelectorOptionType> = [
  { value: "claudeCode", label: "Claude Code" },
  { value: "chatgptCodex", label: "ChatGPT / Codex" },
]

const STATSIG_KIND_OPTIONS: Array<SelectorOptionType> = [
  { value: "featureGate", label: "Feature gate" },
  { value: "dynamicConfig", label: "Dynamic config" },
]

const BASE_SETUP_DESCRIPTION =
  "Add these entries on the client machine and use a TLS certificate trusted by that client."
const CHATGPT_SETUP_DESCRIPTION = `${BASE_SETUP_DESCRIPTION} Nginx must serve ab.chatgpt.com and preserve Host: ab.chatgpt.com; certificate SAN must include it; copilot-api server must resolve it to real upstream.`
const CLAUDE_SETUP_CODE = [
  "<server-ip> api.anthropic.com",
  "<server-ip> claude.ai",
  "<server-ip> platform.claude.com",
].join("\n")
const CHATGPT_SETUP_CODE = "<server-ip> ab.chatgpt.com"

type FlagValueType = "boolean" | "string" | "number"

interface ClaudeFlagRow extends Record<string, unknown> {
  id: string
  kind: "claudeFlag"
  name: string
  value: FlagValue
}

interface StatsigFeatureGateRow extends Record<string, unknown> {
  id: string
  kind: "featureGate"
  name: string
  value: boolean
}

interface StatsigDynamicConfigRow extends Record<string, unknown> {
  id: string
  kind: "dynamicConfig"
  name: string
  value: StatsigDynamicConfig
}

type FlagDialogState =
  | {
      application: "claudeCode"
      mode: "add" | "edit"
      kind: "claudeFlag"
      name: string
      value: FlagValue
    }
  | {
      application: "chatgptCodex"
      mode: "add" | "edit"
      kind: "featureGate"
      name: string
      value: boolean
    }
  | {
      application: "chatgptCodex"
      mode: "add" | "edit"
      kind: "dynamicConfig"
      name: string
      value: StatsigDynamicConfig
    }

type FlagDialogSubmission =
  | {
      kind: "claudeFlag"
      name: string
      value: FlagValue
    }
  | {
      kind: "featureGate"
      name: string
      value: boolean
    }
  | {
      kind: "dynamicConfig"
      name: string
      value: StatsigDynamicConfig
    }

type FlagScreenData =
  | {
      application: "claudeCode"
      flags: FlagsMap
    }
  | {
      application: "chatgptCodex"
      overrides: StatsigOverrides
    }

class FlagScreenLoadError extends Error {
  application: FlagApplication

  constructor(application: FlagApplication, message: string) {
    super(message)
    this.name = "FlagScreenLoadError"
    this.application = application
  }
}

function loadFlags(): Promise<FlagsMap> {
  return get<FlagsMap>("/dashboard/api/flags")
}

function loadStatsigOverrides(): Promise<StatsigOverrides> {
  return get<StatsigOverrides>("/dashboard/api/statsig-overrides")
}

async function loadFlagScreenData(
  application: FlagApplication,
): Promise<FlagScreenData> {
  try {
    if (application === "claudeCode") {
      return {
        application,
        flags: await loadFlags(),
      }
    }

    return {
      application,
      overrides: await loadStatsigOverrides(),
    }
  } catch (caught) {
    throw new FlagScreenLoadError(
      application,
      errorMessage(
        caught,
        application === "claudeCode" ?
          "Failed to load flags"
        : "Failed to load overrides",
      ),
    )
  }
}

function valueType(value: FlagValue): FlagValueType {
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return "number"
  return "string"
}

function valueToText(value: FlagValue): string {
  if (typeof value === "boolean") return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function displayValue(value: FlagValue | StatsigDynamicConfig): string {
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function prettyDynamicConfig(value: StatsigDynamicConfig): string {
  return JSON.stringify(value, null, 2)
}

function kindLabel(kind: StatsigOverrideKind): string {
  return kind === "featureGate" ? "Feature gate" : "Dynamic config"
}

function parseDynamicConfig(value: string):
  | {
      ok: true
      value: StatsigDynamicConfig
    }
  | {
      ok: false
      error: string
    } {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return { ok: false, error: "Dynamic config must be a JSON object" }
    }
    return {
      ok: true,
      value: parsed as StatsigDynamicConfig,
    }
  } catch {
    return { ok: false, error: "Enter valid JSON" }
  }
}

function buildClaudeRows(flags: FlagsMap): Array<ClaudeFlagRow> {
  return Object.entries(flags)
    .map(([name, value]) => ({
      id: `claudeFlag:${name}`,
      kind: "claudeFlag" as const,
      name,
      value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function buildStatsigFeatureGateRows(
  featureGates: StatsigOverrides["featureGates"],
): Array<StatsigFeatureGateRow> {
  return Object.entries(featureGates)
    .map(([name, value]) => ({
      id: `featureGate:${name}`,
      kind: "featureGate" as const,
      name,
      value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function buildStatsigDynamicConfigRows(
  dynamicConfigs: StatsigOverrides["dynamicConfigs"],
): Array<StatsigDynamicConfigRow> {
  return Object.entries(dynamicConfigs)
    .map(([name, value]) => ({
      id: `dynamicConfig:${name}`,
      kind: "dynamicConfig" as const,
      name,
      value,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function setupBannerTitle(application: FlagApplication): string {
  return application === "claudeCode" ?
      "Redirect Claude Code feature traffic"
    : "Redirect Codex Statsig traffic"
}

function setupBannerDescription(application: FlagApplication): string {
  return application === "claudeCode" ?
      BASE_SETUP_DESCRIPTION
    : CHATGPT_SETUP_DESCRIPTION
}

function setupBannerCode(application: FlagApplication): string {
  return application === "claudeCode" ? CLAUDE_SETUP_CODE : CHATGPT_SETUP_CODE
}

function dialogTextValue(
  application: FlagApplication,
  kind: FlagDialogState["kind"],
  value: FlagDialogState["value"],
): string {
  if (application === "claudeCode") {
    return valueToText(value as FlagValue)
  }

  if (kind === "dynamicConfig") {
    return prettyDynamicConfig(value as StatsigDynamicConfig)
  }

  return ""
}

function dialogTitle(
  application: FlagApplication,
  mode: "add" | "edit",
  initialName: string,
): string {
  if (mode === "edit") return `Edit "${initialName}"`
  return application === "claudeCode" ? "Add Flag" : "Add Override"
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback
}

function readSetupDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true"
  } catch {
    return false
  }
}

interface FlagFormDialogProps {
  application: FlagApplication
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  mode: "add" | "edit"
  initialKind: FlagDialogState["kind"]
  initialName: string
  initialValue: FlagDialogState["value"]
  onSubmit: (submission: FlagDialogSubmission) => Promise<void>
}

function FlagFormDialog({
  application,
  isOpen,
  onOpenChange,
  mode,
  initialKind,
  initialName,
  initialValue,
  onSubmit,
}: FlagFormDialogProps) {
  const isClaude = application === "claudeCode"
  const [name, setName] = useState(initialName)
  const [kind, setKind] = useState<FlagDialogState["kind"]>(initialKind)
  const [type, setType] = useState<FlagValueType>(() =>
    isClaude ? valueType(initialValue as FlagValue) : "boolean",
  )
  const [boolValue, setBoolValue] = useState(() =>
    initialKind === "dynamicConfig" ? false : initialValue === true,
  )
  const [textValue, setTextValue] = useState(() =>
    dialogTextValue(application, initialKind, initialValue),
  )
  const [isSaving, setIsSaving] = useState(false)

  const trimmedName = name.trim()
  const isNumberValid =
    type !== "number"
    || (textValue.trim() !== "" && !Number.isNaN(Number(textValue)))
  const dynamicConfigValidation =
    !isClaude && kind === "dynamicConfig" ? parseDynamicConfig(textValue) : null
  const canSubmit =
    trimmedName.length > 0
    && (isClaude ? isNumberValid : (
      kind === "featureGate" || dynamicConfigValidation?.ok === true
    ))

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSaving(true)
    try {
      if (isClaude) {
        let value: FlagValue = textValue
        if (type === "boolean") value = boolValue
        else if (type === "number") value = Number(textValue)

        await onSubmit({
          kind: "claudeFlag",
          name: trimmedName,
          value,
        })
      } else if (kind === "featureGate") {
        await onSubmit({
          kind,
          name: trimmedName,
          value: boolValue,
        })
      } else if (dynamicConfigValidation?.ok) {
        await onSubmit({
          kind,
          name: trimmedName,
          value: dynamicConfigValidation.value,
        })
      }

      onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  function handleKindChange(nextKind: string) {
    const resolvedKind = nextKind as StatsigOverrideKind
    setKind(resolvedKind)
    if (resolvedKind === "dynamicConfig" && textValue.trim().length === 0) {
      setTextValue("{}")
    }
  }

  const kindField =
    isClaude ?
      <Selector
        label="Type"
        value={type}
        onChange={(next) => setType(next as FlagValueType)}
        options={["boolean", "string", "number"]}
      />
    : <Selector
        label="Kind"
        value={kind}
        onChange={handleKindChange}
        options={STATSIG_KIND_OPTIONS}
        isDisabled={mode === "edit"}
      />

  const valueField = (() => {
    if (isClaude) {
      return type === "boolean" ?
          <Switch label="Value" value={boolValue} onChange={setBoolValue} />
        : <TextInput
            label="Value"
            value={textValue}
            onChange={setTextValue}
            placeholder={type === "number" ? "0" : "value"}
            status={
              type === "number" && !isNumberValid ?
                { type: "error", message: "Enter a valid number" }
              : undefined
            }
          />
    }

    if (kind === "featureGate") {
      return <Switch label="Value" value={boolValue} onChange={setBoolValue} />
    }

    return (
      <TextArea
        label="Value"
        value={textValue}
        onChange={setTextValue}
        rows={12}
        hasSpellCheck={false}
        status={
          dynamicConfigValidation && !dynamicConfigValidation.ok ?
            { type: "error", message: dynamicConfigValidation.error }
          : undefined
        }
      />
    )
  })()

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={application === "claudeCode" ? 420 : 560}
    >
      <Layout
        header={
          <DialogHeader
            title={dialogTitle(application, mode, initialName)}
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Name"
                value={name}
                onChange={setName}
                isDisabled={mode === "edit"}
                isRequired
                placeholder={
                  application === "claudeCode" ? "my-flag" : "my-override"
                }
              />
              {kindField}
              {valueField}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                label="Cancel"
                variant="secondary"
                onClick={() => onOpenChange(false)}
              />
              <Button
                label="Save"
                onClick={handleSubmit}
                isLoading={isSaving}
                isDisabled={!canSubmit}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

export default function FlagsScreen() {
  const toast = useToast()
  const [application, setApplication] = useState<FlagApplication>("claudeCode")
  const [dismissedSetupBanners, setDismissedSetupBanners] = useState<
    Record<string, boolean>
  >({})
  const { data, error, loading, reload } = useAsyncData(
    () => loadFlagScreenData(application),
    [application],
  )

  const [dialogState, setDialogState] = useState<FlagDialogState | null>(null)
  const setupDismissedKey = `feature-flags-setup-dismissed:${application}`
  const isSetupDismissed =
    dismissedSetupBanners[setupDismissedKey]
    ?? readSetupDismissed(setupDismissedKey)
  const activeData = data?.application === application ? data : undefined
  const activeError =
    error instanceof FlagScreenLoadError && error.application !== application ?
      undefined
    : error

  const claudeRows =
    activeData?.application === "claudeCode" ?
      buildClaudeRows(activeData.flags)
    : []
  const featureGateRows =
    activeData?.application === "chatgptCodex" ?
      buildStatsigFeatureGateRows(activeData.overrides.featureGates)
    : []
  const dynamicConfigRows =
    activeData?.application === "chatgptCodex" ?
      buildStatsigDynamicConfigRows(activeData.overrides.dynamicConfigs)
    : []

  async function handleClaudeToggle(name: string, next: boolean) {
    try {
      await post("/dashboard/api/flags", { name, value: next })
      toast.success(`Updated flag "${name}"`)
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update flag"))
    }
  }

  async function handleStatsigFeatureGateToggle(name: string, next: boolean) {
    try {
      await post("/dashboard/api/statsig-overrides", {
        kind: "featureGate",
        name,
        value: next,
      })
      toast.success(`Updated feature gate "${name}"`)
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update feature gate"))
    }
  }

  async function handleDelete(
    kind: FlagDialogState["kind"],
    name: string,
  ): Promise<void> {
    try {
      if (kind === "claudeFlag") {
        await del("/dashboard/api/flags", { name })
        toast.success(`Deleted flag "${name}"`)
      } else {
        await del("/dashboard/api/statsig-overrides", { kind, name })
        toast.success(`Deleted ${kindLabel(kind).toLowerCase()} "${name}"`)
      }
      reload()
    } catch (caught) {
      toast.error(
        errorMessage(
          caught,
          kind === "claudeFlag" ?
            "Failed to delete flag"
          : "Failed to delete override",
        ),
      )
    }
  }

  async function handleSubmit(submission: FlagDialogSubmission): Promise<void> {
    try {
      if (submission.kind === "claudeFlag") {
        await post("/dashboard/api/flags", {
          name: submission.name,
          value: submission.value,
        })
        toast.success(`Saved flag "${submission.name}"`)
      } else {
        await post("/dashboard/api/statsig-overrides", submission)
        toast.success(
          `Saved ${kindLabel(submission.kind).toLowerCase()} "${submission.name}"`,
        )
      }
      reload()
    } catch (caught) {
      toast.error(
        errorMessage(
          caught,
          submission.kind === "claudeFlag" ?
            "Failed to save flag"
          : "Failed to save override",
        ),
      )
      throw caught
    }
  }

  function dismissSetupBanner() {
    setDismissedSetupBanners((current) => ({
      ...current,
      [setupDismissedKey]: true,
    }))
    try {
      localStorage.setItem(setupDismissedKey, "true")
    } catch {
      // ignore localStorage access errors
    }
  }

  const claudeColumns: Array<TableColumn<ClaudeFlagRow>> = [
    {
      key: "name",
      header: "Flag",
      width: proportional(2),
      renderCell: (row) => <MonoText>{row.name}</MonoText>,
    },
    {
      key: "value",
      header: "Value",
      width: proportional(2),
      renderCell: (row) =>
        typeof row.value === "boolean" ?
          <TogglePill
            label={`Toggle ${row.name}`}
            value={row.value}
            onChange={(next) => handleClaudeToggle(row.name, next)}
          />
        : <MonoText>{displayValue(row.value)}</MonoText>,
    },
    {
      key: "actions",
      header: "",
      width: pixel(88),
      align: "end",
      renderCell: (row) => (
        <HStack gap={0.5} hAlign="end" vAlign="center">
          {typeof row.value !== "boolean" ?
            <Button
              label="Edit"
              variant="ghost"
              size="sm"
              icon={<PencilIcon />}
              isIconOnly
              onClick={() =>
                setDialogState({
                  application: "claudeCode",
                  mode: "edit",
                  kind: "claudeFlag",
                  name: row.name,
                  value: row.value,
                })
              }
            />
          : null}
          <ConfirmButton
            label="Delete"
            confirmTitle={`Delete flag "${row.name}"?`}
            confirmDescription="This removes the flag entirely. This action cannot be undone."
            icon={<Trash2Icon />}
            isIconOnly
            size="sm"
            onConfirm={() => handleDelete(row.kind, row.name)}
          />
        </HStack>
      ),
    },
  ]

  const featureGateColumns: Array<TableColumn<StatsigFeatureGateRow>> = [
    {
      key: "name",
      header: "Feature gate",
      width: proportional(2),
      renderCell: (row) => <MonoText>{row.name}</MonoText>,
    },
    {
      key: "value",
      header: "Value",
      width: proportional(2),
      renderCell: (row) => (
        <TogglePill
          label={`Toggle ${row.name}`}
          value={row.value}
          onChange={(next) => handleStatsigFeatureGateToggle(row.name, next)}
        />
      ),
    },
    {
      key: "actions",
      header: "",
      width: pixel(48),
      align: "end",
      renderCell: (row) => (
        <ConfirmButton
          label="Delete feature gate"
          confirmTitle={`Delete feature gate "${row.name}"?`}
          confirmDescription="This removes the feature gate override entirely. This action cannot be undone."
          icon={<Trash2Icon />}
          isIconOnly
          size="sm"
          onConfirm={() => handleDelete(row.kind, row.name)}
        />
      ),
    },
  ]

  const dynamicConfigColumns: Array<TableColumn<StatsigDynamicConfigRow>> = [
    {
      key: "name",
      header: "Dynamic config",
      width: proportional(2),
      renderCell: (row) => <MonoText>{row.name}</MonoText>,
    },
    {
      key: "value",
      header: "Value",
      width: proportional(2),
      renderCell: (row) => <MonoText>{displayValue(row.value)}</MonoText>,
    },
    {
      key: "actions",
      header: "",
      width: pixel(88),
      align: "end",
      renderCell: (row) => (
        <HStack gap={0.5} hAlign="end" vAlign="center">
          <Button
            label="Edit dynamic config"
            variant="ghost"
            size="sm"
            icon={<PencilIcon />}
            isIconOnly
            onClick={() =>
              setDialogState({
                application: "chatgptCodex",
                mode: "edit",
                kind: "dynamicConfig",
                name: row.name,
                value: row.value,
              })
            }
          />
          <ConfirmButton
            label="Delete dynamic config"
            confirmTitle={`Delete dynamic config "${row.name}"?`}
            confirmDescription="This removes the dynamic config override entirely. This action cannot be undone."
            icon={<Trash2Icon />}
            isIconOnly
            size="sm"
            onConfirm={() => handleDelete(row.kind, row.name)}
          />
        </HStack>
      ),
    },
  ]

  return (
    <Page
      kicker="Control"
      title="Feature Flags"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <HStack gap={2} vAlign="end">
          <Selector
            label="Application"
            size="sm"
            value={application}
            onChange={(next) => {
              setDialogState(null)
              setApplication(next as FlagApplication)
            }}
            options={APPLICATION_OPTIONS}
          />
          <Button
            label={application === "claudeCode" ? "Add Flag" : "Add Override"}
            icon={<PlusIcon />}
            onClick={() =>
              setDialogState(
                application === "claudeCode" ?
                  {
                    application,
                    mode: "add",
                    kind: "claudeFlag",
                    name: "",
                    value: true,
                  }
                : {
                    application,
                    mode: "add",
                    kind: "featureGate",
                    name: "",
                    value: true,
                  },
              )
            }
          />
        </HStack>
      }
    >
      {!isSetupDismissed ?
        <Banner
          status="info"
          title={setupBannerTitle(application)}
          description={setupBannerDescription(application)}
          isDismissable
          onDismiss={dismissSetupBanner}
          defaultIsExpanded
        >
          <CodeBlock
            code={setupBannerCode(application)}
            language="plaintext"
            container="section"
            onCopy={() => toast.success("Copied")}
          />
        </Banner>
      : null}

      {activeError ?
        <Banner
          status="error"
          title={
            application === "claudeCode" ?
              "Failed to load flags"
            : "Failed to load overrides"
          }
          description={activeError.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!activeData && loading ?
        <Skeleton height={240} />
      : null}

      {activeData?.application === "claudeCode" && claudeRows.length === 0 ?
        <EmptyState
          icon={<FlagIcon />}
          title="No feature flags"
          description="Add a flag to get started."
        />
      : null}

      {activeData?.application === "claudeCode" && claudeRows.length > 0 ?
        <Card padding={0}>
          <DataTable data={claudeRows} columns={claudeColumns} idKey="id" />
        </Card>
      : null}

      {activeData?.application === "chatgptCodex" ?
        <VStack gap={4}>
          <VStack gap={2}>
            <Heading level={3}>Feature gates</Heading>
            {featureGateRows.length === 0 ?
              <EmptyState
                icon={<FlagIcon />}
                title="No feature gates"
                description="Add a feature gate override to get started."
              />
            : <Card padding={0}>
                <DataTable
                  data={featureGateRows}
                  columns={featureGateColumns}
                  idKey="id"
                />
              </Card>
            }
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>Dynamic configs</Heading>
            {dynamicConfigRows.length === 0 ?
              <EmptyState
                icon={<FlagIcon />}
                title="No dynamic configs"
                description="Add a dynamic config override to get started."
              />
            : <Card padding={0}>
                <DataTable
                  data={dynamicConfigRows}
                  columns={dynamicConfigColumns}
                  idKey="id"
                />
              </Card>
            }
          </VStack>
        </VStack>
      : null}

      {dialogState && dialogState.application === application ?
        <FlagFormDialog
          key={`${dialogState.application}:${dialogState.kind}:${dialogState.mode}:${dialogState.name}`}
          application={dialogState.application}
          isOpen
          onOpenChange={(isOpen) => {
            if (!isOpen) setDialogState(null)
          }}
          mode={dialogState.mode}
          initialKind={dialogState.kind}
          initialName={dialogState.name}
          initialValue={dialogState.value}
          onSubmit={handleSubmit}
        />
      : null}
    </Page>
  )
}
