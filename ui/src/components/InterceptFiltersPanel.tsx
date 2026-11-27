/* eslint-disable no-nested-ternary */
import { Badge } from "@astryxdesign/core/Badge"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"

import type {
  InterceptFilterCondition,
  InterceptFilterConfig,
  InterceptFilterField,
  InterceptFilterOperator,
} from "../../../src/lib/intercept/types"

import { PlusIcon, Trash2Icon } from "../icons"

interface InterceptFiltersPanelProps {
  filters: InterceptFilterConfig
  onChange: (next: InterceptFilterConfig) => void
  onSave: () => void
  isSaving: boolean
}

const FIELD_OPTIONS: Array<{ label: string; value: InterceptFilterField }> = [
  { label: "Session ID", value: "sessionId" },
  { label: "Model ID", value: "model" },
  { label: "Request Body", value: "requestBody" },
  { label: "Response Body", value: "responseBody" },
  { label: "Endpoint Path", value: "path" },
  { label: "Upstream Provider", value: "upstream" },
  { label: "HTTP Header", value: "header" },
  { label: "Direction (request/response)", value: "direction" },
]

const OPERATOR_OPTIONS: Array<{
  label: string
  value: InterceptFilterOperator
}> = [
  { label: "contains", value: "contains" },
  { label: "not contains", value: "not_contains" },
  { label: "equals", value: "equals" },
  { label: "not equals", value: "not_equals" },
  { label: "starts with", value: "starts_with" },
  { label: "matches regex", value: "regex" },
]

export function InterceptFiltersPanel({
  filters,
  onChange,
  onSave,
  isSaving,
}: InterceptFiltersPanelProps) {
  const addCondition = () => {
    const next: InterceptFilterCondition = {
      id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      enabled: true,
      field: "model",
      operator: "contains",
      value: "",
      caseSensitive: false,
    }
    onChange({
      ...filters,
      enabled: true,
      conditions: [...filters.conditions, next],
    })
  }

  const updateCondition = (
    id: string,
    patch: Partial<InterceptFilterCondition>,
  ) => {
    onChange({
      ...filters,
      conditions: filters.conditions.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    })
  }

  const removeCondition = (id: string) => {
    onChange({
      ...filters,
      conditions: filters.conditions.filter((c) => c.id !== id),
    })
  }

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={0.5}>
            <HStack gap={2} vAlign="center">
              <Heading level={3}>Interception Filters</Heading>
              <Badge
                variant={filters.enabled ? "info" : "neutral"}
                label={
                  filters.enabled ?
                    `${filters.conditions.filter((c) => c.enabled).length} active`
                  : "Intercepting all"
                }
              />
            </HStack>
            <Text type="supporting" color="secondary">
              Only pause requests/responses matching these conditions. Leave
              disabled to intercept all matching traffic.
            </Text>
          </VStack>

          <HStack gap={3} vAlign="center" wrap="wrap">
            <Switch
              label="Enable filters"
              value={filters.enabled}
              onChange={(enabled) => onChange({ ...filters, enabled })}
            />
            <SegmentedControl
              label="Filter match mode"
              value={filters.matchMode}
              onChange={(mode) =>
                onChange({ ...filters, matchMode: mode as "all" | "any" })
              }
            >
              <SegmentedControlItem value="all" label="Match ALL" />
              <SegmentedControlItem value="any" label="Match ANY" />
            </SegmentedControl>
            <Button
              label="Add condition"
              size="sm"
              variant="secondary"
              icon={<PlusIcon />}
              onClick={addCondition}
            />
            <Button
              label="Save filters"
              size="sm"
              variant="primary"
              isLoading={isSaving}
              onClick={onSave}
            />
          </HStack>
        </HStack>

        {filters.conditions.length === 0 ?
          <Text type="supporting" color="secondary">
            No conditions yet. Add conditions to filter by session ID, model ID,
            request/response body, endpoint path, or HTTP header.
          </Text>
        : <VStack gap={2}>
            {filters.conditions.map((cond) => (
              <div key={cond.id} className="intercept-filter-row">
                <Switch
                  label="Enabled"
                  isLabelHidden
                  value={cond.enabled}
                  onChange={(enabled) => updateCondition(cond.id, { enabled })}
                />
                <Selector
                  label="Field"
                  isLabelHidden
                  size="sm"
                  value={cond.field}
                  options={FIELD_OPTIONS}
                  onChange={(val) =>
                    updateCondition(cond.id, {
                      field: val as InterceptFilterField,
                    })
                  }
                />
                {cond.field === "header" ?
                  <TextInput
                    label="Header name"
                    isLabelHidden
                    size="sm"
                    placeholder="Header name (e.g. x-session-id)"
                    value={cond.headerName ?? ""}
                    onChange={(headerName) =>
                      updateCondition(cond.id, { headerName })
                    }
                  />
                : null}
                <Selector
                  label="Operator"
                  isLabelHidden
                  size="sm"
                  value={cond.operator}
                  options={OPERATOR_OPTIONS}
                  onChange={(val) =>
                    updateCondition(cond.id, {
                      operator: val as InterceptFilterOperator,
                    })
                  }
                />
                <TextInput
                  label="Value"
                  isLabelHidden
                  size="sm"
                  placeholder={
                    cond.field === "model" ? "e.g. claude-sonnet-4"
                    : cond.field === "sessionId" ?
                      "Session ID substring or regex"
                    : cond.field === "requestBody" ?
                      "Search text or regex in request"
                    : "Match value..."
                  }
                  value={cond.value}
                  onChange={(value) => updateCondition(cond.id, { value })}
                />
                <Button
                  label="Delete"
                  size="sm"
                  variant="ghost"
                  icon={<Trash2Icon />}
                  onClick={() => removeCondition(cond.id)}
                />
              </div>
            ))}
          </VStack>
        }
      </VStack>
    </Card>
  )
}
