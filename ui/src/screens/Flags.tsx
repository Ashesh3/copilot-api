import type { TableColumn } from "@astryxdesign/core/Table"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useState } from "react"

import type { FlagsMap, FlagValue } from "../lib/types"

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

interface FlagRow extends Record<string, unknown> {
  name: string
  value: FlagValue
}

type FlagValueType = "boolean" | "string" | "number"

function loadFlags(): Promise<FlagsMap> {
  return get<FlagsMap>("/dashboard/api/flags")
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

function displayValue(value: FlagValue): string {
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

interface FlagFormDialogProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  mode: "add" | "edit"
  initialName: string
  initialValue: FlagValue
  onSubmit: (name: string, value: FlagValue) => Promise<void>
}

function FlagFormDialog({
  isOpen,
  onOpenChange,
  mode,
  initialName,
  initialValue,
  onSubmit,
}: FlagFormDialogProps) {
  const [name, setName] = useState(initialName)
  const [type, setType] = useState<FlagValueType>(valueType(initialValue))
  const [boolValue, setBoolValue] = useState(initialValue === true)
  const [textValue, setTextValue] = useState(valueToText(initialValue))
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setName(initialName)
    setType(valueType(initialValue))
    setBoolValue(initialValue === true)
    setTextValue(valueToText(initialValue))
  }, [isOpen, initialName, initialValue])

  const trimmedName = name.trim()
  const isNumberValid =
    type !== "number"
    || (textValue.trim() !== "" && !Number.isNaN(Number(textValue)))
  const canSubmit = trimmedName.length > 0 && isNumberValid

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSaving(true)
    try {
      let value: FlagValue = textValue
      if (type === "boolean") value = boolValue
      else if (type === "number") value = Number(textValue)
      await onSubmit(trimmedName, value)
      onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={420}
    >
      <Layout
        header={
          <DialogHeader
            title={mode === "add" ? "Add Flag" : `Edit "${initialName}"`}
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
                placeholder="my-flag"
              />
              <Selector
                label="Type"
                value={type}
                onChange={(next) => setType(next as FlagValueType)}
                options={["boolean", "string", "number"]}
              />
              {type === "boolean" ?
                <Switch
                  label="Value"
                  value={boolValue}
                  onChange={setBoolValue}
                />
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
  const { data, error, loading, reload } = useAsyncData(loadFlags, [])

  const [dialogState, setDialogState] = useState<{
    mode: "add" | "edit"
    name: string
    value: FlagValue
  } | null>(null)

  const rows: Array<FlagRow> = Object.entries(data ?? {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name))

  async function handleToggle(name: string, next: boolean) {
    try {
      await post("/dashboard/api/flags", { name, value: next })
      toast.success(`Updated flag "${name}"`)
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to update flag",
      )
    }
  }

  async function handleDelete(name: string) {
    try {
      await del("/dashboard/api/flags", { name })
      toast.success(`Deleted flag "${name}"`)
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to delete flag",
      )
    }
  }

  async function handleSubmit(name: string, value: FlagValue) {
    try {
      await post("/dashboard/api/flags", { name, value })
      toast.success(`Saved flag "${name}"`)
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to save flag",
      )
      throw caught
    }
  }

  const columns: Array<TableColumn<FlagRow>> = [
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
            onChange={(next) => handleToggle(row.name, next)}
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
                  mode: "edit",
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
            onConfirm={() => handleDelete(row.name)}
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
        <Button
          label="Add Flag"
          icon={<PlusIcon />}
          onClick={() => setDialogState({ mode: "add", name: "", value: true })}
        />
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load flags"
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
          icon={<FlagIcon />}
          title="No feature flags"
          description="Add a flag to get started."
        />
      : null}

      {rows.length > 0 ?
        <Card padding={0}>
          <DataTable data={rows} columns={columns} idKey="name" />
        </Card>
      : null}

      {dialogState ?
        <FlagFormDialog
          isOpen
          onOpenChange={(isOpen) => {
            if (!isOpen) setDialogState(null)
          }}
          mode={dialogState.mode}
          initialName={dialogState.name}
          initialValue={dialogState.value}
          onSubmit={handleSubmit}
        />
      : null}
    </Page>
  )
}
