import { expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  rankToolCapableResponsesModels,
  selectToolCapableResponsesCandidates,
} from "./integration/model-candidates"

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

test("ranks tool-capable Responses models with preferred IDs first", () => {
  const ranked = rankToolCapableResponsesModels(
    [
      model({
        family: "a",
        id: "listed-first",
        responses: true,
        toolCalls: true,
      }),
      model({ family: "b", id: "no-tools", responses: true, toolCalls: false }),
      model({ family: "c", id: "messages-only", toolCalls: true }),
      model({
        family: "d",
        id: "preferred-second",
        responses: true,
        toolCalls: true,
      }),
      model({
        family: "e",
        id: "listed-last",
        responses: true,
        toolCalls: true,
      }),
      model({
        family: "f",
        id: "preferred-first",
        responses: true,
        toolCalls: true,
      }),
    ],
    ["preferred-first", "not-listed", "preferred-second", "no-tools"],
  )

  expect(ranked.map(({ id }) => id)).toEqual([
    "preferred-first",
    "preferred-second",
    "listed-first",
    "listed-last",
  ])
})
