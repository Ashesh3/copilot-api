import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { IconButton } from "@astryxdesign/core/IconButton"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import type {
  CustomProvider,
  CustomProviderModel,
  CustomProviderModelKind,
} from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  IconAction,
  MonoText,
  RowActions,
} from "../components/common"
import { Page } from "../components/Page"
import {
  KeyRoundIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  Trash2Icon,
} from "../icons"
import { ApiError, del, get, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

type ProviderRow = CustomProvider & Record<string, unknown>

type AuthMode = "key" | "env"

interface HeaderRow {
  rowId: string
  key: string
  value: string
}

interface ModelFormRow {
  rowId: string
  modelId: string
  kind: CustomProviderModelKind
  aliases: string
  dimensions: string
  supportsStreaming: boolean
  passReasoningEffort: boolean
}

interface ProviderFormState {
  id: string
  name: string
  baseUrl: string
  authMode: AuthMode
  apiKey: string
  apiKeyEnv: string
  headers: Array<HeaderRow>
  timeoutMs: string
  passReasoningEffort: boolean
  models: Array<ModelFormRow>
}

const KIND_OPTIONS = [
  { value: "chat", label: "Chat" },
  { value: "embedding", label: "Embedding" },
]

let rowIdCounter = 0
function makeRowId(): string {
  rowIdCounter += 1
  return `row-${rowIdCounter}`
}

function emptyModelRow(): ModelFormRow {
  return {
    rowId: makeRowId(),
    modelId: "",
    kind: "chat",
    aliases: "",
    dimensions: "",
    supportsStreaming: false,
    passReasoningEffort: false,
  }
}

function emptyForm(): ProviderFormState {
  return {
    id: "",
    name: "",
    baseUrl: "",
    authMode: "key",
    apiKey: "",
    apiKeyEnv: "",
    headers: [],
    timeoutMs: "",
    passReasoningEffort: false,
    models: [emptyModelRow()],
  }
}

function modelToFormRow(model: CustomProviderModel): ModelFormRow {
  return {
    rowId: makeRowId(),
    modelId: model.id,
    kind: model.kind,
    aliases: model.aliases?.join(", ") ?? "",
    dimensions: model.dimensions != null ? String(model.dimensions) : "",
    supportsStreaming: model.supportsStreaming ?? false,
    passReasoningEffort: model.passReasoningEffort ?? false,
  }
}

function formFromProvider(provider: CustomProvider): ProviderFormState {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    authMode: provider.apiKeyEnv ? "env" : "key",
    apiKey: provider.apiKey ?? "",
    apiKeyEnv: provider.apiKeyEnv ?? "",
    headers: Object.entries(provider.headers ?? {}).map(([key, value]) => ({
      rowId: makeRowId(),
      key,
      value,
    })),
    timeoutMs: provider.timeoutMs != null ? String(provider.timeoutMs) : "",
    passReasoningEffort: provider.passReasoningEffort ?? false,
    models:
      provider.models.length > 0 ?
        provider.models.map((model) => modelToFormRow(model))
      : [emptyModelRow()],
  }
}

function loadProviders(): Promise<Array<CustomProvider>> {
  return get<Array<CustomProvider>>("/dashboard/api/custom-providers")
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback
}

function authIndicator(provider: CustomProvider) {
  if (provider.apiKeyEnv) return <Badge variant="info" label="Env" />
  if (provider.apiKey) return <Badge variant="neutral" label="Stored" />
  return <Badge variant="error" label="Missing" />
}

function modelBadges(models: Array<CustomProviderModel>) {
  if (models.length === 0) return <Text color="secondary">—</Text>
  return (
    <HStack gap={1.5} wrap="wrap">
      {models.map((model) => (
        <HStack key={model.id} gap={0.5} vAlign="center">
          <MonoText>{model.id}</MonoText>
          <Badge
            variant={model.kind === "embedding" ? "info" : "neutral"}
            label={model.kind}
          />
        </HStack>
      ))}
    </HStack>
  )
}

export default function CustomProvidersScreen() {
  const { data, error, loading, reload } = useAsyncData(loadProviders, [])
  const toast = useToast()

  const [isFormOpen, setIsFormOpen] = useState(false)
  const [form, setForm] = useState<ProviderFormState>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const [isNebiusOpen, setIsNebiusOpen] = useState(false)
  const [nebiusApiKey, setNebiusApiKey] = useState("")
  const [isNebiusSaving, setIsNebiusSaving] = useState(false)

  function openCreate() {
    setForm(emptyForm())
    setEditingId(null)
    setIsFormOpen(true)
  }

  function openEdit(provider: CustomProvider) {
    setForm(formFromProvider(provider))
    setEditingId(provider.id)
    setIsFormOpen(true)
  }

  function closeForm() {
    setIsFormOpen(false)
  }

  function updateModelRow(rowId: string, patch: Partial<ModelFormRow>) {
    setForm((f) => ({
      ...f,
      models: f.models.map((row) =>
        row.rowId === rowId ? { ...row, ...patch } : row,
      ),
    }))
  }

  function addModelRow() {
    setForm((f) => ({ ...f, models: [...f.models, emptyModelRow()] }))
  }

  function removeModelRow(rowId: string) {
    setForm((f) => ({
      ...f,
      models: f.models.filter((row) => row.rowId !== rowId),
    }))
  }

  function updateHeaderRow(rowId: string, patch: Partial<HeaderRow>) {
    setForm((f) => ({
      ...f,
      headers: f.headers.map((row) =>
        row.rowId === rowId ? { ...row, ...patch } : row,
      ),
    }))
  }

  function addHeaderRow() {
    setForm((f) => ({
      ...f,
      headers: [...f.headers, { rowId: makeRowId(), key: "", value: "" }],
    }))
  }

  function removeHeaderRow(rowId: string) {
    setForm((f) => ({
      ...f,
      headers: f.headers.filter((row) => row.rowId !== rowId),
    }))
  }

  async function handleDelete(id: string) {
    try {
      await del(`/dashboard/api/custom-providers/${id}`)
      toast.success("Provider deleted")
      if (editingId === id) closeForm()
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to delete provider"))
    }
  }

  async function handleSave() {
    if (!form.id.trim()) {
      toast.error("Provider ID is required")
      return
    }
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    if (!form.baseUrl.trim()) {
      toast.error("Base URL is required")
      return
    }
    if (form.authMode === "key" && !form.apiKey.trim()) {
      toast.error("API key is required")
      return
    }
    if (form.authMode === "env" && !form.apiKeyEnv.trim()) {
      toast.error("API key env var name is required")
      return
    }
    if (form.models.length === 0) {
      toast.error("At least one model is required")
      return
    }
    for (const row of form.models) {
      if (!row.modelId.trim()) {
        toast.error("Every model needs an ID")
        return
      }
    }

    let timeoutMs: number | undefined
    if (form.timeoutMs.trim()) {
      const parsed = Number(form.timeoutMs.trim())
      if (!Number.isFinite(parsed)) {
        toast.error("Timeout must be a number")
        return
      }
      timeoutMs = parsed
    }

    const models: Array<CustomProviderModel> = []
    for (const row of form.models) {
      let dimensions: number | undefined
      if (row.dimensions.trim()) {
        const parsed = Number(row.dimensions.trim())
        if (!Number.isFinite(parsed)) {
          toast.error(`Dimensions for "${row.modelId}" must be a number`)
          return
        }
        dimensions = parsed
      }
      const aliases = row.aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean)

      models.push({
        id: row.modelId.trim(),
        kind: row.kind,
        aliases: aliases.length > 0 ? aliases : undefined,
        dimensions,
        supportsStreaming: row.supportsStreaming,
        passReasoningEffort: row.passReasoningEffort,
      })
    }

    const headers = Object.fromEntries(
      form.headers
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value]),
    )

    const payload: Record<string, unknown> = {
      id: form.id.trim(),
      name: form.name.trim(),
      type: "openai-compatible",
      baseUrl: form.baseUrl.trim(),
      passReasoningEffort: form.passReasoningEffort,
      models,
    }
    if (form.authMode === "key") payload.apiKey = form.apiKey.trim()
    if (form.authMode === "env") payload.apiKeyEnv = form.apiKeyEnv.trim()
    if (Object.keys(headers).length > 0) payload.headers = headers
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs

    setIsSaving(true)
    try {
      await post("/dashboard/api/custom-providers", payload)
      toast.success(editingId ? "Provider updated" : "Provider created")
      closeForm()
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to save provider"))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleNebiusAdd() {
    if (!nebiusApiKey.trim()) {
      toast.error("API key is required")
      return
    }
    setIsNebiusSaving(true)
    try {
      await post("/dashboard/api/custom-providers/nebius-qwen3", {
        apiKey: nebiusApiKey.trim(),
      })
      toast.success("Nebius Qwen3 provider added")
      setNebiusApiKey("")
      setIsNebiusOpen(false)
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to add provider"))
    } finally {
      setIsNebiusSaving(false)
    }
  }

  const columns: Array<TableColumn<ProviderRow>> = [
    {
      key: "provider",
      header: "Provider",
      width: proportional(1),
      renderCell: (item) => (
        <VStack gap={0.5}>
          <Text weight="medium">{item.name}</Text>
          <MonoText>{item.id}</MonoText>
        </VStack>
      ),
    },
    {
      key: "baseUrl",
      header: "Base URL",
      width: proportional(2),
      renderCell: (item) => <MonoText>{item.baseUrl}</MonoText>,
    },
    {
      key: "apiKey",
      header: "Auth",
      width: pixel(96),
      renderCell: (item) => authIndicator(item),
    },
    {
      key: "models",
      header: "Models",
      width: proportional(2),
      renderCell: (item) => modelBadges(item.models),
    },
    {
      key: "actions",
      header: "",
      width: pixel(88),
      align: "end",
      renderCell: (item) => (
        <RowActions>
          <IconAction
            label="Edit"
            icon={<PencilIcon />}
            onClick={() => openEdit(item)}
          />
          <ConfirmButton
            label="Delete provider"
            isIconOnly
            icon={<Trash2Icon />}
            size="sm"
            confirmTitle="Delete provider"
            confirmDescription={`Delete "${item.name}"? This cannot be undone.`}
            onConfirm={() => handleDelete(item.id)}
          />
        </RowActions>
      ),
    },
  ]

  return (
    <Page
      kicker="Control"
      title="Custom Providers"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <HStack gap={2} vAlign="center">
          <Button
            label="Quick Add: Nebius Qwen3 Embedding"
            variant="secondary"
            icon={<KeyRoundIcon />}
            onClick={() => setIsNebiusOpen(true)}
          />
          <Button
            label="Add Custom Provider"
            variant="primary"
            icon={<PlusIcon />}
            onClick={openCreate}
          />
        </HStack>
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load custom providers"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={56} index={index} />
          ))}
        </VStack>
      : null}

      {data && data.length === 0 ?
        <EmptyState
          icon={<PlugIcon />}
          title="No custom providers"
          description="Add an OpenAI-compatible provider to route chat or embedding requests through it."
          actions={
            <Button
              label="Add Custom Provider"
              variant="primary"
              icon={<PlusIcon />}
              onClick={openCreate}
            />
          }
        />
      : null}

      {data && data.length > 0 ?
        <DataTable
          data={data as Array<ProviderRow>}
          columns={columns}
          idKey="id"
        />
      : null}

      <Dialog
        isOpen={isFormOpen}
        onOpenChange={setIsFormOpen}
        purpose="form"
        width={640}
        maxHeight="85vh"
      >
        <DialogHeader
          title={editingId ? "Edit provider" : "Add custom provider"}
          onOpenChange={setIsFormOpen}
        />
        <VStack gap={4} padding={4} isScrollable>
          <TextInput
            label="Provider ID"
            value={form.id}
            onChange={(value) => setForm((f) => ({ ...f, id: value }))}
            isDisabled={editingId != null}
            isRequired
          />
          <TextInput
            label="Name"
            value={form.name}
            onChange={(value) => setForm((f) => ({ ...f, name: value }))}
            isRequired
          />
          <TextInput
            label="Base URL"
            value={form.baseUrl}
            onChange={(value) => setForm((f) => ({ ...f, baseUrl: value }))}
            placeholder="https://api.example.com/v1"
            isRequired
          />

          <Card variant="muted">
            <VStack gap={3}>
              <Heading level={4}>Authentication</Heading>
              <SegmentedControl
                label="API key source"
                value={form.authMode}
                onChange={(value) =>
                  setForm((f) => ({ ...f, authMode: value as AuthMode }))
                }
              >
                <SegmentedControlItem value="key" label="API key" />
                <SegmentedControlItem value="env" label="From env var" />
              </SegmentedControl>
              {form.authMode === "key" ?
                <TextInput
                  type="password"
                  label="API key"
                  value={form.apiKey}
                  onChange={(value) =>
                    setForm((f) => ({ ...f, apiKey: value }))
                  }
                  isRequired
                />
              : <TextInput
                  label="Env var name"
                  value={form.apiKeyEnv}
                  onChange={(value) =>
                    setForm((f) => ({ ...f, apiKeyEnv: value }))
                  }
                  placeholder="MY_PROVIDER_API_KEY"
                  isRequired
                />
              }
            </VStack>
          </Card>

          <Card variant="muted">
            <VStack gap={3}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={4}>Headers</Heading>
                <Button
                  label="Add header"
                  variant="ghost"
                  size="sm"
                  icon={<PlusIcon />}
                  onClick={addHeaderRow}
                />
              </HStack>
              {form.headers.length === 0 ?
                <Text type="supporting" color="secondary">
                  No custom headers configured.
                </Text>
              : null}
              {form.headers.map((row) => (
                <FormLayout key={row.rowId} direction="horizontal">
                  <TextInput
                    label="Header name"
                    isLabelHidden
                    value={row.key}
                    onChange={(value) =>
                      updateHeaderRow(row.rowId, { key: value })
                    }
                    placeholder="Header name"
                  />
                  <TextInput
                    label="Header value"
                    isLabelHidden
                    value={row.value}
                    onChange={(value) => updateHeaderRow(row.rowId, { value })}
                    placeholder="Header value"
                  />
                  <IconButton
                    label="Remove header"
                    tooltip="Remove"
                    icon={<Trash2Icon />}
                    variant="ghost"
                    onClick={() => removeHeaderRow(row.rowId)}
                  />
                </FormLayout>
              ))}
            </VStack>
          </Card>

          <TextInput
            label="Timeout (ms)"
            value={form.timeoutMs}
            onChange={(value) => setForm((f) => ({ ...f, timeoutMs: value }))}
            placeholder="30000"
            isOptional
          />
          <Switch
            label="Pass reasoning effort to this provider"
            value={form.passReasoningEffort}
            onChange={(value) =>
              setForm((f) => ({ ...f, passReasoningEffort: value }))
            }
          />

          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={4}>Models</Heading>
              <Button
                label="Add model"
                variant="ghost"
                size="sm"
                icon={<PlusIcon />}
                onClick={addModelRow}
              />
            </HStack>
            {form.models.map((row) => (
              <Card key={row.rowId} variant="muted">
                <VStack gap={3}>
                  <HStack hAlign="between" vAlign="center">
                    <FormLayout direction="horizontal">
                      <TextInput
                        label="Model ID"
                        value={row.modelId}
                        onChange={(value) =>
                          updateModelRow(row.rowId, { modelId: value })
                        }
                        isRequired
                      />
                      <Selector
                        label="Kind"
                        value={row.kind}
                        onChange={(value) =>
                          updateModelRow(row.rowId, {
                            kind: value as CustomProviderModelKind,
                          })
                        }
                        options={KIND_OPTIONS}
                      />
                    </FormLayout>
                    <IconButton
                      label="Remove model"
                      tooltip="Remove model"
                      icon={<Trash2Icon />}
                      variant="ghost"
                      onClick={() => removeModelRow(row.rowId)}
                    />
                  </HStack>
                  <TextInput
                    label="Aliases (comma-separated)"
                    value={row.aliases}
                    onChange={(value) =>
                      updateModelRow(row.rowId, { aliases: value })
                    }
                    placeholder="alias-one, alias-two"
                    isOptional
                  />
                  <TextInput
                    label="Dimensions"
                    value={row.dimensions}
                    onChange={(value) =>
                      updateModelRow(row.rowId, { dimensions: value })
                    }
                    placeholder="1536"
                    description="Relevant for embedding models"
                    isOptional
                  />
                  <HStack gap={4}>
                    <Switch
                      label="Supports streaming"
                      value={row.supportsStreaming}
                      onChange={(value) =>
                        updateModelRow(row.rowId, { supportsStreaming: value })
                      }
                    />
                    <Switch
                      label="Pass reasoning effort"
                      value={row.passReasoningEffort}
                      onChange={(value) =>
                        updateModelRow(row.rowId, {
                          passReasoningEffort: value,
                        })
                      }
                    />
                  </HStack>
                </VStack>
              </Card>
            ))}
          </VStack>

          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" onClick={closeForm} />
            <Button
              label="Save provider"
              variant="primary"
              isLoading={isSaving}
              onClick={handleSave}
            />
          </HStack>
        </VStack>
      </Dialog>

      <Dialog
        isOpen={isNebiusOpen}
        onOpenChange={setIsNebiusOpen}
        purpose="form"
        width={420}
      >
        <DialogHeader
          title="Quick Add: Nebius Qwen3 Embedding"
          onOpenChange={setIsNebiusOpen}
        />
        <VStack gap={4} padding={4}>
          <TextInput
            type="password"
            label="API key"
            value={nebiusApiKey}
            onChange={setNebiusApiKey}
            placeholder="Nebius API key"
            isRequired
          />
          <HStack gap={2} hAlign="end">
            <Button
              label="Cancel"
              variant="secondary"
              onClick={() => setIsNebiusOpen(false)}
            />
            <Button
              label="Add provider"
              variant="primary"
              isLoading={isNebiusSaving}
              onClick={handleNebiusAdd}
            />
          </HStack>
        </VStack>
      </Dialog>
    </Page>
  )
}
