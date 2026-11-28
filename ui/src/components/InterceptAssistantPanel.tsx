import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

import type {
  InterceptAssistantConfig,
  InterceptAssistantEffort,
  InterceptAutopilot,
  InterceptPhase,
} from "../../../src/lib/intercept/types"

const EFFORT_LABELS: Record<InterceptAssistantEffort, string> = {
  default: "Model default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

const EFFORT_OPTIONS = (
  Object.entries(EFFORT_LABELS) as Array<[InterceptAssistantEffort, string]>
).map(([value, label]) => ({ value, label }))

const MODEL_DESCRIPTION = "Runs as its own request; model fallbacks apply."

const AUTOPILOT_PHASES: Record<InterceptAutopilot, Array<InterceptPhase>> = {
  off: [],
  request: ["request"],
  response: ["response"],
  both: ["request", "response"],
}

function instructionFor(
  assistant: InterceptAssistantConfig,
  phase: InterceptPhase,
): string {
  if (assistant.instructionMode === "shared") return assistant.sharedInstruction
  return phase === "request" ?
      assistant.requestInstruction
    : assistant.responseInstruction
}

/** What Autopilot still needs before it can act, mirroring the engine's checks. */
function autopilotGaps(assistant: InterceptAssistantConfig): Array<string> {
  if (assistant.autopilot === "off") return []
  const gaps: Array<string> = []
  if (!assistant.model.trim()) gaps.push("a model")
  const missing = AUTOPILOT_PHASES[assistant.autopilot].filter(
    (phase) => !instructionFor(assistant, phase).trim(),
  )
  if (missing.length > 0) {
    gaps.push(
      `a user message for ${missing.map((phase) => `${phase}s`).join(" and ")}`,
    )
  }
  return gaps
}

/** Built-in assistant prompts served by `GET /dashboard/api/intercept`. */
export interface InterceptAssistantDefaults {
  /** Default operator-editable system prompt. */
  systemPrompt: string
  /** Reply-format contract the server always appends to the system prompt. */
  responseFormat: string
}

/** Server limit for `assistant.systemPrompt`. */
const SYSTEM_PROMPT_MAX_LENGTH = 16_000

interface InterceptAssistantPanelProps {
  assistant: InterceptAssistantConfig
  assistantDefaults: InterceptAssistantDefaults
  availableModels: Array<string>
  onChange: (next: InterceptAssistantConfig) => void
}

export function InterceptAssistantPanel({
  assistant,
  assistantDefaults,
  availableModels,
  onChange,
}: InterceptAssistantPanelProps) {
  const modelOptions = availableModels.map((model) => ({
    label: model,
    value: model,
  }))
  if (assistant.model && !availableModels.includes(assistant.model)) {
    modelOptions.unshift({ label: assistant.model, value: assistant.model })
  }
  const gaps = assistant.enabled ? autopilotGaps(assistant) : []

  return (
    <Card>
      <VStack gap={4}>
        <div className="intercept-settings-bar">
          <VStack gap={0.5}>
            <Heading level={3}>Assistant</Heading>
            <Text type="supporting">
              Reads each held item as structured messages, never the raw HTTP
              payload, and proposes edits you review before forwarding.
            </Text>
          </VStack>
          <HStack gap={4} vAlign="center" wrap="wrap">
            <Switch
              label="Assistant on"
              value={assistant.enabled}
              onChange={(enabled) => onChange({ ...assistant, enabled })}
            />
            <Switch
              label="Run on every held item"
              value={assistant.autoRun}
              isDisabled={!assistant.enabled}
              onChange={(autoRun) => onChange({ ...assistant, autoRun })}
            />
          </HStack>
        </div>

        <div className="intercept-assistant-grid">
          {modelOptions.length > 0 ?
            <Selector
              label="Model"
              description={MODEL_DESCRIPTION}
              placeholder="Choose a model"
              value={assistant.model || undefined}
              options={modelOptions}
              onChange={(model) => onChange({ ...assistant, model })}
            />
          : <TextInput
              className="intercept-mono-field"
              label="Model"
              description={MODEL_DESCRIPTION}
              placeholder="gpt-4.1-mini"
              value={assistant.model}
              onChange={(model) => onChange({ ...assistant, model })}
            />
          }
          <Selector
            label="Reasoning effort"
            description="Lower is faster. Clamped to the levels the model supports."
            value={assistant.reasoningEffort}
            options={EFFORT_OPTIONS}
            onChange={(value) => {
              const option = EFFORT_OPTIONS.find(
                (entry) => entry.value === value,
              )
              if (option) {
                onChange({ ...assistant, reasoningEffort: option.value })
              }
            }}
          />
        </div>

        <div className="intercept-assistant-section">
          <TextArea
            label="System prompt"
            description="The assistant's role and editing style; blank uses the default. The reply format below is always appended to it."
            rows={8}
            maxLength={SYSTEM_PROMPT_MAX_LENGTH}
            value={assistant.systemPrompt}
            onChange={(systemPrompt) =>
              onChange({ ...assistant, systemPrompt })
            }
          />
          <HStack>
            <Button
              label="Reset to default"
              size="sm"
              variant="ghost"
              isDisabled={
                assistant.systemPrompt === assistantDefaults.systemPrompt
              }
              onClick={() =>
                onChange({
                  ...assistant,
                  systemPrompt: assistantDefaults.systemPrompt,
                })
              }
            />
          </HStack>
          <Collapsible
            defaultIsOpen={false}
            trigger="Reply format (always appended, read-only)"
          >
            <pre className="intercept-assistant-format">
              {assistantDefaults.responseFormat}
            </pre>
          </Collapsible>
        </div>

        <div className="intercept-assistant-section">
          <div className="intercept-field-group">
            <Text type="label">User message</Text>
            <Text type="supporting">
              Your scenario for the assistant. The held item&apos;s structured
              view is appended after it.
            </Text>
            <SegmentedControl
              label="User message"
              value={assistant.instructionMode}
              onChange={(mode) =>
                onChange({
                  ...assistant,
                  instructionMode: mode === "separate" ? "separate" : "shared",
                })
              }
            >
              <SegmentedControlItem value="shared" label="One for both" />
              <SegmentedControlItem
                value="separate"
                label="Separate per direction"
              />
            </SegmentedControl>
          </div>

          {assistant.instructionMode === "shared" ?
            <TextArea
              label="User message"
              isLabelHidden
              description="Sent for held requests and responses."
              placeholder="Every bash tool call must stay inside /sandbox. Rewrite refusals into concise technical steps."
              rows={5}
              value={assistant.sharedInstruction}
              onChange={(sharedInstruction) =>
                onChange({ ...assistant, sharedInstruction })
              }
            />
          : <div className="intercept-assistant-grid">
              <TextArea
                label="User message for requests"
                description="Edits before the payload goes upstream."
                placeholder="Rewrite system, user, assistant, and tool messages before they reach the model."
                rows={5}
                value={assistant.requestInstruction}
                onChange={(requestInstruction) =>
                  onChange({ ...assistant, requestInstruction })
                }
              />
              <TextArea
                label="User message for responses"
                description="Edits before the reply reaches the client."
                placeholder="Change replies, thinking, or tool calls before the client sees them."
                rows={5}
                value={assistant.responseInstruction}
                onChange={(responseInstruction) =>
                  onChange({ ...assistant, responseInstruction })
                }
              />
            </div>
          }
        </div>

        <div className="intercept-autopilot">
          <div className="intercept-field-group">
            <Text type="label">Autopilot</Text>
            <Text type="supporting">
              In these directions the assistant runs on every newly held item,
              its changes are applied, and the item is forwarded without waiting
              for you. Items already in the queue, and any the assistant fails
              on, stay with you.
            </Text>
            <SegmentedControl
              label="Autopilot"
              value={assistant.autopilot}
              isDisabled={!assistant.enabled}
              disabledMessage="Turn the assistant on to use Autopilot"
              onChange={(value) =>
                onChange({
                  ...assistant,
                  autopilot: value as InterceptAutopilot,
                })
              }
            >
              <SegmentedControlItem value="off" label="Off" />
              <SegmentedControlItem value="request" label="Requests" />
              <SegmentedControlItem value="response" label="Responses" />
              <SegmentedControlItem value="both" label="Both" />
            </SegmentedControl>
          </div>
          {gaps.length > 0 ?
            <Banner
              status="warning"
              title="Autopilot can't run yet"
              description={`Add ${gaps.join(" and ")}. Until then, items stay held for you.`}
            />
          : null}
        </div>
      </VStack>
    </Card>
  )
}
