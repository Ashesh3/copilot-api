import { expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { selectToolCapableResponsesCandidates } from "./integration/model-candidates"

function model(options: {
  family: string
  id: string
  responses?: boolean
  toolCalls?: boolean
  vendor?: string
}): Model {
  return {
    capabilities: {
      family: options.family,
      limits: {},
      object: "model_capabilities",
      supports: { tool_calls: options.toolCalls },
      tokenizer: "test",
      type: "chat",
    },
    id: options.id,
    name: options.id,
    object: "model",
    supported_endpoints: options.responses ? ["/responses"] : ["/v1/messages"],
    vendor: options.vendor,
    version: "test",
  }
}

test("selects a bounded provider-diverse set of tool-capable Responses models", () => {
  const candidates = selectToolCapableResponsesCandidates(
    [
      model({
        family: "first-family",
        id: "responses-without-tools",
        responses: true,
        toolCalls: false,
        vendor: "provider-a",
      }),
      model({
        family: "first-family",
        id: "provider-a-tool-model",
        responses: true,
        toolCalls: true,
        vendor: "provider-a",
      }),
      model({
        family: "first-family",
        id: "provider-a-duplicate",
        responses: true,
        toolCalls: true,
        vendor: "provider-a",
      }),
      model({
        family: "messages-family",
        id: "messages-only-tool-model",
        toolCalls: true,
        vendor: "provider-b",
      }),
      model({
        family: "second-family",
        id: "provider-b-tool-model",
        responses: true,
        toolCalls: true,
        vendor: "provider-b",
      }),
      model({
        family: "third-family",
        id: "family-fallback-tool-model",
        responses: true,
        toolCalls: true,
      }),
    ],
    2,
  )

  expect(candidates.map(({ id }) => id)).toEqual([
    "provider-a-tool-model",
    "provider-b-tool-model",
  ])
})
