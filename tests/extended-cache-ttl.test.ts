import { afterEach, expect, test } from "bun:test"

import {
  hasExtendedCacheTtl,
  refusesExtendedCacheTtl,
  rememberExtendedCacheTtlRefusal,
  removeExtendedCacheTtl,
  resetExtendedCacheTtlRefusalForTest,
} from "../src/services/copilot/extended-cache-ttl"

afterEach(() => {
  resetExtendedCacheTtlRefusalForTest()
})

test("remembers a long-lived cache refusal only for the refusing account", () => {
  rememberExtendedCacheTtlRefusal("account:1")

  expect(refusesExtendedCacheTtl("account:1")).toBe(true)
  expect(refusesExtendedCacheTtl("account:2")).toBe(false)
  expect(refusesExtendedCacheTtl("single")).toBe(false)
})

test("forgets a long-lived cache refusal after an hour", () => {
  const refusedAt = Date.parse("2026-10-30T08:00:00Z")
  rememberExtendedCacheTtlRefusal("account:1", refusedAt)

  expect(refusesExtendedCacheTtl("account:1", refusedAt + 59 * 60_000)).toBe(
    true,
  )
  expect(refusesExtendedCacheTtl("account:1", refusedAt + 60 * 60_000)).toBe(
    false,
  )
})

test("leaves cache_control inside tool inputs and schemas alone", () => {
  const toolData = { cache_control: { type: "ephemeral", ttl: "1h" } }
  const body: Record<string, unknown> = {
    tools: [
      {
        name: "record",
        input_schema: { type: "object", properties: { note: toolData } },
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object", default: toolData },
      },
    },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "record", input: toolData },
        ],
      },
    ],
  }

  expect(hasExtendedCacheTtl(body)).toBe(false)
  expect(removeExtendedCacheTtl(body)).toBe(false)
  expect(toolData.cache_control.ttl).toBe("1h")
})

test("drops long-lived ttls and keeps default breakpoints", () => {
  const body: Record<string, unknown> = {
    system: [{ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [
              { type: "text", cache_control: { type: "ephemeral", ttl: "1h" } },
            ],
          },
          { type: "text", cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  }

  expect(hasExtendedCacheTtl(body)).toBe(true)
  expect(removeExtendedCacheTtl(body)).toBe(true)
  expect(hasExtendedCacheTtl(body)).toBe(false)
  expect(body).toMatchObject({
    system: [{ cache_control: { type: "ephemeral" } }],
    messages: [
      {
        content: [
          { content: [{ cache_control: { type: "ephemeral" } }] },
          { cache_control: { type: "ephemeral", ttl: "5m" } },
        ],
      },
    ],
  })
  expect(JSON.stringify(body)).not.toContain('"1h"')
})
