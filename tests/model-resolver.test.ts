import { afterAll, beforeEach, expect, test } from "bun:test"

import { normalizeModelName } from "../src/lib/model-resolver"
import { state } from "../src/lib/state"

const originalModels = state.models

beforeEach(() => {
  state.models = undefined
})

afterAll(() => {
  state.models = originalModels
})

test("normalizes version dashes while preserving 1m internal model IDs", () => {
  expect(normalizeModelName("claude-example-8-9")).toBe("claude-example-8.9")
  expect(normalizeModelName("claude-example-8.9-1m-internal")).toBe(
    "claude-example-8.9-1m-internal",
  )
})

test("routes bracket 1m aliases to native 1m base models when no -1m variant exists", () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: { max_context_window_tokens: 1_000_000 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }

  expect(normalizeModelName("claude-opus-4-8[1m]")).toBe("claude-opus-4.8")
})

test("keeps bracket 1m aliases on explicit -1m variants when available", () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "claude-opus-4.6-1m",
        name: "Claude Opus 4.6 1M",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: { max_context_window_tokens: 1_000_000 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }

  expect(normalizeModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4.6-1m")
})
