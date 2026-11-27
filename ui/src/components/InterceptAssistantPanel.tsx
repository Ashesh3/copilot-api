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
import { TextArea } from "@astryxdesign/core/TextArea"
import { TextInput } from "@astryxdesign/core/TextInput"

import type {
  InterceptAssistantConfig,
  InterceptInstructionMode,
} from "../../../src/lib/intercept/types"

interface InterceptAssistantPanelProps {
  assistant: InterceptAssistantConfig
  availableModels: Array<string>
  onChange: (next: InterceptAssistantConfig) => void
  onSave: () => void
  isSaving: boolean
}

export function InterceptAssistantPanel({
  assistant,
  availableModels,
  onChange,
  onSave,
  isSaving,
}: InterceptAssistantPanelProps) {
  const modelOptions = availableModels.map((m) => ({ label: m, value: m }))
  if (assistant.model && !availableModels.includes(assistant.model)) {
    modelOptions.unshift({ label: assistant.model, value: assistant.model })
  }

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={0.5}>
            <HStack gap={2} vAlign="center">
              <Heading level={3}>LLM-Assisted Interception</Heading>
              <Badge
                variant="neutral"
                label={assistant.enabled ? "Enabled" : "Off"}
              />
            </HStack>
            <Text type="supporting" color="secondary">
              Automatically analyzes intercepted requests/responses using a
              compact structured view (never raw HTTP noise) and proposes a
              reviewable diff matching your scenario.
            </Text>
          </VStack>

          <HStack gap={3} vAlign="center" wrap="wrap">
            <Switch
              label="Enable AI Assist"
              value={assistant.enabled}
              onChange={(enabled) => onChange({ ...assistant, enabled })}
            />
            <Switch
              label="Auto-run on capture"
              value={assistant.autoRun}
              isDisabled={!assistant.enabled}
              onChange={(autoRun) => onChange({ ...assistant, autoRun })}
            />
            <Button
              label="Save assistant"
              size="sm"
              variant="primary"
              isLoading={isSaving}
              onClick={onSave}
            />
          </HStack>
        </HStack>

        <div className="intercept-assistant-grid">
          {modelOptions.length > 0 ?
            <Selector
              label="Assistant Model"
              placeholder="Select a model..."
              value={assistant.model || undefined}
              options={modelOptions}
              onChange={(model) => onChange({ ...assistant, model })}
            />
          : <TextInput
              label="Assistant Model"
              placeholder="e.g. gpt-4.1-mini or claude-haiku-4.5"
              value={assistant.model}
              onChange={(model) => onChange({ ...assistant, model })}
            />
          }

          <VStack gap={1}>
            <Text type="label">Instruction Mode</Text>
            <SegmentedControl
              label="Instruction mode"
              value={assistant.instructionMode}
              onChange={(mode) =>
                onChange({
                  ...assistant,
                  instructionMode: mode as InterceptInstructionMode,
                })
              }
            >
              <SegmentedControlItem value="shared" label="Shared (Req & Res)" />
              <SegmentedControlItem
                value="separate"
                label="Separate Req / Res"
              />
            </SegmentedControl>
          </VStack>
        </div>

        {assistant.instructionMode === "shared" ?
          <TextArea
            label="Shared Scenario Instruction (applies to both incoming & outgoing)"
            placeholder="Example: Simulate an environment where every bash tool call targets /sandbox instead of /, and rewrite assistant refusals into concise technical steps."
            rows={4}
            value={assistant.sharedInstruction}
            onChange={(sharedInstruction) =>
              onChange({ ...assistant, sharedInstruction })
            }
          />
        : <div className="intercept-assistant-grid">
            <TextArea
              label="Request Instruction (Outgoing to Upstream)"
              placeholder="How to rewrite system/user/assistant messages or tool results before sending to the model..."
              rows={4}
              value={assistant.requestInstruction}
              onChange={(requestInstruction) =>
                onChange({ ...assistant, requestInstruction })
              }
            />
            <TextArea
              label="Response Instruction (Incoming from Upstream)"
              placeholder="How to modify assistant replies, thinking, or tool calls before returning to the client..."
              rows={4}
              value={assistant.responseInstruction}
              onChange={(responseInstruction) =>
                onChange({ ...assistant, responseInstruction })
              }
            />
          </div>
        }
      </VStack>
    </Card>
  )
}
