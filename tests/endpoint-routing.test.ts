import { expect, test } from "bun:test"

import {
  getModelEndpointSupport,
  selectCopilotEndpoint,
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
