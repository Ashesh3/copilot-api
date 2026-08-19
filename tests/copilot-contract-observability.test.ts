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

test("drops whole normalization tokens instead of slicing partial values", () => {
  const diagnostics = installDiagnosticSpies()
  try {
    recordCopilotContractEvent({
      kind: "request_normalization",
      protocol: "responses",
      classes: [
        "unsupported_sampling",
        "stateless_controls",
        "reasoning_defaults",
        "max_output_tokens",
        "json_schema",
        "json_object_instruction",
        "gpt56_sampling",
        "gateway_only_fields",
        "function_parameters",
        "encrypted_reasoning_include",
        "empty_tool_controls",
        "deprecated_functions",
        "deprecated_function_call",
        "cache_control",
      ],
    })

    expect(diagnostics.debug.mock.calls[0]?.[1]).toEqual({
      kind: "request_normalization",
      protocol: "responses",
      classes:
        "cache_control,deprecated_function_call,deprecated_functions,empty_tool_controls,encrypted_reasoning_include,function_parameters,gateway_only_fields,gpt56_sampling,json_object_instruction,json_schema,max_output_tokens,reasoning_defaults,stateless_controls",
      classCount: 13,
    })
  } finally {
    diagnostics.restore()
  }
})

test("ignores hostile runtime events without throwing or leaking", () => {
  const diagnostics = installDiagnosticSpies()
  const privateMarker = "hostile-contract-private-marker"
  let getterCalls = 0
  const hostile = new Proxy(
    {
      get kind() {
        getterCalls += 1
        throw new Error(privateMarker)
      },
    },
    {
      ownKeys() {
        throw new Error(privateMarker)
      },
    },
  )

  try {
    expect(() => recordCopilotContractEvent(hostile as never)).not.toThrow()
    expect(() =>
      recordCopilotContractEvent({
        kind: "endpoint_route",
        source: privateMarker,
        target: privateMarker,
        translated: privateMarker,
        reason: privateMarker,
      } as never),
    ).not.toThrow()
    expect(() =>
      recordCopilotContractEvent({
        kind: "request_normalization",
        protocol: privateMarker,
        classes: new Proxy([], {
          get() {
            throw new Error(privateMarker)
          },
        }),
      } as never),
    ).not.toThrow()
    expect(() =>
      recordCopilotContractEvent({
        kind: "websocket_continuation",
        outcome: privateMarker,
      } as never),
    ).not.toThrow()
    expect(() =>
      recordCopilotContractEvent({
        kind: "messages_beta",
        count: privateMarker,
      } as never),
    ).not.toThrow()
    expect(() =>
      recordCopilotContractEvent({
        kind: "response_metadata",
        headerCount: privateMarker,
        quotaSnapshotCount: privateMarker,
      } as never),
    ).not.toThrow()

    const output = JSON.stringify({
      breadcrumbs: diagnostics.breadcrumb.mock.calls,
      logs: diagnostics.debug.mock.calls,
    })
    expect(output).not.toContain(privateMarker)
    expect(getterCalls).toBeLessThanOrEqual(1)
  } finally {
    diagnostics.restore()
  }
})

test.each([
  {
    kind: "request_normalization",
    protocol: "responses",
    classes: ["json_schema"],
  },
  {
    kind: "endpoint_route",
    source: "responses",
    target: "/responses",
    translated: false,
    reason: "native",
  },
  { kind: "messages_beta", count: 1 },
  { kind: "websocket_continuation", outcome: "new_thread" },
  { kind: "response_metadata", headerCount: 1, quotaSnapshotCount: 0 },
])("ignores hostile array-like property for $kind", (event) => {
  const diagnostics = installDiagnosticSpies()
  const privateMarker = `hostile-${event.kind}-array-private`
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  const hostile = {
    ...event,
    classes: revoked.proxy,
    count: revoked.proxy,
    headerCount: revoked.proxy,
    quotaSnapshotCount: revoked.proxy,
    translated: revoked.proxy,
  }

  try {
    expect(() => recordCopilotContractEvent(hostile as never)).not.toThrow()
    const output = JSON.stringify({
      breadcrumbs: diagnostics.breadcrumb.mock.calls,
      logs: diagnostics.debug.mock.calls,
    })
    expect(output).not.toContain(privateMarker)
  } finally {
    diagnostics.restore()
  }
})
