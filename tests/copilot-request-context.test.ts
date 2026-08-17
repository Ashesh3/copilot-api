import { expect, test } from "bun:test"

import {
  getCopilotRequestAttribution,
  mergeCopilotRequestAttribution,
  resolveCopilotRequestAttribution,
  runWithCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"

test("resolves only the reviewed attribution headers", () => {
  const headers = new Headers({
    "x-agent-task-id": "task-123",
    "x-parent-agent-id": "parent-456",
    "x-client-machine-id": "machine-abc",
    "x-github-repository-nwo": "owner/repo",
    "x-github-repository-host": "github.example",
    "copilot-harness-id": "copilot",
    "copilot-subsystem-id": "cli",
    "openai-intent": "conversation-agent",
    "x-copilot-client-exp-assignment-context": "client_flight:1;",
    "x-unreviewed-header": "must-not-pass",
  })
  expect(resolveCopilotRequestAttribution(headers)).toEqual({
    agentTaskId: "task-123",
    parentAgentId: "parent-456",
    clientMachineId: "machine-abc",
    repositoryNwo: "owner/repo",
    repositoryHost: "github.example",
    harnessId: "copilot",
    subsystemId: "cli",
    openaiIntent: "conversation-agent",
    clientExperimentAssignment: "client_flight:1;",
  })
})

test("drops blank oversized and control-character attribution values", () => {
  const headers = new Headers()
  headers.set("x-agent-task-id", " ")
  headers.set("x-parent-agent-id", "x".repeat(1025))
  expect(resolveCopilotRequestAttribution(headers)).toEqual({})
  expect(sanitizeCopilotHeaderValue("machine\ninvalid")).toBeUndefined()
})

test("isolates overlapping request attribution scopes", async () => {
  const observed = await Promise.all([
    runWithCopilotRequestAttribution({ agentTaskId: "one" }, async () => {
      await Promise.resolve()
      return getCopilotRequestAttribution()?.agentTaskId
    }),
    runWithCopilotRequestAttribution({ agentTaskId: "two" }, async () => {
      await Promise.resolve()
      return getCopilotRequestAttribution()?.agentTaskId
    }),
  ])
  expect(observed).toEqual(["one", "two"])
})

test("merges sanitized explicit attribution over request attribution", () => {
  expect(
    mergeCopilotRequestAttribution(
      { agentTaskId: "request-task", parentAgentId: "request-parent" },
      { agentTaskId: " option-task ", parentAgentId: "invalid\nparent" },
    ),
  ).toEqual({ agentTaskId: "option-task", parentAgentId: "request-parent" })
})
