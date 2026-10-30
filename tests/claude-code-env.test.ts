import { expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { buildClaudeCodeEnvironment } from "~/lib/claude-code-env"

function model(id: string, maxPromptTokens: number): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "1",
    capabilities: {
      family: id,
      limits: { max_prompt_tokens: maxPromptTokens },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

const models = [model("gpt-current", 272_000), model("claude-current", 168_000)]

test("tells Claude Code the prompt window of a model it does not know", () => {
  const env = buildClaudeCodeEnvironment({
    serverUrl: "http://localhost:4141",
    model: "gpt-current",
    smallModel: "claude-current",
    models,
  })

  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: "http://localhost:4141",
    ANTHROPIC_MODEL: "gpt-current",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-current",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "272000",
  })
})

test("leaves the context window to Claude Code for Claude models", () => {
  const env = buildClaudeCodeEnvironment({
    serverUrl: "http://localhost:4141",
    model: "claude-current",
    smallModel: "gpt-current",
    models,
  })

  expect(env).not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS")
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-current")
})
