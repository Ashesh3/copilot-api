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

import type { InterceptAssistantConfig } from "../../../src/lib/intercept/types"

interface InterceptAssistantPanelProps {
  assistant: InterceptAssistantConfig
  availableModels: Array<string>
  onChange: (next: InterceptAssistantConfig) => void
}

export function InterceptAssistantPanel({
  assistant,
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
              placeholder="Choose a model"
              value={assistant.model || undefined}
              options={modelOptions}
              onChange={(model) => onChange({ ...assistant, model })}
            />
          : <TextInput
              className="intercept-mono-field"
              label="Model"
              placeholder="gpt-4.1-mini"
              value={assistant.model}
              onChange={(model) => onChange({ ...assistant, model })}
            />
          }
          <div className="intercept-field-group">
            <Text type="label">Instructions</Text>
            <SegmentedControl
              label="Instructions"
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
        </div>

        {assistant.instructionMode === "shared" ?
          <TextArea
            label="Scenario"
            description="Applied to held requests and responses."
            placeholder="Every bash tool call must stay inside /sandbox. Rewrite refusals into concise technical steps."
            rows={5}
            value={assistant.sharedInstruction}
            onChange={(sharedInstruction) =>
              onChange({ ...assistant, sharedInstruction })
            }
          />
        : <div className="intercept-assistant-grid">
            <TextArea
              label="For requests"
              description="Edits before the payload goes upstream."
              placeholder="Rewrite system, user, assistant, and tool messages before they reach the model."
              rows={5}
              value={assistant.requestInstruction}
              onChange={(requestInstruction) =>
                onChange({ ...assistant, requestInstruction })
              }
            />
            <TextArea
              label="For responses"
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
      </VStack>
    </Card>
  )
}
