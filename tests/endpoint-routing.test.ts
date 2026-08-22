import { expect, test } from "bun:test"

import {
  createEvaluatedTranslationCheck,
  type EvaluatedEndpointCandidate,
  getModelEndpointSupport,
  selectEvaluatedCopilotCandidate,
  selectCopilotEndpoint,
  type TranslationFinding,
} from "~/lib/endpoint-routing"

test("treats an unknown model as supporting no Copilot endpoint", () => {
  expect(getModelEndpointSupport(undefined)).toEqual({
    chat: false,
    embeddings: false,
    messages: false,
    responses: false,
    responsesWebSocket: false,
  })
})

test("treats a known model with missing endpoint metadata as Chat only", () => {
  expect(getModelEndpointSupport({})).toEqual({
    chat: true,
    embeddings: false,
    messages: false,
    responses: false,
    responsesWebSocket: false,
  })
})

test("treats explicit empty endpoint metadata as supporting no endpoint", () => {
  expect(getModelEndpointSupport({ supported_endpoints: [] })).toEqual({
    chat: false,
    embeddings: false,
    messages: false,
    responses: false,
    responsesWebSocket: false,
  })
})

test("interprets every advertised inference endpoint independently", () => {
  expect(
    getModelEndpointSupport({
      supported_endpoints: [
        "/responses",
        "ws:/responses",
        "/v1/messages",
        "/embeddings",
      ],
    }),
  ).toEqual({
    chat: false,
    embeddings: true,
    messages: true,
    responses: true,
    responsesWebSocket: true,
  })
})

test("keeps Responses WebSocket support independent from HTTP Responses", () => {
  expect(
    getModelEndpointSupport({ supported_endpoints: ["ws:/responses"] }),
  ).toEqual({
    chat: false,
    embeddings: false,
    messages: false,
    responses: false,
    responsesWebSocket: true,
  })
})

test("selects native first and the first lossless supported fallback", () => {
  const support = getModelEndpointSupport({
    supported_endpoints: ["/responses", "/v1/messages"],
  })
  expect(
    selectCopilotEndpoint({
      source: "messages",
      support,
      candidates: [
        {
          endpoint: "/v1/messages",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
        {
          endpoint: "/responses",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
      ],
    }),
  ).toMatchObject({ target: "/v1/messages", translated: false })
})

test("selects candidates in caller order when earlier endpoints are unusable", () => {
  const support = getModelEndpointSupport({
    supported_endpoints: ["/chat/completions", "/responses", "/v1/messages"],
  })
  expect(
    selectCopilotEndpoint({
      source: "chat",
      support,
      candidates: [
        {
          endpoint: "/responses",
          reason: "payload_requirement",
          check: { supported: false, blockers: ["custom_tool_grammar"] },
        },
        {
          endpoint: "/v1/messages",
          reason: "payload_requirement",
          check: { supported: true, blockers: [] },
        },
        {
          endpoint: "/chat/completions",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
      ],
    }),
  ).toEqual({
    reason: "payload_requirement",
    source: "chat",
    target: "/v1/messages",
    translated: true,
  })
})

test("requires the model to advertise a candidate endpoint", () => {
  const support = getModelEndpointSupport({
    supported_endpoints: ["/chat/completions"],
  })
  expect(
    selectCopilotEndpoint({
      source: "responses",
      support,
      candidates: [
        {
          endpoint: "/v1/messages",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
        {
          endpoint: "/chat/completions",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
      ],
    }),
  ).toMatchObject({ target: "/chat/completions" })
})

test("derives a native route from its source and selected endpoint", () => {
  const support = getModelEndpointSupport({
    supported_endpoints: ["/responses"],
  })
  expect(
    selectCopilotEndpoint({
      source: "responses",
      support,
      candidates: [
        {
          endpoint: "/responses",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
      ],
    }),
  ).toEqual({
    reason: "native",
    source: "responses",
    target: "/responses",
    translated: false,
  })
})

test("does not preserve a native reason for a translated route", () => {
  const support = getModelEndpointSupport({
    supported_endpoints: ["/responses"],
  })
  expect(
    selectCopilotEndpoint({
      source: "chat",
      support,
      candidates: [
        {
          endpoint: "/responses",
          reason: "native" as never,
          check: { supported: true, blockers: [] },
        },
      ],
    }),
  ).toEqual({
    reason: "endpoint_unavailable",
    source: "chat",
    target: "/responses",
    translated: true,
  })
})

test("returns every translation blocker when no candidate is lossless", () => {
  const result = selectCopilotEndpoint({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/v1/messages"],
    }),
    candidates: [
      {
        endpoint: "/v1/messages",
        reason: "endpoint_unavailable",
        check: {
          supported: false,
          blockers: ["opaque_reasoning", "custom_tool_grammar"],
        },
      },
    ],
  })
  expect(result).toEqual({
    blockers: ["opaque_reasoning", "custom_tool_grammar"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })
})

test("deduplicates failure blockers in first-seen order", () => {
  const result = selectCopilotEndpoint({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/chat/completions", "/v1/messages"],
    }),
    candidates: [
      {
        endpoint: "/v1/messages",
        reason: "endpoint_unavailable",
        check: {
          supported: false,
          blockers: ["opaque_reasoning", "custom_tool_grammar"],
        },
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        check: {
          supported: false,
          blockers: ["custom_tool_grammar", "hosted_web_search"],
        },
      },
    ],
  })
  expect(result).toEqual({
    blockers: ["opaque_reasoning", "custom_tool_grammar", "hosted_web_search"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })
})

test("ignores blockers from endpoint candidates the model does not advertise", () => {
  const result = selectCopilotEndpoint({
    source: "chat",
    support: getModelEndpointSupport({
      supported_endpoints: ["/responses"],
    }),
    candidates: [
      {
        endpoint: "/v1/messages",
        reason: "endpoint_unavailable",
        check: {
          supported: false,
          blockers: ["custom_tool_grammar"],
        },
      },
      {
        endpoint: "/responses",
        reason: "endpoint_unavailable",
        check: {
          supported: false,
          blockers: ["thinking_budget", "thinking_budget"],
        },
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        check: {
          supported: false,
          blockers: ["message_content_part"],
        },
      },
    ],
  })

  expect(result).toEqual({
    blockers: ["thinking_budget"],
    code: "endpoint_translation_unsupported",
    source: "chat",
  })
})

test("creates immutable evaluated checks from first-seen unique finding pairs", () => {
  const input: Array<TranslationFinding> = [
    { class: "content_part", severity: "adapted" },
    { class: "content_part", severity: "adapted" },
    { class: "content_part", severity: "omitted" },
    { class: "tool_history", severity: "exact" },
  ]

  const check = createEvaluatedTranslationCheck(input)
  input[0] = { class: "sampling", severity: "fatal" }

  expect(check).toEqual({
    mode: "evaluated",
    findings: [
      { class: "content_part", severity: "adapted" },
      { class: "content_part", severity: "omitted" },
      { class: "tool_history", severity: "exact" },
    ],
    cost: 3,
    supported: true,
  })
  expect(Object.isFrozen(check)).toBe(true)
  expect(Object.isFrozen(check.findings)).toBe(true)
  expect(check.findings.every((finding) => Object.isFrozen(finding))).toBe(true)
  expect(() =>
    (check.findings as Array<TranslationFinding>).push({
      class: "sampling",
      severity: "fatal",
    }),
  ).toThrow()
})

test("ignores malformed evaluated findings without invoking accessors", () => {
  const privateMarker = "private-evaluated-finding"
  let getterCalls = 0
  const inherited = Object.create({
    class: "sampling",
    severity: "fatal",
  }) as TranslationFinding
  const accessor = Object.defineProperties(
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
    },
  )
  const proxied = new Proxy(
    { class: "sampling", severity: "fatal" },
    {
      get() {
        getterCalls += 1
        throw new Error(privateMarker)
      },
    },
  )
  const runtimeFindings: Array<unknown> = [
    inherited,
    accessor,
    proxied,
    { class: privateMarker, severity: "adapted" },
    { class: "sampling", severity: privateMarker },
  ]
  Object.defineProperty(runtimeFindings, "5", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error(privateMarker)
    },
  })
  runtimeFindings[6] = { class: "tool_shape", severity: "adapted" }

  expect(createEvaluatedTranslationCheck(runtimeFindings as never)).toEqual({
    mode: "evaluated",
    findings: [{ class: "tool_shape", severity: "adapted" }],
    cost: 1,
    supported: true,
  })
  expect(getterCalls).toBe(0)
})

test("inspects only 32 raw findings and makes retained fatal findings terminal", () => {
  const first32 = Array.from({ length: 32 }, () => ({
    class: "content_part" as const,
    severity: "adapted" as const,
  }))
  const ignoredFatal = createEvaluatedTranslationCheck([
    ...first32,
    { class: "sampling", severity: "fatal" },
  ])
  const retainedFatal = createEvaluatedTranslationCheck([
    { class: "sampling", severity: "fatal" },
    ...first32,
  ])

  expect(ignoredFatal).toMatchObject({ cost: 1, supported: true })
  expect(ignoredFatal.findings).toHaveLength(1)
  expect(retainedFatal).toMatchObject({
    cost: Number.MAX_SAFE_INTEGER,
    supported: false,
  })
})

test("computes the reachable maximum evaluated finding cost", () => {
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
  const check = createEvaluatedTranslationCheck([
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
  ])

  expect(check.findings).toHaveLength(32)
  expect(check.cost).toBe(42)
})

test("evaluated selection prefers native and returns exact candidate references", () => {
  const translatedPayload = { body: "translated" }
  const nativePayload = { body: "native" }
  const translated: EvaluatedEndpointCandidate<
    "/chat/completions",
    typeof translatedPayload
  > = {
    endpoint: "/chat/completions",
    reason: "endpoint_unavailable",
    payload: translatedPayload,
    check: createEvaluatedTranslationCheck([]),
  }
  const native: EvaluatedEndpointCandidate<"/responses", typeof nativePayload> =
    {
      endpoint: "/responses",
      reason: "payload_requirement",
      payload: nativePayload,
      check: createEvaluatedTranslationCheck([
        { class: "sampling", severity: "omitted" },
      ]),
    }

  const result = selectEvaluatedCopilotCandidate({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/chat/completions", "/responses"],
    }),
    candidates: [translated, native],
  })

  expect("candidate" in result).toBe(true)
  if (!("candidate" in result)) throw new Error("expected evaluated selection")
  expect(result.candidate).toBe(native)
  expect(result.candidate.payload).toBe(nativePayload)
  expect(result.decision).toEqual({
    reason: "native",
    source: "responses",
    target: "/responses",
    translated: false,
  })
})

test("evaluated selection ranks translated cost with caller-order ties", () => {
  const high = {
    endpoint: "/chat/completions",
    reason: "payload_requirement",
    payload: { name: "high" },
    check: createEvaluatedTranslationCheck([
      { class: "sampling", severity: "omitted" },
    ]),
  } as const
  const firstLow = {
    endpoint: "/responses",
    reason: "endpoint_unavailable",
    payload: { name: "first-low" },
    check: createEvaluatedTranslationCheck([
      { class: "tool_shape", severity: "adapted" },
    ]),
  } as const
  const secondLow = {
    endpoint: "/chat/completions",
    reason: "payload_requirement",
    payload: { name: "second-low" },
    check: createEvaluatedTranslationCheck([
      { class: "content_part", severity: "adapted" },
    ]),
  } as const

  const result = selectEvaluatedCopilotCandidate({
    source: "messages",
    support: getModelEndpointSupport({
      supported_endpoints: ["/chat/completions", "/responses"],
    }),
    candidates: [high, firstLow, secondLow],
  })

  expect("candidate" in result && result.candidate).toBe(firstLow)
})

test("evaluated advisory candidates beat fatal candidates", () => {
  const advisory = {
    endpoint: "/responses",
    reason: "payload_requirement",
    payload: { name: "advisory" },
    check: createEvaluatedTranslationCheck([
      { class: "sampling", severity: "omitted" },
    ]),
  } as const
  const fatal = {
    endpoint: "/v1/messages",
    reason: "endpoint_unavailable",
    payload: { name: "fatal" },
    check: createEvaluatedTranslationCheck([
      { class: "message_shape", severity: "fatal" },
    ]),
  } as const

  const result = selectEvaluatedCopilotCandidate({
    source: "chat",
    support: getModelEndpointSupport({
      supported_endpoints: ["/responses", "/v1/messages"],
    }),
    candidates: [fatal, advisory],
  })

  expect("candidate" in result && result.candidate).toBe(advisory)
})

test("evaluated selection ignores unadvertised and fatal native candidates", () => {
  const translated = {
    endpoint: "/responses",
    reason: "endpoint_unavailable",
    payload: { name: "translated" },
    check: createEvaluatedTranslationCheck([
      { class: "sampling", severity: "adapted" },
    ]),
  } as const
  const nativeFatal = {
    endpoint: "/chat/completions",
    reason: "payload_requirement",
    payload: { name: "native-fatal" },
    check: createEvaluatedTranslationCheck([
      { class: "message_shape", severity: "fatal" },
    ]),
  } as const
  const unadvertised = {
    endpoint: "/v1/messages",
    reason: "payload_requirement",
    payload: { name: "unadvertised" },
    check: createEvaluatedTranslationCheck([]),
  } as const

  const result = selectEvaluatedCopilotCandidate({
    source: "chat",
    support: getModelEndpointSupport({ supported_endpoints: ["/responses"] }),
    candidates: [unadvertised, nativeFatal, translated],
  })

  expect("candidate" in result && result.candidate).toBe(translated)
})

test("evaluated failures include only advertised fatal classes", () => {
  const result = selectEvaluatedCopilotCandidate({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/chat/completions", "/v1/messages"],
    }),
    candidates: [
      {
        endpoint: "/v1/messages",
        reason: "endpoint_unavailable",
        payload: {},
        check: createEvaluatedTranslationCheck([
          { class: "message_shape", severity: "fatal" },
          { class: "sampling", severity: "omitted" },
        ]),
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        payload: {},
        check: createEvaluatedTranslationCheck([
          { class: "tool_history", severity: "fatal" },
          { class: "message_shape", severity: "fatal" },
        ]),
      },
      {
        endpoint: "/responses",
        reason: "endpoint_unavailable",
        payload: {},
        check: createEvaluatedTranslationCheck([
          { class: "unknown_item", severity: "fatal" },
        ]),
      },
    ],
  })

  expect(result).toEqual({
    blockers: ["message_shape", "tool_history"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })
})
