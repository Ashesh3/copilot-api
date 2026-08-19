import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"

import {
  type CopilotContractEvent,
  recordCopilotContractEvent,
  recordCopilotMessagesBeta,
} from "~/lib/copilot-contract-observability"

function installDiagnosticSpies() {
  const attributes: Record<string, boolean | number | string> = {}
  const debug = spyOn(consola, "debug")
  const breadcrumb = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )
  const activeSpan = spyOn(Sentry, "getActiveSpan").mockReturnValue({
    setAttribute(name: string, value: boolean | number | string) {
      attributes[name] = value
    },
  } as never)

  return {
    attributes,
    breadcrumb,
    debug,
    restore() {
      activeSpan.mockRestore()
      breadcrumb.mockRestore()
      debug.mockRestore()
    },
  }
}

test("records only bounded route and normalization metadata", () => {
  const diagnostics = installDiagnosticSpies()
  try {
    recordCopilotContractEvent({
      kind: "endpoint_route",
      source: "messages",
      target: "/v1/messages",
      translated: false,
      reason: "native",
    })
    recordCopilotContractEvent({
      kind: "request_normalization",
      protocol: "responses",
      classes: ["gpt56_sampling", "empty_tool_controls", "gpt56_sampling"],
    })

    expect(diagnostics.debug.mock.calls).toEqual([
      [
        "[copilot-contract]",
        {
          kind: "endpoint_route",
          source: "messages",
          target: "/v1/messages",
          translated: false,
          reason: "native",
        },
      ],
      [
        "[copilot-contract]",
        {
          kind: "request_normalization",
          protocol: "responses",
          classes: "empty_tool_controls,gpt56_sampling",
          classCount: 2,
        },
      ],
    ])
    expect(diagnostics.breadcrumb.mock.calls).toHaveLength(2)
    expect(diagnostics.breadcrumb.mock.calls[0]?.[0]).toMatchObject({
      category: "copilot-api.contract",
      data: { kind: "endpoint_route" },
      level: "info",
      message: "Copilot endpoint route selected",
    })
    expect(diagnostics.attributes).toEqual({
      "copilot_api.contract.endpoint_route.reason": "native",
      "copilot_api.contract.endpoint_route.source": "messages",
      "copilot_api.contract.endpoint_route.target": "/v1/messages",
      "copilot_api.contract.endpoint_route.translated": false,
      "copilot_api.contract.request_normalization.class_count": 2,
      "copilot_api.contract.request_normalization.classes":
        "empty_tool_controls,gpt56_sampling",
      "copilot_api.contract.request_normalization.protocol": "responses",
    })
  } finally {
    diagnostics.restore()
  }
})

test("never records beta values ids prompts bodies or arbitrary classes", () => {
  const diagnostics = installDiagnosticSpies()
  try {
    recordCopilotContractEvent({
      kind: "messages_beta",
      count: 2,
      beta: "adaptive-thinking-private",
      headers: { authorization: "session-secret" },
      model: "private-model-id",
      prompt: "private-prompt",
    } as CopilotContractEvent)
    recordCopilotMessagesBeta("adaptive-thinking-private,session-secret")
    recordCopilotContractEvent({
      kind: "request_normalization",
      protocol: "chat",
      classes: ["function_parameters", "private-user-class"],
      body: { input: "private-body" },
    } as CopilotContractEvent)

    const output = JSON.stringify({
      attributes: diagnostics.attributes,
      breadcrumbs: diagnostics.breadcrumb.mock.calls,
      logs: diagnostics.debug.mock.calls,
    })
    expect(output).toContain("function_parameters")
    expect(output).toContain('"count":2')
    for (const privateValue of [
      "adaptive-thinking-private",
      "session-secret",
      "private-model-id",
      "private-prompt",
      "private-user-class",
      "private-body",
    ]) {
      expect(output).not.toContain(privateValue)
    }
  } finally {
    diagnostics.restore()
  }
})

test("bounds metadata counts before logging or tracing", () => {
  const diagnostics = installDiagnosticSpies()
  try {
    recordCopilotContractEvent({
      kind: "response_metadata",
      headerCount: Number.MAX_SAFE_INTEGER,
      quotaSnapshotCount: -4,
    })

    expect(diagnostics.debug.mock.calls[0]?.[1]).toEqual({
      kind: "response_metadata",
      headerCount: 65_535,
      quotaSnapshotCount: 0,
    })
    expect(diagnostics.attributes).toMatchObject({
      "copilot_api.contract.response_metadata.header_count": 65_535,
      "copilot_api.contract.response_metadata.quota_snapshot_count": 0,
    })
  } finally {
    diagnostics.restore()
  }
})
