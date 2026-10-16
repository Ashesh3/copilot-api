import type { SystemPromptOverride } from "../../../src/lib/system-prompt-overrides"
import type { ModelSetting } from "./types"

import {
  getSystemPromptOverrides,
  MAX_SYSTEM_PROMPT_OVERRIDES,
  MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH,
  validateSystemPromptOverrides,
} from "../../../src/lib/system-prompt-overrides"

export type SystemPromptOverrideMode = SystemPromptOverride["mode"]

export interface SystemPromptOverrideRow {
  id: string
  mode: SystemPromptOverrideMode
  prompt: string
  find: string
  replacement: string
  allowPrepend: boolean
}

type FieldErrors = Partial<Record<"prompt" | "find" | "replacement", string>>

export const SYSTEM_PROMPT_OVERRIDE_LABELS: Record<
  SystemPromptOverrideMode,
  string
> = {
  clear: "Clear system prompts",
  append: "Force append",
  replace: "Find and replace",
  prepend: "Add separate prompt",
}

let rowIdCounter = 0

export function createSystemPromptOverrideRow(
  rule: SystemPromptOverride = { mode: "append", prompt: "" },
): SystemPromptOverrideRow {
  rowIdCounter += 1
  return {
    id: `system-prompt-override-${rowIdCounter}`,
    mode: rule.mode,
    prompt: rule.mode === "replace" ? "" : rule.prompt,
    find: rule.mode === "replace" ? rule.find : "",
    replacement: rule.mode === "replace" ? rule.replacement : "",
    allowPrepend: rule.mode === "prepend",
  }
}

export function toSystemPromptOverrideRows(
  setting: ModelSetting,
): Array<SystemPromptOverrideRow> {
  return getSystemPromptOverrides(setting).map((rule) =>
    createSystemPromptOverrideRow(rule),
  )
}

/** Serialize active fields only; whitespace and the displayed order are literal. */
export function toSystemPromptOverrides(
  rows: Array<SystemPromptOverrideRow>,
): Array<SystemPromptOverride> {
  return rows.map((row) =>
    row.mode === "replace" ?
      { mode: row.mode, find: row.find, replacement: row.replacement }
    : { mode: row.mode, prompt: row.prompt },
  )
}

export function getSystemPromptOverrideOptions(row: SystemPromptOverrideRow) {
  const modes: Array<SystemPromptOverrideMode> = ["clear", "append", "replace"]
  if (row.allowPrepend) modes.push("prepend")
  return modes.map((mode) => ({
    value: mode,
    label: SYSTEM_PROMPT_OVERRIDE_LABELS[mode],
  }))
}

export function moveSystemPromptOverride(
  rows: Array<SystemPromptOverrideRow>,
  id: string,
  direction: "up" | "down",
): Array<SystemPromptOverrideRow> {
  const index = rows.findIndex((row) => row.id === id)
  const targetIndex = index + (direction === "up" ? -1 : 1)
  if (index < 0 || targetIndex < 0 || targetIndex >= rows.length) return rows
  const reordered = [...rows]
  ;[reordered[index], reordered[targetIndex]] = [rows[targetIndex], rows[index]]
  return reordered
}

export function getSystemPromptOverrideFieldErrors(
  row: SystemPromptOverrideRow,
): FieldErrors {
  const errors: FieldErrors = {}
  if (row.mode === "replace" && row.find.length === 0) {
    errors.find = "Enter the exact text to find."
  }
  if (row.mode !== "replace" && row.mode !== "clear" && !row.prompt.trim()) {
    errors.prompt = "Enter a system prompt."
  }
  const fields =
    row.mode === "replace" ?
      (["find", "replacement"] as const)
    : (["prompt"] as const)
  for (const field of fields) {
    if (row[field].length > MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH) {
      errors[field] =
        `Use at most ${MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH.toLocaleString("en-US")} characters.`
    }
  }
  return errors
}

export function validateSystemPromptOverrideRows(
  rows: Array<SystemPromptOverrideRow>,
): string | undefined {
  if (!validateSystemPromptOverrides(toSystemPromptOverrides(rows)))
    return undefined
  if (rows.length > MAX_SYSTEM_PROMPT_OVERRIDES) {
    return `Use at most ${MAX_SYSTEM_PROMPT_OVERRIDES} configurations.`
  }
  for (const [index, row] of rows.entries()) {
    const error = Object.values(getSystemPromptOverrideFieldErrors(row))[0]
    if (error) return `Configuration ${index + 1}: ${error}`
  }
  return `Keep the combined text across all configurations to ${MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH.toLocaleString("en-US")} characters or fewer.`
}
