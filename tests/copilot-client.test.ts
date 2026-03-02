import { describe, expect, test } from "bun:test"

import { addPromptCaching } from "~/services/copilot/copilot-client"

describe("addPromptCaching", () => {
  test("adds cache control to the last non-user message", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "user-1" },
      { role: "assistant", content: "assistant-1" },
      { role: "user", content: "user-2" },
    ]

    addPromptCaching(messages)

    expect(
      (messages[2] as Record<string, unknown>).copilot_cache_control,
    ).toEqual({ type: "ephemeral" })
    expect(
      (messages[3] as Record<string, unknown>).copilot_cache_control,
    ).toBeUndefined()
  })

  test("skips reasoning-only assistant messages for checkpoint placement", () => {
    const messages = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        reasoning_text: "thinking",
        reasoning_opaque: "signature",
      },
      { role: "user", content: "latest-user" },
    ]

    addPromptCaching(messages)

    expect(
      (messages[0] as Record<string, unknown>).copilot_cache_control,
    ).toEqual({ type: "ephemeral" })
    expect(
      (messages[1] as Record<string, unknown>).copilot_cache_control,
    ).toBeUndefined()
  })

  test("adds cache control to the last tool definition", () => {
    const messages = [{ role: "user", content: "hello" }]
    const tools = [
      { type: "function", function: { name: "one", parameters: {} } },
      { type: "function", function: { name: "two", parameters: {} } },
    ]

    addPromptCaching(messages, tools)

    expect((tools[1] as Record<string, unknown>).copilot_cache_control).toEqual(
      { type: "ephemeral" },
    )
    expect(
      (tools[0] as Record<string, unknown>).copilot_cache_control,
    ).toBeUndefined()
  })
})
