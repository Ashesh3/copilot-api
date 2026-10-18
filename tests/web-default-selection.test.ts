import { afterEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"
import type { WebProtocol } from "~/services/web/tool-context"

import { withActiveAccount } from "~/lib/account-lease-context"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { runWithWebTools } from "~/services/web/tool-context"
import { runManagedWebRequest } from "~/services/web/tool-loop"

const originalModels = state.models
afterEach(() => {
  state.models = originalModels
})

function model(supports: Record<string, unknown> = {}): Model {
  return {
    id: "gpt-native-fixture",
    name: "Native fixture",
    object: "model",
    version: "1",
    vendor: "openai",
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      supports: { tool_calls: true, ...supports },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function capture(
  payload: Record<string, unknown>,
  options: { protocol?: WebProtocol; nativeResponses?: boolean } = {},
  source = payload,
) {
  return runWithWebTools(source, () =>
    runManagedWebRequest({
      protocol: options.protocol ?? "responses",
      payload,
      nativeResponses: options.nativeResponses,
      send: (body) => Promise.resolve({ sent: body }),
    }),
  )
}

test("native Responses sends a hosted default even though no gateway calls are managed", async () => {
  state.models = { object: "list", data: [model()] }
  const payload = {
    model: "gpt-native-fixture",
    input: [
      {
        type: "additional_tools",
        tools: [{ type: "namespace", name: "functions", tools: [] }],
      },
      { role: "user", content: "Find the latest documentation" },
    ],
  }
  const before = structuredClone(payload)
  expect(await capture(payload, { nativeResponses: true })).toEqual({
    sent: { ...payload, tools: [{ type: "web_search" }] },
  })
  expect(payload).toEqual(before)
})

test("translated Responses keeps private managed search rather than changing the client protocol", async () => {
  state.models = { object: "list", data: [model()] }
  const result = await capture({ model: "gpt-native-fixture", input: "search" })
  expect(result).toMatchObject({
    sent: { tools: [{ type: "function", name: "_copilot_web_search" }] },
  })
})

test.each<Model>([
  { ...model(), custom_model: true },
  { ...model(), supported_endpoints: ["/chat/completions"] },
  model({ web_search: false }),
  { ...model(), policy: { state: "disabled", terms: "" } },
  { ...model(), id: "vendor-model", vendor: "unknown" },
])(
  "does not infer hosted search for ineligible metadata: %j",
  async (metadata) => {
    state.models = { object: "list", data: [metadata] }
    const result = await capture(
      { model: metadata.id, input: "search" },
      { nativeResponses: true },
    )
    expect(result).toMatchObject({
      sent: { tools: [{ type: "function", name: "_copilot_web_search" }] },
    })
  },
)

test("unknown GPT names are not evidence of native hosted capability", async () => {
  state.models = undefined
  expect(
    await capture(
      { model: "gpt-unknown", input: "search" },
      { nativeResponses: true },
    ),
  ).toMatchObject({
    sent: { tools: [{ type: "function", name: "_copilot_web_search" }] },
  })
})

test("selected account hosted support overrides merged metadata, including missing entries", async () => {
  const metadata = model()
  state.models = { object: "list", data: [metadata] }
  const account = tokenPool.addAccount(
    "hosted-capability-fixture",
    "individual",
    97124,
  )
  try {
    for (const modelsData of [[model({ web_search: false })], []]) {
      account.modelsData = modelsData
      const result = await withActiveAccount(account, () =>
        capture(
          { model: metadata.id, input: "search" },
          { nativeResponses: true },
        ),
      )
      expect(result).toMatchObject({
        sent: { tools: [{ type: "function", name: "_copilot_web_search" }] },
      })
    }
  } finally {
    tokenPool.deleteAccount(account.id)
  }
})

const clientDeclarations = [
  { tools: [{ name: "get_weather", input_schema: { type: "object" } }] },
  { tools: [{ type: "function", function: { name: "get_weather" } }] },
  { tools: [{ type: "custom", custom: { name: "shell" } }] },
  { tools: [{ type: "function", name: "web_search", parameters: {} }] },
  { tools: [{ type: "namespace", name: "functions", tools: [] }] },
  { tools: [{ type: "shell", environment: { type: "local" } }] },
  {
    tools: [{ type: "function", name: "_copilot_web_search", parameters: {} }],
  },
  { tools: [{ functionDeclarations: [{ name: "get_weather" }] }] },
  { input: [{ type: "additional_tools", tools: [{ type: "apply_patch" }] }] },
  {
    input: [
      {
        type: "tool_search_output",
        tools: [{ type: "function", name: "get_weather" }],
      },
    ],
  },
]

for (const protocol of ["messages", "chat", "responses"] as const)
  test.each(clientDeclarations)(
    `${protocol} does not inject stateless managed search alongside caller tools: %j`,
    async (source) => {
      const payload = { model: "fixture", ...source }
      expect(await capture(payload, { protocol })).toEqual({ sent: payload })
      // Ownership survives a translator that removes or flattens declarations.
      const translated = { model: "fixture" }
      expect(await capture(translated, { protocol }, payload)).toEqual({
        sent: translated,
      })
    },
  )

for (const protocol of ["messages", "chat", "responses"] as const)
  test.each(["auto", "required", { type: "any" }])(
    `${protocol} rejects explicit managed search plus caller tools before dispatch: %j`,
    async (choice) => {
      const source = {
        tools: [
          { type: "web_search_20250305", name: "web_search" },
          { name: "get_weather" },
        ],
        tool_choice: choice,
      }
      const translated = {
        model: "fixture",
        tools: [
          { type: "function", name: "web_search" },
          { type: "function", name: "get_weather" },
        ],
        tool_choice: choice,
      }
      expect(
        await capture(translated, { protocol }, source).catch(
          (error: unknown) => error,
        ),
      ).toMatchObject({
        clientBody: { error: { code: "unsupported_web_tool_combination" } },
      })
    },
  )

test.each([
  "none",
  { type: "none" },
  { type: "function", name: "get_weather" },
])(
  "explicit mixed declarations with disabled search preserve caller controls: %j",
  async (choice) => {
    const source = {
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "get_weather" },
      ],
      tool_choice: choice,
    }
    expect(await capture(source, { protocol: "messages" })).toEqual({
      sent: source,
    })
  },
)

test("Google server search plus caller functions is rejected after translation", async () => {
  const source = {
    tools: [
      { googleSearch: { max_uses: 2 } },
      { functionDeclarations: [{ name: "get_weather" }] },
    ],
  }
  const translated = {
    tools: [
      { type: "function", function: { name: "web_search" } },
      { type: "function", function: { name: "get_weather" } },
    ],
  }
  expect(
    await capture(translated, { protocol: "chat" }, source).catch(
      (error: unknown) => error,
    ),
  ).toMatchObject({
    clientBody: { error: { code: "unsupported_web_tool_combination" } },
  })
})

test("explicit hosted search plus client tools stays native and unchanged", async () => {
  const payload = {
    model: "gpt-native-fixture",
    tools: [
      { type: "web_search", external_web_access: false },
      { type: "function", name: "get_weather" },
    ],
  }
  expect(await capture(payload, { nativeResponses: true })).toEqual({
    sent: payload,
  })
})

test("translated Responses cannot silently discard hosted history before a client handoff", async () => {
  const payload = {
    tools: [{ type: "web_search" }, { type: "function", name: "get_weather" }],
  }
  expect(await capture(payload).catch((error: unknown) => error)).toMatchObject(
    {
      clientBody: { error: { code: "unsupported_web_tool_combination" } },
    },
  )
})

test.each([
  { tool_choice: "none" },
  {
    tool_choice: "required",
    tools: [{ type: "function", name: "get_weather" }],
  },
  { generate: false },
  { tools: null },
  { text: { format: { type: "json_schema" } } },
])(
  "native hosted defaults honor constrained client requests: %j",
  async (controls) => {
    state.models = { object: "list", data: [model()] }
    const payload = { model: "gpt-native-fixture", input: "hello", ...controls }
    expect(await capture(payload, { nativeResponses: true })).toEqual({
      sent: payload,
    })
  },
)
