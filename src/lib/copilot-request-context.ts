import { AsyncLocalStorage } from "node:async_hooks"

import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"

export interface CopilotRequestAttribution {
  agentTaskId?: string
  clientExperimentAssignment?: string
  clientMachineId?: string
  harnessId?: string
  interactionType?: string
  openaiIntent?: string
  parentAgentId?: string
  repositoryHost?: string
  repositoryNwo?: string
  subsystemId?: string
}

const storage = new AsyncLocalStorage<CopilotRequestAttribution>()

const attributionHeaders = {
  agentTaskId: "x-agent-task-id",
  clientExperimentAssignment: "x-copilot-client-exp-assignment-context",
  clientMachineId: "x-client-machine-id",
  harnessId: "copilot-harness-id",
  interactionType: "x-interaction-type",
  openaiIntent: "openai-intent",
  parentAgentId: "x-parent-agent-id",
  repositoryHost: "x-github-repository-host",
  repositoryNwo: "x-github-repository-nwo",
  subsystemId: "copilot-subsystem-id",
} satisfies Record<keyof CopilotRequestAttribution, string>

function sanitizeCopilotRequestAttribution(
  attribution: CopilotRequestAttribution | undefined,
): CopilotRequestAttribution {
  if (!attribution) return {}

  const sanitized: CopilotRequestAttribution = {}
  for (const key of Object.keys(attributionHeaders) as Array<
    keyof CopilotRequestAttribution
  >) {
    const value = sanitizeCopilotHeaderValue(attribution[key])
    if (value) sanitized[key] = value
  }
  return sanitized
}

export function resolveCopilotRequestAttribution(
  headers: Headers,
): CopilotRequestAttribution {
  const attribution: CopilotRequestAttribution = {}
  for (const [key, header] of Object.entries(attributionHeaders) as Array<
    [keyof CopilotRequestAttribution, string]
  >) {
    const value = sanitizeCopilotHeaderValue(headers.get(header))
    if (value) attribution[key] = value
  }
  return attribution
}

export function runWithCopilotRequestAttribution<T>(
  attribution: CopilotRequestAttribution,
  callback: () => T,
): T {
  return storage.run(sanitizeCopilotRequestAttribution(attribution), callback)
}

export function getCopilotRequestAttribution():
  | CopilotRequestAttribution
  | undefined {
  return storage.getStore()
}

export function mergeCopilotRequestAttribution(
  base: CopilotRequestAttribution | undefined,
  override: CopilotRequestAttribution | undefined,
): CopilotRequestAttribution {
  return {
    ...sanitizeCopilotRequestAttribution(base),
    ...sanitizeCopilotRequestAttribution(override),
  }
}
