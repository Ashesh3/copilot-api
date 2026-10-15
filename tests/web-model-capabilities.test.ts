import { afterEach, expect, test } from "bun:test"

import { withActiveAccount } from "~/lib/account-lease-context"
import { runWithRoutedModelSelection } from "~/lib/account-router"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { runWithWebTools } from "~/services/web/tool-context"
import { runManagedWebRequest } from "~/services/web/tool-loop"

const originalModels = state.models
afterEach(() => {
  state.models = originalModels
})

test("known text-only models do not receive automatic functions", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "text-only",
        object: "model",
        name: "text-only",
        preview: false,
        version: "1",
        capabilities: {
          family: "test",
          object: "model_capabilities",
          supports: { tool_calls: false },
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  const payload = { model: "text-only", input: "hello" }
  await runWithWebTools(payload, "model-test", () =>
    runManagedWebRequest({
      protocol: "responses",
      payload,
      send: (body) => {
        expect(body).not.toHaveProperty("tools")
        return Promise.resolve({ output: [] })
      },
    }),
  )
})

test("selected account tool support wins over merged model metadata", async () => {
  const account = tokenPool.addAccount(
    "capability-fixture-only",
    "individual",
    97123,
  )
  const model = {
    id: "account-model",
    object: "model",
    name: "Account model",
    preview: false,
    version: "1",
    capabilities: {
      family: "test",
      object: "model_capabilities",
      supports: { tool_calls: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
  account.modelsData = [
    {
      ...model,
      capabilities: { ...model.capabilities, supports: { tool_calls: false } },
    },
  ]
  state.models = { object: "list", data: [model] }
  const payload = { model: "account-model", input: "hello" }
  try {
    await runWithRoutedModelSelection(
      { model: account.modelsData[0], accountPin: { accountId: account.id } },
      () =>
        runWithWebTools(payload, "model-test", () =>
          runManagedWebRequest({
            protocol: "responses",
            payload,
            send: (body) => {
              expect(body).not.toHaveProperty("tools")
              return Promise.resolve({ output: [] })
            },
          }),
        ),
    )
    await withActiveAccount(account, () =>
      runWithWebTools(payload, "model-test", () =>
        runManagedWebRequest({
          protocol: "responses",
          payload,
          accountId: account.id,
          send: (body) => {
            expect(body).not.toHaveProperty("tools")
            return Promise.resolve({ output: [] })
          },
        }),
      ),
    )
  } finally {
    tokenPool.deleteAccount(account.id)
  }
})
