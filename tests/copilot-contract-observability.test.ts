import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"

import {
  type CopilotContractEvent,
  recordCopilotContractEvent,
  recordCopilotMessagesBeta,
  recordCopilotTranslationFindings,
} from "~/lib/copilot-contract-observability"
import {
  createEvaluatedTranslationCheck,
  type EvaluatedTranslationCheck,
} from "~/lib/endpoint-routing"

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

const validRuntimeEvents: Array<Record<string, unknown> & { kind: string }> = [
  {
    kind: "endpoint_route",
    source: "responses",
    target: "/responses",
    translated: false,
    reason: "native",
  },
  {
    kind: "request_normalization",
    protocol: "responses",
    classes: ["json_schema"],
  },
  { kind: "messages_beta", count: 1 },
  { kind: "websocket_continuation", outcome: "new_thread" },
  { kind: "response_metadata", headerCount: 1, quotaSnapshotCount: 0 },
]

function hostileInheritedField(kind: string): string {
  switch (kind) {
    case "endpoint_route": {
      return "source"
    }
    case "request_normalization": {
      return "protocol"
    }
    case "messages_beta": {
      return "count"
    }
    case "websocket_continuation": {
      return "outcome"
    }
    case "response_metadata": {
      return "headerCount"
    }
    default: {
      return "kind"
    }
  }
}

test.each(validRuntimeEvents)(
  "does not inherit hostile __proto__ fields for $kind",
  (validEvent) => {
    const diagnostics = installDiagnosticSpies()
    const privateMarker = `hostile-${validEvent.kind}-proto-private`
    const inheritedField = hostileInheritedField(validEvent.kind)
    const event = { ...validEvent } as Record<string, unknown>
    Reflect.deleteProperty(event, inheritedField)
    Object.defineProperty(event, "__proto__", {
      enumerable: true,
      value: Object.defineProperty({}, inheritedField, {
        get() {
          throw new Error(privateMarker)
        },
      }),
    })

    try {
      expect(() => recordCopilotContractEvent(event as never)).not.toThrow()
      const output = JSON.stringify({
        breadcrumbs: diagnostics.breadcrumb.mock.calls,
        logs: diagnostics.debug.mock.calls,
      })
      expect(output).not.toContain(privateMarker)
    } finally {
      diagnostics.restore()
    }
  },
)

test("records sorted safe translation findings with recomputed cost", () => {
  const diagnostics = installDiagnosticSpies()
  const check = createEvaluatedTranslationCheck([
    { class: "tool_history", severity: "adapted" },
    { class: "content_part", severity: "omitted" },
    { class: "tool_history", severity: "adapted" },
  ])
  try {
    recordCopilotTranslationFindings("responses", "/chat/completions", {
      ...check,
      cost: 197,
    })

    expect(diagnostics.debug.mock.calls).toEqual([
      [
        "[copilot-contract]",
        {
          kind: "translation_findings",
          protocol: "responses",
          target: "/chat/completions",
          findings: "content_part:omitted,tool_history:adapted",
          findingCount: 2,
          cost: 3,
        },
      ],
    ])
    expect(diagnostics.breadcrumb.mock.calls[0]?.[0]).toMatchObject({
      data: {
        findings: "content_part:omitted,tool_history:adapted",
        findingCount: 2,
        cost: 3,
      },
      message: "Copilot translation findings recorded",
    })
    expect(diagnostics.attributes).toMatchObject({
      "copilot_api.contract.translation_findings.protocol": "responses",
      "copilot_api.contract.translation_findings.target": "/chat/completions",
      "copilot_api.contract.translation_findings.findings":
        "content_part:omitted,tool_history:adapted",
      "copilot_api.contract.translation_findings.finding_count": 2,
      "copilot_api.contract.translation_findings.cost": 3,
    })
  } finally {
    diagnostics.restore()
  }
})

test("records fatal translation findings without exposing max-safe cost", () => {
  const diagnostics = installDiagnosticSpies()
  try {
    recordCopilotTranslationFindings(
      "messages",
      "/responses",
      createEvaluatedTranslationCheck([
        { class: "message_shape", severity: "fatal" },
      ]),
    )

    expect(diagnostics.debug.mock.calls[0]?.[1]).toEqual({
      kind: "translation_findings",
      protocol: "messages",
      target: "/responses",
      findings: "message_shape:fatal",
      findingCount: 1,
      fatal: true,
    })
    expect(JSON.stringify(diagnostics.debug.mock.calls)).not.toContain(
      String(Number.MAX_SAFE_INTEGER),
    )
    expect(diagnostics.attributes).toMatchObject({
      "copilot_api.contract.translation_findings.fatal": true,
    })
    expect(diagnostics.attributes).not.toHaveProperty(
      "copilot_api.contract.translation_findings.cost",
    )
  } finally {
    diagnostics.restore()
  }
})

test("translation finding diagnostics no-op only for an empty check", () => {
  const diagnostics = installDiagnosticSpies()
  try {
    const empty = createEvaluatedTranslationCheck([])
    const exact = createEvaluatedTranslationCheck([
      { class: "attachment", severity: "exact" },
    ])
    recordCopilotTranslationFindings("chat", "/chat/completions", empty)
    recordCopilotTranslationFindings("chat", "/chat/completions", exact)

    expect(diagnostics.debug.mock.calls).toHaveLength(1)
    expect(diagnostics.debug.mock.calls[0]?.[1]).toMatchObject({
      findings: "attachment:exact",
      findingCount: 1,
      cost: 0,
    })
  } finally {
    diagnostics.restore()
  }
})

test("bounds translation findings without slicing rendered tokens", () => {
  const diagnostics = installDiagnosticSpies()
  const classes = [
    "attachment",
    "content_part",
    "context_management",
    "message_role",
    "message_shape",
    "reasoning_state",
    "sampling",
    "stateful_controls",
    "token_alias",
    "tool_choice",
    "tool_history",
    "tool_shape",
    "unknown_item",
    "unknown_top_level",
  ] as const
  const findings = [
    ...classes.map((findingClass) => ({
      class: findingClass,
      severity: "omitted" as const,
    })),
    ...classes.map((findingClass) => ({
      class: findingClass,
      severity: "adapted" as const,
    })),
    ...classes.slice(0, 4).map((findingClass) => ({
      class: findingClass,
      severity: "exact" as const,
    })),
    { class: "sampling" as const, severity: "fatal" as const },
  ]
  try {
    recordCopilotTranslationFindings("responses", "/responses", {
      mode: "evaluated",
      findings,
      cost: Number.MAX_SAFE_INTEGER,
      supported: false,
    })

    const data = diagnostics.debug.mock.calls[0]?.[1] as {
      findingCount: number
      findings: string
    }
    const tokens = data.findings.split(",")
    expect(data.findings.length).toBeLessThanOrEqual(256)
    expect(data.findingCount).toBe(tokens.length)
    expect(
      tokens.every((token) =>
        /^[a-z_]+:(?:exact|adapted|omitted)$/.test(token),
      ),
    ).toBe(true)
    expect(data).not.toHaveProperty("fatal")
  } finally {
    diagnostics.restore()
  }
})

test("ignores hostile translation findings without mutation or leakage", () => {
  const diagnostics = installDiagnosticSpies()
  const privateMarker = "private-translation-finding-marker"
  let getterCalls = 0
  const hostileFinding = Object.defineProperties(
    {},
    {
      class: {
        enumerable: true,
        get() {
          getterCalls += 1
          throw new Error(privateMarker)
        },
      },
      severity: { enumerable: true, value: "fatal" },
      value: { enumerable: true, value: privateMarker },
    },
  )
  const ordinaryCheck = {
    mode: "evaluated",
    findings: [
      hostileFinding,
      Object.create({
        class: "message_shape",
        severity: "fatal",
        value: privateMarker,
      }),
      { class: privateMarker, severity: "adapted", value: privateMarker },
      { class: "tool_shape", severity: "adapted" },
    ],
    cost: 245,
    supported: true,
  }
  const before = ordinaryCheck.findings.slice()
  const proxiedCheck = new Proxy(ordinaryCheck, {
    get() {
      getterCalls += 1
      throw new Error(privateMarker)
    },
  })
  try {
    expect(() =>
      recordCopilotTranslationFindings(
        "chat",
        "/responses",
        proxiedCheck as never,
      ),
    ).not.toThrow()
    expect(() =>
      recordCopilotTranslationFindings(
        "chat",
        "/responses",
        ordinaryCheck as never,
      ),
    ).not.toThrow()

    expect(getterCalls).toBe(0)
    expect(ordinaryCheck.findings).toEqual(before)
    const output = JSON.stringify({
      attributes: diagnostics.attributes,
      breadcrumbs: diagnostics.breadcrumb.mock.calls,
      logs: diagnostics.debug.mock.calls,
    })
    expect(output).toContain("tool_shape:adapted")
    expect(output).not.toContain(privateMarker)
    expect(output).not.toContain('"cost":245')
  } finally {
    diagnostics.restore()
  }
})

test("translation finding diagnostics reject nonplain nested containers", () => {
  const diagnostics = installDiagnosticSpies()
  const nonplainFindings = [{ class: "tool_shape", severity: "adapted" }]
  Reflect.setPrototypeOf(nonplainFindings, null)
  class HostileCheck {
    findings = [{ class: "tool_shape", severity: "adapted" }]
  }
  try {
    recordCopilotTranslationFindings(
      "chat",
      "/responses",
      new HostileCheck() as unknown as EvaluatedTranslationCheck,
    )
    recordCopilotContractEvent({
      kind: "translation_findings",
      protocol: "chat",
      target: "/responses",
      check: {
        mode: "evaluated",
        findings: nonplainFindings,
        cost: 1,
        supported: true,
      },
    } as never)

    expect(diagnostics.debug.mock.calls).toHaveLength(0)
  } finally {
    diagnostics.restore()
  }
})

test("translation finding diagnostics skip sparse and accessor entries", () => {
  const diagnostics = installDiagnosticSpies()
  let getterCalls = 0
  const findings: Array<unknown> = Array.from({ length: 3 })
  Object.defineProperty(findings, "1", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("private-accessor-finding")
    },
  })
  findings[2] = { class: "tool_choice", severity: "adapted" }

  try {
    recordCopilotTranslationFindings("chat", "/responses", {
      mode: "evaluated",
      findings,
      cost: 0,
      supported: true,
    } as never)

    expect(getterCalls).toBe(0)
    expect(diagnostics.debug.mock.calls[0]?.[1]).toMatchObject({
      findings: "tool_choice:adapted",
      findingCount: 1,
      cost: 1,
    })
  } finally {
    diagnostics.restore()
  }
})

test.each(validRuntimeEvents)(
  "ignores dangerous and nested hostile values for $kind",
  (validEvent) => {
    const diagnostics = installDiagnosticSpies()
    const privateMarker = `hostile-${validEvent.kind}-nested-private`
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const nestedProxy = new Proxy(
      {},
      {
        get() {
          throw new Error(privateMarker)
        },
      },
    )
    const event = { ...validEvent } as Record<string, unknown>
    Object.defineProperties(event, {
      constructor: { enumerable: true, value: nestedProxy },
      prototype: { enumerable: true, value: revoked.proxy },
      nested: {
        enumerable: true,
        value: Object.defineProperty({}, "private", {
          get() {
            throw new Error(privateMarker)
          },
        }),
      },
      accessor: {
        enumerable: true,
        get() {
          throw new Error(privateMarker)
        },
      },
    })

    try {
      expect(() => recordCopilotContractEvent(event as never)).not.toThrow()
      const output = JSON.stringify({
        breadcrumbs: diagnostics.breadcrumb.mock.calls,
        logs: diagnostics.debug.mock.calls,
      })
      expect(output).not.toContain(privateMarker)
    } finally {
      diagnostics.restore()
    }
  },
)

test.each(validRuntimeEvents)(
  "does not read inherited descriptor value for $kind",
  (validEvent) => {
    const diagnostics = installDiagnosticSpies()
    const privateMarker = `hostile-${validEvent.kind}-descriptor-private`
    let inheritedValueReads = 0
    const event = { ...validEvent } as Record<string, unknown>
    Object.defineProperty(event, "hostileAccessor", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(privateMarker)
      },
    })
    Object.defineProperty(Object.prototype, "value", {
      configurable: true,
      get() {
        inheritedValueReads += 1
        throw new Error(privateMarker)
      },
    })

    try {
      expect(() => recordCopilotContractEvent(event as never)).not.toThrow()
      expect(inheritedValueReads).toBe(0)
      expect(diagnostics.debug.mock.calls).toHaveLength(1)
      const output = JSON.stringify({
        breadcrumbs: diagnostics.breadcrumb.mock.calls,
        logs: diagnostics.debug.mock.calls,
      })
      expect(output).not.toContain(privateMarker)
    } finally {
      Reflect.deleteProperty(Object.prototype, "value")
      diagnostics.restore()
    }
  },
)
