import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useState } from "react"

import type { Replacement } from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  IconAction,
  MonoText,
  RowActions,
  TogglePill,
} from "../components/common"
import { Page } from "../components/Page"
import {
  InfoIcon,
  PencilIcon,
  PlusIcon,
  Repeat2Icon,
  Trash2Icon,
} from "../icons"
import { del, get, patch, post, put } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

// Table<T> requires T extends Record<string, unknown>; Replacement itself has
// no index signature, so widen it locally for table generics.
type ReplacementRow = Replacement & Record<string, unknown>

interface ReplacementInput {
  name?: string
  pattern: string
  replacement: string
  isRegex: boolean
}

type DialogMode = "add" | "edit" | "view"

function loadReplacements(): Promise<Array<ReplacementRow>> {
  return get<Array<ReplacementRow>>("/dashboard/api/replacements")
}

function dialogTitle(mode: DialogMode): string {
  if (mode === "add") return "Add replacement"
  if (mode === "edit") return "Edit replacement"
  return "Replacement details"
}

interface ReplacementDialogProps {
  mode: DialogMode
  isOpen: boolean
  initial: ReplacementRow | null
  onOpenChange: (isOpen: boolean) => void
  onSubmit: (input: ReplacementInput) => Promise<void>
}

function ReplacementDialog({
  mode,
  isOpen,
  initial,
  onOpenChange,
  onSubmit,
}: ReplacementDialogProps) {
  const [name, setName] = useState("")
  const [pattern, setPattern] = useState("")
  const [replacement, setReplacement] = useState("")
  const [isRegex, setIsRegex] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const readOnly = mode === "view"

  useEffect(() => {
    if (!isOpen) return
    setName(initial?.name ?? "")
    setPattern(initial?.pattern ?? "")
    setReplacement(initial?.replacement ?? "")
    setIsRegex(initial?.isRegex ?? false)
  }, [isOpen, initial])

  const trimmedPattern = pattern.trim()
  const canSubmit = !readOnly && trimmedPattern.length > 0

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSaving(true)
    try {
      await onSubmit({
        name: name.trim() || undefined,
        pattern: trimmedPattern,
        replacement,
        isRegex,
      })
      onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  const disabledMessage = readOnly ? "System rule — read-only" : undefined

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={560}
    >
      <Layout
        header={
          <DialogHeader title={dialogTitle(mode)} onOpenChange={onOpenChange} />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Name"
                value={name}
                onChange={setName}
                placeholder="my-rule"
                isOptional={!readOnly}
                isDisabled={readOnly}
                disabledMessage={disabledMessage}
              />
              <TextArea
                label="Pattern"
                value={pattern}
                onChange={setPattern}
                placeholder="pattern to match"
                rows={4}
                isRequired={!readOnly}
                isDisabled={readOnly}
                disabledMessage={disabledMessage}
              />
              <TextArea
                label="Replacement"
                value={replacement}
                onChange={setReplacement}
                placeholder="replacement text"
                rows={6}
                isOptional={!readOnly}
                isDisabled={readOnly}
                disabledMessage={disabledMessage}
              />
              <Switch
                label="Regex"
                value={isRegex}
                onChange={setIsRegex}
                isDisabled={readOnly}
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                label={readOnly ? "Close" : "Cancel"}
                variant="secondary"
                onClick={() => onOpenChange(false)}
              />
              {readOnly ? null : (
                <Button
                  label="Save"
                  onClick={handleSubmit}
                  isLoading={isSaving}
                  isDisabled={!canSubmit}
                />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

export default function ReplacementsScreen() {
  const toast = useToast()
  const { data, error, loading, reload } = useAsyncData(loadReplacements, [])
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [editState, setEditState] = useState<{
    mode: "edit" | "view"
    row: ReplacementRow
  } | null>(null)

  const rows = data ?? []

  async function handleToggleEnabled(
    replacement: ReplacementRow,
    next: boolean,
  ) {
    try {
      await patch(`/dashboard/api/replacements/${replacement.id}`)
      toast.success(
        `${next ? "Enabled" : "Disabled"} "${replacement.name ?? replacement.pattern}"`,
      )
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ?
          caught.message
        : "Failed to update replacement",
      )
    }
  }

  async function handleDelete(replacement: ReplacementRow) {
    try {
      await del(`/dashboard/api/replacements/${replacement.id}`)
      toast.success(
        `Deleted replacement "${replacement.name ?? replacement.pattern}"`,
      )
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ?
          caught.message
        : "Failed to delete replacement",
      )
    }
  }

  async function handleAdd(input: ReplacementInput) {
    try {
      await post("/dashboard/api/replacements", input)
      toast.success("Added replacement")
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to add replacement",
      )
      throw caught
    }
  }

  async function handleUpdate(input: ReplacementInput) {
    if (!editState) return
    try {
      await put(`/dashboard/api/replacements/${editState.row.id}`, input)
      toast.success("Updated replacement")
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ?
          caught.message
        : "Failed to update replacement",
      )
      throw caught
    }
  }

  const columns: Array<TableColumn<ReplacementRow>> = [
    {
      key: "name",
      header: "Name",
      width: proportional(1),
      renderCell: (row) => (
        <HStack gap={2} vAlign="center">
          <Text>{row.name ?? "—"}</Text>
          {row.isSystem ?
            <Badge variant="neutral" label="System" />
          : null}
        </HStack>
      ),
    },
    {
      key: "pattern",
      header: "Pattern",
      width: proportional(2),
      renderCell: (row) => (
        <span title={row.pattern}>
          <MonoText>{row.pattern}</MonoText>
        </span>
      ),
    },
    {
      key: "replacement",
      header: "Replacement",
      width: proportional(2),
      renderCell: (row) => (
        <span title={row.replacement}>
          <MonoText>{row.replacement}</MonoText>
        </span>
      ),
    },
    {
      key: "isRegex",
      header: "Type",
      width: pixel(90),
      renderCell: (row) => (
        <Badge
          variant={row.isRegex ? "purple" : "neutral"}
          label={row.isRegex ? "regex" : "string"}
        />
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      width: pixel(72),
      renderCell: (row) => (
        <TogglePill
          label={`Enable ${row.name ?? row.pattern}`}
          value={row.enabled}
          onChange={(next) => handleToggleEnabled(row, next)}
          isDisabled={row.isSystem}
        />
      ),
    },
    {
      key: "actions",
      header: "",
      width: pixel(88),
      align: "end",
      renderCell: (row) => (
        <RowActions>
          {row.isSystem ?
            <IconAction
              label="View replacement"
              icon={<InfoIcon />}
              onClick={() => setEditState({ mode: "view", row })}
            />
          : <IconAction
              label="Edit replacement"
              icon={<PencilIcon />}
              onClick={() => setEditState({ mode: "edit", row })}
            />
          }
          <ConfirmButton
            label="Delete"
            confirmTitle={`Delete replacement "${row.name ?? row.pattern}"?`}
            confirmDescription="This removes the replacement rule entirely. This action cannot be undone."
            icon={<Trash2Icon />}
            isIconOnly
            size="sm"
            isDisabled={row.isSystem}
            onConfirm={() => handleDelete(row)}
          />
        </RowActions>
      ),
    },
  ]

  return (
    <Page
      kicker="Control"
      title="Replacements"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <Button
          label="Add Replacement"
          icon={<PlusIcon />}
          onClick={() => setIsAddOpen(true)}
        />
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load replacements"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <Skeleton height={240} />
      : null}

      {data && rows.length === 0 ?
        <EmptyState
          icon={<Repeat2Icon />}
          title="No replacements"
          description="Add a replacement rule to get started."
        />
      : null}

      {rows.length > 0 ?
        <Card padding={0}>
          <DataTable data={rows} columns={columns} idKey="id" />
        </Card>
      : null}

      <ReplacementDialog
        mode="add"
        isOpen={isAddOpen}
        initial={null}
        onOpenChange={setIsAddOpen}
        onSubmit={handleAdd}
      />

      <ReplacementDialog
        mode={editState?.mode ?? "view"}
        isOpen={editState !== null}
        initial={editState?.row ?? null}
        onOpenChange={(open) => {
          if (!open) setEditState(null)
        }}
        onSubmit={handleUpdate}
      />
    </Page>
  )
}
