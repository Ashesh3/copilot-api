import type { ButtonVariant } from "@astryxdesign/core/Button"
import type { TableColumn } from "@astryxdesign/core/Table"
import type { ComponentType, ReactNode, SVGProps } from "react"

import { AlertDialog } from "@astryxdesign/core/AlertDialog"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { EmptyState as AstryxEmptyState } from "@astryxdesign/core/EmptyState"
import { Icon } from "@astryxdesign/core/Icon"
import { IconButton } from "@astryxdesign/core/IconButton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Table } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useState } from "react"

export type StatTone = "default" | "accent" | "success" | "warning" | "error"

export interface StatCardProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  value: ReactNode
  tone?: StatTone
}

const TONE_TO_ICON_COLOR = {
  default: "secondary",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
} as const

export function StatCard({
  icon,
  label,
  value,
  tone = "default",
}: StatCardProps) {
  return (
    <Card>
      <HStack gap={3} vAlign="center">
        <Icon icon={icon} size="lg" color={TONE_TO_ICON_COLOR[tone]} />
        <VStack gap={0.5}>
          <Text type="label" color="secondary">
            {label}
          </Text>
          <Heading level={3}>{value}</Heading>
        </VStack>
      </HStack>
    </Card>
  )
}

export interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  actions?: ReactNode
}

export function EmptyState({
  title,
  description,
  icon,
  actions,
}: EmptyStateProps) {
  return (
    <AstryxEmptyState
      title={title}
      description={description}
      icon={icon}
      actions={actions}
    />
  )
}

export interface ConfirmButtonProps {
  label: string
  confirmTitle: string
  confirmDescription: string
  confirmActionLabel?: string
  onConfirm: () => void | Promise<void>
  variant?: ButtonVariant
  size?: "sm" | "md" | "lg"
  icon?: ReactNode
  isIconOnly?: boolean
  isDisabled?: boolean
}

export function ConfirmButton({
  label,
  confirmTitle,
  confirmDescription,
  confirmActionLabel,
  onConfirm,
  variant = "destructive",
  size,
  icon,
  isIconOnly,
  isDisabled,
}: ConfirmButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const handleConfirm = async () => {
    setIsLoading(true)
    try {
      await onConfirm()
      setIsOpen(false)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <>
      <Button
        label={label}
        variant={variant}
        size={size}
        icon={icon}
        isIconOnly={isIconOnly}
        isDisabled={isDisabled}
        onClick={() => setIsOpen(true)}
      />
      <AlertDialog
        className="confirm-dialog"
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        title={confirmTitle}
        description={confirmDescription}
        actionLabel={confirmActionLabel ?? label}
        actionVariant={variant}
        isActionLoading={isLoading}
        onAction={handleConfirm}
        width="min(400px, calc(100vw - 32px))"
      />
    </>
  )
}

export function fmtRelative(ts: number | string): string {
  const ms = typeof ts === "string" ? new Date(ts).getTime() : ts
  if (!Number.isFinite(ms)) return "unknown"

  const diffMs = Date.now() - ms
  const diffSec = Math.round(diffMs / 1000)
  const absSec = Math.abs(diffSec)

  if (absSec < 5) return "just now"

  const units: Array<[string, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ]

  for (const [unit, secondsPerUnit] of units) {
    const value = Math.floor(absSec / secondsPerUnit)
    if (value >= 1) {
      const plural = value === 1 ? unit : `${unit}s`
      return diffSec >= 0 ? `${value} ${plural} ago` : `in ${value} ${plural}`
    }
  }

  return "just now"
}

export function RelTime({ ts }: { ts: number | string }) {
  const iso = typeof ts === "string" ? ts : new Date(ts).toISOString()
  // Text omits `title` (see Astryx BaseProps), so the native tooltip needs a
  // plain span wrapper rather than a layout component.
  return (
    <span title={iso}>
      <Text as="span" color="secondary">
        {fmtRelative(ts)}
      </Text>
    </span>
  )
}

export function MonoText({ children }: { children: ReactNode }) {
  return <Text type="code">{children}</Text>
}

/**
 * Shared data table with the project's overflow-safe defaults: compact density,
 * truncated cell text (ellipsis + hover tooltip), and row hover. Screens must
 * still size text columns with `proportional()` and keep fixed `pixel()` widths
 * small so the columns never sum past the container and force a scrollbar.
 */
export interface DataTableProps<T extends Record<string, unknown>> {
  data: Array<T>
  columns: Array<TableColumn<T>>
  idKey?: (keyof T & string) | ((item: T) => string | number)
}

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  idKey,
}: DataTableProps<T>) {
  return (
    <Table
      data={data}
      columns={columns}
      idKey={idKey}
      density="compact"
      textOverflow="truncate"
      dividers="rows"
      hasHover
    />
  )
}

/** Compact ghost icon button for table row actions. Always give a clear label. */
export interface IconActionProps {
  label: string
  icon: ReactNode
  onClick: () => void | Promise<void>
  variant?: ButtonVariant
  isDisabled?: boolean
}

export function IconAction({
  label,
  icon,
  onClick,
  variant = "ghost",
  isDisabled,
}: IconActionProps) {
  return (
    <IconButton
      label={label}
      tooltip={label}
      icon={icon}
      variant={variant}
      size="sm"
      isDisabled={isDisabled}
      clickAction={onClick}
    />
  )
}

/** Right-aligned, tightly-spaced container for a row's action buttons. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <HStack gap={0.5} hAlign="end" vAlign="center">
      {children}
    </HStack>
  )
}

export interface TogglePillProps {
  label: string
  value: boolean
  onChange: (value: boolean) => void | Promise<void>
  isDisabled?: boolean
}

export function TogglePill({
  label,
  value,
  onChange,
  isDisabled,
}: TogglePillProps) {
  return (
    <Switch
      label={label}
      value={value}
      changeAction={onChange}
      isDisabled={isDisabled}
      isLabelHidden
    />
  )
}
