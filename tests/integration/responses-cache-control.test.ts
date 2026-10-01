import "./data-dir"

import { expect, test } from "bun:test"

import { state } from "~/lib/state"

import { probeResponsesCacheControl } from "./cache-control-probe"
import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  request,
  TEST_TIMEOUT,
} from "./setup"

useIntegrationFixture()

await initializeTestState()

const responsesModels =
  state.models?.data.filter((model) =>
    model.supported_endpoints?.includes("/responses"),
  ) ?? []
const messagesModel = state.models?.data.find((model) =>
  model.supported_endpoints?.includes("/v1/messages"),
)?.id
const longStablePrefix = "Stable explicit cache prefix. ".repeat(128)

test.skipIf(responsesModels.length === 0)(
  "accepts Responses explicit cache controls",
  async () => {
    const response = await probeResponsesCacheControl({
      models: responsesModels,
      request: async (model, signal) =>
        request("/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            model: model.id,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: longStablePrefix,
                    prompt_cache_breakpoint: { mode: "explicit" },
                  },
                  { type: "input_text", text: "Reply with OK." },
                ],
              },
            ],
            prompt_cache_options: { mode: "explicit", ttl: "30m" },
            max_output_tokens: 32,
          }),
        }),
    })

    expect(response.status).toBe(200)
  },
  TEST_TIMEOUT,
)

test.skipIf(messagesModel === undefined)(
  "accepts native Messages 5m cache control",
  async () => {
    if (!messagesModel) throw new Error("Messages endpoint unavailable")

    const response = await postJSON("/v1/messages", {
      model: messagesModel,
      max_tokens: 32,
      cache_control: { type: "ephemeral", ttl: "5m" },
      messages: [{ role: "user", content: "Reply with OK." }],
    })

    expect(response.status).toBe(200)
  },
  TEST_TIMEOUT,
)
