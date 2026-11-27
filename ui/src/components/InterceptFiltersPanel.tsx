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
import { IconAction } from "./common"

interface InterceptFiltersPanelProps {
  filters: InterceptFilterConfig
  onChange: (next: InterceptFilterConfig) => void
}

const FIELD_OPTIONS: Array<{ label: string; value: InterceptFilterField }> = [
  { label: "Session ID", value: "sessionId" },
  { label: "Model", value: "model" },
  { label: "Request body", value: "requestBody" },
  { label: "Response body", value: "responseBody" },
  { label: "Endpoint path", value: "path" },
  { label: "Upstream", value: "upstream" },
  { label: "Header", value: "header" },
  { label: "Direction", value: "direction" },
]

const OPERATOR_OPTIONS: Array<{
  label: string
  value: InterceptFilterOperator
}> = [
  { label: "contains", value: "contains" },
  { label: "doesn't contain", value: "not_contains" },
  { label: "equals", value: "equals" },
  { label: "doesn't equal", value: "not_equals" },
  { label: "starts with", value: "starts_with" },
  { label: "matches regex", value: "regex" },
]

const VALUE_PLACEHOLDER: Record<InterceptFilterField, string> = {
  sessionId: "Session ID",
  model: "claude-sonnet-4",
  requestBody: "Text in the request",
  responseBody: "Text in the response",
  path: "/v1/messages",
  upstream: "copilot or custom:<provider>",
  header: "Header value",
  direction: "request or response",
}

export function InterceptFiltersPanel({
  filters,
  onChange,
}: InterceptFiltersPanelProps) {
  const updateCondition = (
    id: string,
    patch: Partial<InterceptFilterCondition>,
  ) => {
    onChange({
      ...filters,
      conditions: filters.conditions.map((condition) =>
        condition.id === id ? { ...condition, ...patch } : condition,
      ),
    })
  }

  const addCondition = () => {
    onChange({
      ...filters,
      enabled: true,
      conditions: [
        ...filters.conditions,
        {
          id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          enabled: true,
          field: "model",
          operator: "contains",
          value: "",
          caseSensitive: false,
        },
      ],
    })
  }

  return (
    <Card>
      <VStack gap={3}>
        <div className="intercept-settings-bar">
          <VStack gap={0.5}>
            <Heading level={3}>Filters</Heading>
            <Text type="supporting">
              Hold only traffic that matches. With filters off, everything in
              the capture direction is held.
            </Text>
          </VStack>
          <HStack gap={3} vAlign="center">
            <SegmentedControl
              label="Match mode"
              size="sm"
              value={filters.matchMode}
              onChange={(mode) =>
                onChange({
                  ...filters,
                  matchMode: mode === "any" ? "any" : "all",
                })
              }
            >
              <SegmentedControlItem value="all" label="Match all" />
              <SegmentedControlItem value="any" label="Match any" />
            </SegmentedControl>
            <Switch
              label="Filters on"
              value={filters.enabled}
              onChange={(enabled) => onChange({ ...filters, enabled })}
            />
          </HStack>
        </div>

        {filters.conditions.length === 0 ?
          <Text type="supporting">
            No conditions yet. Add one to hold, for example, a single session or
            model.
          </Text>
        : <VStack gap={2}>
            {filters.conditions.map((condition) => (
              <div
                key={condition.id}
                className={
                  condition.field === "header" ?
                    "intercept-filter-row has-header"
                  : "intercept-filter-row"
                }
              >
                <Switch
                  label="Condition on"
                  isLabelHidden
                  value={condition.enabled}
                  onChange={(enabled) =>
                    updateCondition(condition.id, { enabled })
                  }
                />
                <Selector
                  label="Field"
                  isLabelHidden
                  size="sm"
                  value={condition.field}
                  options={FIELD_OPTIONS}
                  onChange={(value) =>
                    updateCondition(condition.id, {
                      field: value as InterceptFilterField,
                    })
                  }
                />
                {condition.field === "header" ?
                  <TextInput
                    className="intercept-mono-field"
                    label="Header name"
                    isLabelHidden
                    size="sm"
                    placeholder="x-session-id"
                    value={condition.headerName ?? ""}
                    onChange={(headerName) =>
                      updateCondition(condition.id, { headerName })
                    }
                  />
                : null}
                <Selector
                  label="Operator"
                  isLabelHidden
                  size="sm"
                  value={condition.operator}
                  options={OPERATOR_OPTIONS}
                  onChange={(value) =>
                    updateCondition(condition.id, {
                      operator: value as InterceptFilterOperator,
                    })
                  }
                />
                <TextInput
                  className="intercept-mono-field"
                  label="Value"
                  isLabelHidden
                  size="sm"
                  placeholder={VALUE_PLACEHOLDER[condition.field]}
                  value={condition.value}
                  onChange={(value) => updateCondition(condition.id, { value })}
                />
                <IconAction
                  label="Remove condition"
                  icon={<Trash2Icon />}
                  onClick={() =>
                    onChange({
                      ...filters,
                      conditions: filters.conditions.filter(
                        (entry) => entry.id !== condition.id,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </VStack>
        }

        <div>
          <Button
            label="Add condition"
            size="sm"
            variant="secondary"
            icon={<PlusIcon />}
            onClick={addCondition}
          />
        </div>
      </VStack>
    </Card>
  )
}
