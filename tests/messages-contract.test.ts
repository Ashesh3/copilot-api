/* eslint-disable max-lines -- exhaustive hostile-safe Messages contract coverage */
import { expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import {
  asAnthropicUnknownContentType,
  asAnthropicUnknownRole,
  type AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"
import {
  canonicalizeAnthropicBeta,
  isAnthropicBetaIdentifier,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
  validateAnthropicRequestHeaderOptions,
} from "~/services/copilot/messages-contract"

function getOptionalHeaderField(
  param: "anthropic_beta" | "anthropic_version" | "model_provider_preference",
): "anthropicBeta" | "anthropicVersion" | "modelProviderPreference" {
  switch (param) {
    case "anthropic_beta": {
      return "anthropicBeta"
    }
    case "anthropic_version": {
      return "anthropicVersion"
    }
    case "model_provider_preference": {
      return "modelProviderPreference"
    }
    default: {
      throw new Error("Unexpected optional header field")
    }
  }
}

function expectFixedBodyError(action: () => unknown, marker: string): void {
  try {
    action()
    throw new Error("Expected Messages body validation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(error).toHaveProperty("response.status", 400)
    expect(error).toHaveProperty("clientBody.type", "error")
    expect(error).toHaveProperty(
      "clientBody.error.type",
      "invalid_request_error",
    )
    expect(error).toHaveProperty(
      "clientBody.error.message",
      "The Messages request body must contain only plain JSON values.",
    )
    expect(error).toHaveProperty("clientBody.error.code", "invalid_type")
    expect(error).toHaveProperty("clientBody.error.param", "body")
    expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
      marker,
    )
    expect((error as Error).message).not.toContain(marker)
  }
}

test("canonicalizes beta whitespace and duplicates without renaming ids", () => {
  expect(
    canonicalizeAnthropicBeta(
      " interleaved-thinking-2025-05-14,claude-code-20250219, interleaved-thinking-2025-05-14 ",
    ),
  ).toBe("interleaved-thinking-2025-05-14,claude-code-20250219")
})

test("accepts only visible ASCII HTTP-token beta identifiers", () => {
  expect(isAnthropicBetaIdentifier("interleaved-thinking-2025-05-14")).toBe(
    true,
  )
  expect(isAnthropicBetaIdentifier("beta_feature.v2")).toBe(true)
  expect(isAnthropicBetaIdentifier("beta feature")).toBe(false)
  expect(isAnthropicBetaIdentifier("beta/version")).toBe(false)
  expect(isAnthropicBetaIdentifier("unicode-βeta")).toBe(false)
  expect(isAnthropicBetaIdentifier("latin-é")).toBe(false)
  expect(isAnthropicBetaIdentifier("beta\u007fvalue")).toBe(false)
  expect(isAnthropicBetaIdentifier("bad\u0001beta")).toBe(false)
})

test("deduplicates beta identifiers before enforcing the final byte limit", () => {
  const beta = "advanced-tool-use-2025-11-20"
  expect(canonicalizeAnthropicBeta(Array(80).fill(beta).join(","))).toBe(beta)
})

test("trims only comma-separator whitespace and rejects invalid segments", () => {
  expect(canonicalizeAnthropicBeta(" beta-one , beta-two ")).toBe(
    "beta-one,beta-two",
  )
  expect(canonicalizeAnthropicBeta("beta-one,,beta-two")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("beta-one beta-two")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("safe-beta,bad\u0001beta")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("safe-beta,unicode-βeta")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("safe-beta,latin-é")).toBeUndefined()
})

test("rejects oversized canonical beta output", () => {
  expect(
    canonicalizeAnthropicBeta(
      Array.from({ length: 180 }, (_, index) => `beta-feature-${index}`).join(
        ",",
      ),
    ),
  ).toBeUndefined()
})

test("preserves native top-level fields and removes only gateway-local keys", () => {
  const payload = {
    model: "claude-current",
    max_tokens: 512,
    messages: [{ role: "user", content: "hello" }],
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    future_native_field: { enabled: true },
    _gateway_compaction: true,
    _json_schema: { type: "object" },
  } as AnthropicMessagesPayload
  const prepared = prepareAnthropicMessagesRequest({
    payload,
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
  expect(prepared.body).toMatchObject({
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    future_native_field: { enabled: true },
  })
  expect(prepared.body).not.toHaveProperty("_gateway_compaction")
  expect(prepared.body).not.toHaveProperty("_json_schema")
  expect(prepared.normalizationClasses).toEqual(["gateway_only_fields"])
  expect(payload).toHaveProperty("_gateway_compaction", true)
  expect(payload).toHaveProperty("_json_schema", { type: "object" })
  expect(prepared.headers).toEqual({
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
})

test("defaults omitted native header options", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
    },
  })

  expect(prepared.headers).toEqual({ anthropicVersion: "2023-06-01" })
})

test.each([
  {
    name: "beta",
    options: { anthropicBeta: "PRIVATE_BAD_BETA value" },
    param: "anthropic_beta",
  },
  {
    name: "version",
    options: { anthropicVersion: "PRIVATE_BAD_VERSION\nvalue" },
    param: "anthropic_version",
  },
  {
    name: "provider preference",
    options: { modelProviderPreference: "PRIVATE_BAD_PROVIDER\nvalue" },
    param: "model_provider_preference",
  },
] as const)(
  "omits an invalid public $name header option without exposing it",
  ({ options, param }) => {
    expect(validateAnthropicRequestHeaderOptions(options)).not.toHaveProperty(
      getOptionalHeaderField(param),
    )
  },
)

test("normalizes every ephemeral cache marker without mutating the source", () => {
  const body = {
    cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
      },
    ],
  }
  const serialized = serializeAnthropicMessagesRequest(body)
  expect(JSON.parse(serialized)).toEqual({
    cache_control: { type: "ephemeral", ttl: "5m" },
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  })
  expect(body.cache_control).toHaveProperty("scope", "global")
})

test("reports cache-control normalization before native serialization", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: {
                type: "ephemeral",
                ttl: "5m",
                scope: "private-marker",
              },
            },
          ],
        },
      ],
    },
  })

  expect(prepared.normalizationClasses).toEqual(["cache_control"])
})

test("preserves opaque cache_control records outside Anthropic protocol slots", () => {
  const payload = {
    model: "claude-current",
    max_tokens: 64,
    metadata: {
      user_id: "user-safe",
      cache_control: { type: "ephemeral", scope: "metadata-opaque" },
    },
    future_native_field: {
      cache_control: { type: "ephemeral", scope: "future-opaque" },
    },
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "lookup",
            input: {
              cache_control: { type: "ephemeral", scope: "input-opaque" },
              nested: {
                cache_control: { type: "ephemeral", scope: "input-nested" },
              },
            },
          },
        ],
      },
    ],
    tools: [
      {
        name: "lookup",
        input_schema: {
          type: "object",
          properties: {
            cache_control: {
              type: "object",
              title: "opaque schema property",
              nested: {
                cache_control: { type: "ephemeral", scope: "schema-nested" },
              },
            },
          },
        },
      },
    ],
  } as unknown as AnthropicMessagesPayload

  const prepared = prepareAnthropicMessagesRequest({
    payload,
  })

  expect(prepared.body).toEqual(payload)
  expect(prepared.normalizationClasses).toEqual([])
})

test.each(["30m", "forever"])(
  "reports removal of unsupported cache-control ttl %s",
  (ttl) => {
    const prepared = prepareAnthropicMessagesRequest({
      payload: {
        model: "claude-current",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hello",
                cache_control: { type: "ephemeral", ttl } as never,
              },
            ],
          },
        ],
      },
    })

    expect(prepared.normalizationClasses).toEqual(["cache_control"])
    expect(
      JSON.parse(serializeAnthropicMessagesRequest(prepared.body)),
    ).toMatchObject({
      messages: [
        {
          content: [{ cache_control: { type: "ephemeral" } }],
        },
      ],
    })
  },
)

test("normalizes malformed cache_control only in known Anthropic slots", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      max_tokens: 64,
      cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
      system: [
        {
          type: "text",
          text: "stable",
          cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "lookup",
              input: {
                cache_control: { type: "ephemeral", scope: "input-opaque" },
              },
              cache_control: { type: "ephemeral", ttl: "forever" } as never,
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload,
  })

  expect(prepared.normalizationClasses).toEqual(["cache_control"])
  expect(prepared.body).toEqual({
    model: "claude-current",
    max_tokens: 64,
    cache_control: { type: "ephemeral", ttl: "5m" },
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "lookup",
            input: {
              cache_control: { type: "ephemeral", scope: "input-opaque" },
            },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  })
})

test("normalizes cache_control markers inside document source content blocks", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "content",
                content: [
                  {
                    type: "text",
                    text: "embedded",
                    cache_control: {
                      type: "ephemeral",
                      ttl: "1h",
                      scope: "inner-text",
                    },
                  },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "AA==",
                    },
                    cache_control: {
                      type: "ephemeral",
                      ttl: "forever",
                      scope: "inner-image",
                    } as never,
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload,
  })

  expect(prepared.normalizationClasses).toEqual(["cache_control"])
  expect(prepared.body).toEqual({
    model: "claude-current",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "content",
              content: [
                {
                  type: "text",
                  text: "embedded",
                  cache_control: { type: "ephemeral", ttl: "1h" },
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AA==",
                  },
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          },
        ],
      },
    ],
  })
})

test("preserves opaque cache_control neighbors around document source content", () => {
  const payload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "content",
              content: [{ type: "text", text: "embedded" }],
              cache_control: { type: "ephemeral", scope: "source-opaque" },
              future_nested: {
                cache_control: { type: "ephemeral", scope: "future-opaque" },
              },
            },
            future_document_field: {
              cache_control: { type: "ephemeral", scope: "document-opaque" },
            },
          },
        ],
      },
    ],
  } as unknown as AnthropicMessagesPayload

  const prepared = prepareAnthropicMessagesRequest({
    payload,
  })

  expect(prepared.body).toEqual(payload)
  expect(prepared.normalizationClasses).toEqual([])
})

test("normalizes known cache_control slots inside future-role message content", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      max_tokens: 64,
      messages: [
        {
          role: asAnthropicUnknownRole("future-role"),
          content: [
            {
              type: "text",
              text: "future text",
              cache_control: {
                type: "ephemeral",
                ttl: "5m",
                scope: "future-text",
              },
            },
            {
              type: "document",
              source: {
                type: "content",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "AA==",
                    },
                    cache_control: {
                      type: "ephemeral",
                      ttl: "forever",
                      scope: "future-image",
                    } as never,
                  },
                ],
              },
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                {
                  type: "text",
                  text: "result",
                  cache_control: {
                    type: "ephemeral",
                    ttl: "1h",
                    scope: "future-result",
                  },
                },
              ],
              cache_control: { type: "ephemeral", ttl: "never" } as never,
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload,
  })

  expect(prepared.normalizationClasses).toEqual(["cache_control"])
  expect(prepared.body).toEqual({
    model: "claude-current",
    max_tokens: 64,
    messages: [
      {
        role: asAnthropicUnknownRole("future-role"),
        content: [
          {
            type: "text",
            text: "future text",
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
          {
            type: "document",
            source: {
              type: "content",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AA==",
                  },
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  })
})

test("preserves opaque neighbors while normalizing recognized future-role blocks", () => {
  const payload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [
      {
        role: asAnthropicUnknownRole("future-role"),
        content: [
          {
            type: "text",
            text: "future text",
            cache_control: { type: "ephemeral", ttl: "5m", scope: "trim-me" },
            future_field: {
              cache_control: { type: "ephemeral", scope: "future-text-opaque" },
            },
          },
          {
            type: asAnthropicUnknownContentType("future_block_20270101"),
            cache_control: { type: "ephemeral", scope: "unknown-block-opaque" },
            nested: {
              cache_control: { type: "ephemeral", scope: "unknown-nested" },
            },
          },
          {
            type: "document",
            source: {
              type: "content",
              content: [{ type: "text", text: "embedded" }],
              cache_control: { type: "ephemeral", scope: "source-opaque" },
            },
            future_document_field: {
              cache_control: { type: "ephemeral", scope: "document-opaque" },
            },
          },
        ],
      },
    ],
  } as unknown as AnthropicMessagesPayload

  const prepared = prepareAnthropicMessagesRequest({
    payload,
  })

  expect(prepared.normalizationClasses).toEqual(["cache_control"])
  expect(prepared.body).toEqual({
    model: "claude-current",
    max_tokens: 64,
    messages: [
      {
        role: asAnthropicUnknownRole("future-role"),
        content: [
          {
            type: "text",
            text: "future text",
            cache_control: { type: "ephemeral", ttl: "5m" },
            future_field: {
              cache_control: { type: "ephemeral", scope: "future-text-opaque" },
            },
          },
          {
            type: asAnthropicUnknownContentType("future_block_20270101"),
            cache_control: { type: "ephemeral", scope: "unknown-block-opaque" },
            nested: {
              cache_control: { type: "ephemeral", scope: "unknown-nested" },
            },
          },
          {
            type: "document",
            source: {
              type: "content",
              content: [{ type: "text", text: "embedded" }],
              cache_control: { type: "ephemeral", scope: "source-opaque" },
            },
            future_document_field: {
              cache_control: { type: "ephemeral", scope: "document-opaque" },
            },
          },
        ],
      },
    ],
  })
})

test.each([
  ["model", { model: "", messages: [], max_tokens: 1 }],
  ["messages", { model: "claude", messages: [], max_tokens: 1 }],
] as const)("validates required inference field %s", (param, payload) => {
  try {
    prepareAnthropicMessagesRequest({
      payload: payload as unknown as AnthropicMessagesPayload,
    })
    throw new Error(`Expected ${param} validation to fail`)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(error).toHaveProperty(
      "clientBody.error.message",
      `${param} is required for Messages requests.`,
    )
    expect(error).toHaveProperty(
      "clientBody.error.type",
      "invalid_request_error",
    )
    expect(error).toHaveProperty("clientBody.error.code", "invalid_value")
    expect(error).toHaveProperty("clientBody.error.param", param)
    expect(error).toHaveProperty("clientBody.type", "error")
  }
})

test("does not require max_tokens during shared preparation", () => {
  expect(
    prepareAnthropicMessagesRequest({
      payload: {
        model: "claude",
        messages: [{ role: "user", content: "x" }],
      },
    }).body,
  ).not.toHaveProperty("max_tokens")
})

test.each([
  ["string", "32"],
  ["null", null],
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
] as const)(
  "preserves present safe-JSON max_tokens: %s",
  (_name, maxTokens) => {
    expect(
      prepareAnthropicMessagesRequest({
        payload: {
          model: "claude",
          messages: [{ role: "user", content: "x" }],
          max_tokens: maxTokens,
        } as unknown as AnthropicMessagesPayload,
      }).body,
    ).toHaveProperty("max_tokens", maxTokens)
  },
)

test.each([
  ["undefined", undefined],
  ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
] as const)(
  "keeps failing closed for non-JSON optional max_tokens: %s",
  (_name, maxTokens) => {
    expectFixedBodyError(
      () =>
        prepareAnthropicMessagesRequest({
          payload: {
            model: "claude",
            messages: [{ role: "user", content: "x" }],
            max_tokens: maxTokens,
          } as unknown as AnthropicMessagesPayload,
        }),
      "PRIVATE_NON_JSON_MAX_TOKENS",
    )
  },
)

test("preserves system and future roles plus unknown native structures", () => {
  const futureBlock = {
    type: asAnthropicUnknownContentType("future_content_block_20270101"),
    data: { enabled: true },
  }
  const futureSystemBlock = {
    type: asAnthropicUnknownContentType("future_system_block_20270101"),
    data: { enabled: true },
  }
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      system: [futureSystemBlock],
      messages: [
        { role: asAnthropicUnknownRole("system"), content: "bootstrap" },
        { role: asAnthropicUnknownRole("future-role"), content: [futureBlock] },
      ],
      tools: [
        {
          name: "lookup",
          future_tool_flag: true,
        },
      ],
      future_native_field: { enabled: true },
    } as AnthropicMessagesPayload,
  })

  expect(prepared.body).toMatchObject({
    system: [futureSystemBlock],
    messages: [
      { role: "system", content: "bootstrap" },
      {
        role: asAnthropicUnknownRole("future-role"),
        content: [futureBlock],
      },
    ],
    tools: [{ name: "lookup", future_tool_flag: true }],
    future_native_field: { enabled: true },
  })
})

test("preserves unnamed future native tool records with nested fields", () => {
  const futureTool = {
    type: "future_server_tool_20270101",
    config: {
      enabled: true,
      nested: { mode: "opaque" },
    },
  }

  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [futureTool],
    } as unknown as AnthropicMessagesPayload,
  })

  expect(prepared.body).toMatchObject({
    tools: [futureTool],
  })
})

test.each([
  [
    "opaque native tools without name or type",
    {
      opaque: {
        enabled: true,
        nested: { mode: "opaque" },
      },
    },
  ],
  [
    "future native tools with numeric names",
    {
      type: "future_server_tool_20270101",
      name: 3,
      config: {
        enabled: true,
        nested: { mode: "opaque" },
      },
    },
  ],
  [
    "future native tools with blank names",
    {
      type: "future_server_tool_20270101",
      name: "   ",
      config: {
        enabled: true,
        nested: { mode: "opaque" },
      },
    },
  ],
] as const)(
  "preserves %s during shared Messages preparation",
  (_label, futureTool) => {
    const prepared = prepareAnthropicMessagesRequest({
      payload: {
        model: "claude-current",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        tools: [futureTool],
      } as unknown as AnthropicMessagesPayload,
    })

    expect(prepared.body).toMatchObject({
      tools: [futureTool],
    })
  },
)

test("drops malformed optional controls instead of rejecting the request", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
      metadata: "private" as never,
      tool_choice: null as never,
      cache_control: "ephemeral" as never,
      thinking: true as never,
      output_config: "high" as never,
      system: ["not-a-block"] as never,
      stop_sequences: ["good", 3] as never,
      top_p: "0.8" as never,
      stream: "yes" as never,
      fallback_credit_token: 42 as never,
    } as AnthropicMessagesPayload,
  })

  expect(prepared.body).toEqual({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })
})

test("drops malformed nested message entries while preserving safe tool records", () => {
  const futureBlock = {
    type: asAnthropicUnknownContentType("future_content_block_20270101"),
    future_payload: { enabled: true },
  }
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      messages: [
        null,
        {
          role: asAnthropicUnknownRole("future-role"),
          content: [null, futureBlock, { type: "image", source: null }],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: 1, name: "broken", input: {} },
            { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
          ],
        },
      ],
      tools: [
        null,
        { name: 3, input_schema: {} },
        {
          name: "lookup",
          input_schema: { type: "object", properties: {} },
          future_tool_flag: true,
        },
      ],
    } as unknown as AnthropicMessagesPayload,
  })

  expect(prepared.body).toEqual({
    model: "claude-current",
    messages: [
      { role: asAnthropicUnknownRole("future-role"), content: [futureBlock] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
        ],
      },
    ],
    tools: [
      {
        name: 3,
        input_schema: {},
      },
      {
        name: "lookup",
        input_schema: { type: "object", properties: {} },
        future_tool_flag: true,
      },
    ],
  })
})

test("rejects a throwing accessor without invoking or exposing it", () => {
  const marker = "PRIVATE_THROWING_GETTER"
  let reads = 0
  const payload = {
    max_tokens: 1,
    messages: [{ role: "user", content: "hello" }],
  } as Record<string, unknown>
  Object.defineProperty(payload, "model", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(marker)
    },
  })

  expectFixedBodyError(
    () =>
      prepareAnthropicMessagesRequest({
        payload: payload as AnthropicMessagesPayload,
      }),
    marker,
  )
  expect(reads).toBe(0)
})

test("rejects a revoked proxy with a fixed body error", () => {
  const marker = "revoked proxy"
  const revocable = Proxy.revocable(
    {
      model: "claude",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    },
    {},
  )
  revocable.revoke()

  expectFixedBodyError(
    () =>
      prepareAnthropicMessagesRequest({
        payload: revocable.proxy as AnthropicMessagesPayload,
      }),
    marker,
  )
})

test.each([
  ["PRIVATE_BIGINT", 1n],
  ["PRIVATE_HOST_OBJECT", new Date(0)],
] as const)(
  "rejects non-JSON value %s with a fixed body error",
  (marker, value) => {
    const payload = {
      model: "claude",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
      future_native_field: value,
    } as AnthropicMessagesPayload

    expectFixedBodyError(
      () => prepareAnthropicMessagesRequest({ payload }),
      marker,
    )
    expect(payload.future_native_field).toBe(value)
  },
)

test("rejects cyclic data with a fixed body error and preserves the source", () => {
  const marker = "PRIVATE_CYCLE"
  const futureNativeField: Record<string, unknown> = { marker }
  futureNativeField.self = futureNativeField
  const payload = {
    model: "claude",
    max_tokens: 1,
    messages: [{ role: "user", content: "hello" }],
    future_native_field: futureNativeField,
  } as AnthropicMessagesPayload

  expectFixedBodyError(
    () => prepareAnthropicMessagesRequest({ payload }),
    marker,
  )
  expect(futureNativeField.self).toBe(futureNativeField)
})

test("serializer rejects accessors without invoking or exposing them", () => {
  const marker = "PRIVATE_SERIALIZER_GETTER"
  let reads = 0
  const body: Record<string, unknown> = {}
  Object.defineProperty(body, "future_native_field", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(marker)
    },
  })

  expectFixedBodyError(() => serializeAnthropicMessagesRequest(body), marker)
  expect(reads).toBe(0)
})
