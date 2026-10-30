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
