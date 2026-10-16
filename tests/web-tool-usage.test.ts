import { expect, test } from "bun:test"

import type { ObservedRequestUsage } from "~/lib/request-usage"
import type { WebProtocol } from "~/services/web/tool-context"

import { ManagedWebUsage } from "~/services/web/tool-usage"

function fixture(protocol: WebProtocol = "responses") {
  const checkpoints: Array<ObservedRequestUsage> = []
  return {
    checkpoints,
    usage: new ManagedWebUsage(protocol, (value) => checkpoints.push(value)),
  }
}

test.each([null, -1, "10", Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid %s retains measured subtotals and collection-gap metadata",
  (invalid) => {
    const { usage, checkpoints } = fixture()
    usage.observe({ input_tokens: 10, output_tokens: 4 }, true)
    usage.nextRound()
    usage.observe({ input_tokens: invalid, output_tokens: 6 }, false)
    expect(checkpoints.at(-1)).toMatchObject({
      inputTokens: 10,
      outputTokens: 10,
      unknownTokenCount: true,
    })
    usage.nextRound()
    usage.observe({ input_tokens: 3, output_tokens: 2 }, false)
    expect(checkpoints.at(-1)).toMatchObject({
      inputTokens: 13,
      outputTokens: 12,
      unknownTokenCount: true,
    })
  },
)

test("overflow preserves the completed safe subtotal instead of dropping it", () => {
  const { usage, checkpoints } = fixture()
  usage.observe(
    { input_tokens: Number.MAX_SAFE_INTEGER - 2, output_tokens: 4 },
    true,
  )
  usage.nextRound()
  usage.observe({ input_tokens: 10, output_tokens: 2 }, false)
  expect(checkpoints.at(-1)).toMatchObject({
    inputTokens: Number.MAX_SAFE_INTEGER - 2,
    outputTokens: 6,
    unknownTokenCount: true,
  })
})

test("Messages caches remain measured when another input component is invalid", () => {
  const { usage, checkpoints } = fixture("messages")
  usage.observe(
    {
      input_tokens: null,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens: 4,
    },
    true,
  )
  expect(checkpoints.at(-1)).toMatchObject({
    inputTokens: 5,
    outputTokens: 4,
    unknownTokenCount: true,
  })
})

test("within-round snapshots replace counts, distinct rounds add, and transparent calls do not override transport usage", () => {
  const { usage, checkpoints } = fixture("messages")
  usage.observe({ input_tokens: 10, output_tokens: 0 }, false)
  expect(checkpoints).toEqual([])
  usage.observe({ input_tokens: 10, output_tokens: 2 }, true)
  usage.observe({ input_tokens: 10, output_tokens: 4 }, true)
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 10, outputTokens: 4 })
  usage.nextRound()
  usage.observe({ input_tokens: 20, output_tokens: 0 }, false)
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 30, outputTokens: 4 })
})

test("missing usage clears transport guesses but explicit zero remains measured", () => {
  const { usage, checkpoints } = fixture()
  usage.observe({}, true)
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: undefined,
    outputTokens: undefined,
  })
  usage.nextRound()
  usage.observe({ input_tokens: 0, output_tokens: 0 }, false)
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 })
})
