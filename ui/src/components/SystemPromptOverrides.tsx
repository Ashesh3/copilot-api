import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { useEffect, useRef } from "react"

import type {
  SystemPromptOverrideMode,
  SystemPromptOverrideRow,
} from "../lib/system-prompt-override-form"

import {
  MAX_SYSTEM_PROMPT_OVERRIDES,
  MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH,
} from "../../../src/lib/system-prompt-overrides"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "../icons"
import {
  createSystemPromptOverrideRow,
  getSystemPromptOverrideFieldErrors,
  getSystemPromptOverrideOptions,
  moveSystemPromptOverride,
  validateSystemPromptOverrideRows,
} from "../lib/system-prompt-override-form"
import { IconAction } from "./common"

const MODE_DESCRIPTIONS: Record<SystemPromptOverrideMode, string> = {
  clear:
    "Remove all system and developer prompts. Optionally replace them with the text below; leave it empty to clear only.",
  append:
    "Add this text to the top of the existing system prompt. Creates a system prompt if none exists.",
  replace:
    "Replace every exact match in system and developer text. Matching is case-sensitive and literal; no match leaves the text unchanged.",
  prepend:
    "Add a separate system prompt before the existing prompts. This preserves your previous configuration.",
}

interface SystemPromptOverridesProps {
  value: Array<SystemPromptOverrideRow>
  onChange: (rows: Array<SystemPromptOverrideRow>) => void
  validationAttempt: number
  isDisabled?: boolean
}

export function SystemPromptOverrides({
  value,
  onChange,
  validationAttempt,
  isDisabled = false,
}: SystemPromptOverridesProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const validationRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const showErrors = validationAttempt > 0
  const error = showErrors ? validateSystemPromptOverrideRows(value) : undefined
  const atLimit = value.length >= MAX_SYSTEM_PROMPT_OVERRIDES

  useEffect(() => {
    if (validationAttempt === 0) return
    const invalidField = editorRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    )
    ;(invalidField ?? validationRef.current)?.focus()
  }, [validationAttempt])

  useEffect(() => {
    if (!pendingFocus.current) return
    if (pendingFocus.current === "add") {
      addButtonRef.current?.focus()
    } else {
      editorRef.current
        ?.querySelector<HTMLElement>(
          `[data-override-row="${pendingFocus.current}"] [role="combobox"]`,
        )
        ?.focus()
    }
    pendingFocus.current = null
  }, [value])

  function updateRow(id: string, patch: Partial<SystemPromptOverrideRow>) {
    onChange(value.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function addRow() {
    if (atLimit) return
    const row = createSystemPromptOverrideRow()
    pendingFocus.current = row.id
    onChange([...value, row])
  }

  function removeRow(index: number) {
    const neighbor =
      value.at(index + 1) ?? (index > 0 ? value.at(index - 1) : undefined)
    pendingFocus.current = neighbor?.id ?? "add"
    onChange(value.filter((_, rowIndex) => rowIndex !== index))
  }

  function moveRow(id: string, direction: "up" | "down") {
    pendingFocus.current = id
    onChange(moveSystemPromptOverride(value, id, direction))
  }

  return (
    <Card variant="muted" ref={editorRef}>
      <VStack gap={4}>
        <VStack gap={1}>
          <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
            <Heading level={4}>System prompt overrides</Heading>
            <Badge
              variant="neutral"
              label={`${value.length} ${value.length === 1 ? "configuration" : "configurations"}`}
            />
          </HStack>
          <Text color="secondary">
            Configurations run from top to bottom on every request for this
            model. Each uses the result of the previous configuration.
          </Text>
        </VStack>

        {error ?
          <div ref={validationRef} tabIndex={-1}>
            <Banner
              status="error"
              title="Check system prompt overrides"
              description={error}
            />
          </div>
        : null}

        {value.length === 0 ?
          <Text color="secondary">
            No overrides. System and developer prompts are kept as received.
          </Text>
        : <VStack
            as="ol"
            gap={3}
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            {value.map((row, index) => {
              const errors =
                showErrors ? getSystemPromptOverrideFieldErrors(row) : {}
              return (
                <li
                  key={row.id}
                  data-override-row={row.id}
                  aria-labelledby={`${row.id}-title`}
                >
                  <Card>
                    <VStack gap={3}>
                      <HStack
                        gap={2}
                        hAlign="between"
                        vAlign="center"
                        wrap="wrap"
                      >
                        <Text type="label" id={`${row.id}-title`}>
                          Configuration {index + 1}
                        </Text>
                        <HStack gap={1} vAlign="center">
                          <IconAction
                            label={`Move configuration ${index + 1} up`}
                            icon={<ArrowUpIcon />}
                            isDisabled={isDisabled || index === 0}
                            onClick={() => moveRow(row.id, "up")}
                          />
                          <IconAction
                            label={`Move configuration ${index + 1} down`}
                            icon={<ArrowDownIcon />}
                            isDisabled={
                              isDisabled || index === value.length - 1
                            }
                            onClick={() => moveRow(row.id, "down")}
                          />
                          <IconAction
                            label={`Remove configuration ${index + 1}`}
                            icon={<Trash2Icon />}
                            isDisabled={isDisabled}
                            onClick={() => removeRow(index)}
                          />
                        </HStack>
                      </HStack>

                      <VStack
                        gap={1}
                        role="group"
                        aria-describedby={`${row.id}-description`}
                      >
                        <Selector
                          label="Mode"
                          value={row.mode}
                          options={getSystemPromptOverrideOptions(row)}
                          onChange={(mode) =>
                            updateRow(row.id, {
                              mode: mode as SystemPromptOverrideMode,
                            })
                          }
                          isDisabled={isDisabled}
                          width="100%"
                        />
                        <Text
                          type="supporting"
                          color="secondary"
                          id={`${row.id}-description`}
                        >
                          {MODE_DESCRIPTIONS[row.mode]}
                        </Text>
                      </VStack>

                      {row.mode === "replace" ?
                        <VStack gap={3}>
                          <TextArea
                            label="Find text"
                            value={row.find}
                            onChange={(find) => updateRow(row.id, { find })}
                            isRequired
                            rows={3}
                            hasSpellCheck={false}
                            isDisabled={isDisabled}
                            status={
                              errors.find ?
                                { type: "error", message: errors.find }
                              : undefined
                            }
                            width="100%"
                          />
                          <TextArea
                            label="Replace with"
                            description="Leave empty to delete the matched text."
                            value={row.replacement}
                            onChange={(replacement) =>
                              updateRow(row.id, { replacement })
                            }
                            isOptional
                            rows={3}
                            hasSpellCheck={false}
                            isDisabled={isDisabled}
                            status={
                              errors.replacement ?
                                { type: "error", message: errors.replacement }
                              : undefined
                            }
                            width="100%"
                          />
                        </VStack>
                      : <TextArea
                          label="System prompt"
                          value={row.prompt}
                          onChange={(prompt) => updateRow(row.id, { prompt })}
                          isOptional={row.mode === "clear"}
                          isRequired={row.mode !== "clear"}
                          rows={5}
                          hasSpellCheck={false}
                          isDisabled={isDisabled}
                          status={
                            errors.prompt ?
                              { type: "error", message: errors.prompt }
                            : undefined
                          }
                          width="100%"
                        />
                      }
                    </VStack>
                  </Card>
                </li>
              )
            })}
          </VStack>
        }

        <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
          <Text type="supporting" color="secondary">
            Up to {MAX_SYSTEM_PROMPT_OVERRIDES} configurations and{" "}
            {MAX_SYSTEM_PROMPT_OVERRIDE_TEXT_LENGTH.toLocaleString("en-US")}{" "}
            characters in total.
          </Text>
          <Button
            ref={addButtonRef}
            label="Add configuration"
            icon={<PlusIcon />}
            variant="secondary"
            isDisabled={isDisabled || atLimit}
            tooltip={
              atLimit ?
                `Maximum of ${MAX_SYSTEM_PROMPT_OVERRIDES} configurations reached.`
              : undefined
            }
            style={{ marginInlineStart: "auto" }}
            onClick={addRow}
          />
        </HStack>
      </VStack>
    </Card>
  )
}
