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

for (const protocol of ["messages", "responses", "chat"] as const) {
  const inputField = protocol === "chat" ? "prompt_tokens" : "input_tokens"
  const outputField =
    protocol === "chat" ? "completion_tokens" : "output_tokens"

  test.each([
    { name: "null", value: null },
    { name: "negative", value: -1 },
    { name: "string", value: "10" },
    { name: "fractional", value: 1.5 },
    { name: "NaN", value: Number.NaN },
    { name: "infinity", value: Number.POSITIVE_INFINITY },
    { name: "saturated", value: Number.MAX_SAFE_INTEGER },
  ])(
    `${protocol} retains measured output on a $name update in the same round`,
    ({ value }) => {
      const { usage, checkpoints } = fixture(protocol)
      usage.observe({ [inputField]: 10, [outputField]: 4 }, true)
      usage.observe({ [inputField]: 10, [outputField]: value }, true)
      expect(checkpoints.at(-1)).toEqual({
        inputTokens: 10,
        outputTokens: 4,
        unknownTokenCount: true,
      })
      usage.observe({ [inputField]: 8, [outputField]: 2 }, true)
      expect(checkpoints.at(-1)).toEqual({
        inputTokens: 8,
        outputTokens: 2,
        unknownTokenCount: true,
      })
    },
  )

  test(`${protocol} replaces invalid-first counters with measurements but retains the collection gap`, () => {
    const { usage, checkpoints } = fixture(protocol)
    usage.observe({ [inputField]: null, [outputField]: "4" }, true)
    expect(checkpoints.at(-1)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      unknownTokenCount: true,
    })
    usage.observe({ [inputField]: 10, [outputField]: 4 }, true)
    expect(checkpoints.at(-1)).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      unknownTokenCount: true,
    })
  })

  test(`${protocol} replaces valid snapshots with reduced values and explicit zero`, () => {
    const { usage, checkpoints } = fixture(protocol)
    usage.observe({ [inputField]: 10, [outputField]: 4 }, true)
    usage.observe({ [inputField]: 6, [outputField]: 2 }, true)
    expect(checkpoints.at(-1)).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      unknownTokenCount: false,
    })
    usage.observe({ [inputField]: 0, [outputField]: 0 }, true)
    expect(checkpoints.at(-1)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      unknownTokenCount: false,
    })
  })

  test(`${protocol} missing components retain the last measurements within a round`, () => {
    const { usage, checkpoints } = fixture(protocol)
    usage.observe({ [inputField]: 10, [outputField]: 4 }, true)
    usage.observe({ [outputField]: 5 }, true)
    usage.observe(undefined, true)
    usage.observe({ service_tier: "standard" }, true)
    expect(checkpoints.at(-1)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      unknownTokenCount: false,
    })
    usage.nextRound()
    usage.observe({ [outputField]: 1 }, false)
    expect(checkpoints.at(-1)).toEqual({
      inputTokens: 10,
      outputTokens: 6,
      unknownTokenCount: false,
    })
  })
}

test("Messages caches retain independent last valid values and accept zero replacements", () => {
  const { usage, checkpoints } = fixture("messages")
  usage.observe(
    {
      input_tokens: 10,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens: 4,
    },
    true,
  )
  usage.observe(
    {
      input_tokens: 20,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: 5,
      output_tokens: 6,
    },
    true,
  )
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 28,
    outputTokens: 6,
    unknownTokenCount: true,
  })
  usage.observe(
    {
      input_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: "bad",
      output_tokens: 0,
    },
    true,
  )
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 12,
    outputTokens: 0,
    unknownTokenCount: true,
  })
  usage.observe(
    {
      input_tokens: null,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
      output_tokens: 2,
    },
    true,
  )
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 8,
    outputTokens: 2,
    unknownTokenCount: true,
  })
  usage.nextRound()
  usage.observe({ input_tokens: 2, output_tokens: 1 }, false)
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 10,
    outputTokens: 3,
    unknownTokenCount: true,
  })
})

test("nextRound clears every Messages component before recording the next snapshot", () => {
  const { usage, checkpoints } = fixture("messages")
  usage.observe(
    {
      input_tokens: 10,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens: 4,
    },
    true,
  )
  usage.nextRound()
  usage.observe({ output_tokens: 1 }, false)
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 15,
    outputTokens: 5,
    unknownTokenCount: false,
  })
  usage.observe({ input_tokens: 0, output_tokens: 0 }, false)
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 15,
    outputTokens: 4,
    unknownTokenCount: false,
  })
  usage.nextRound()
  usage.observe({ input_tokens: 2, output_tokens: 3 }, false)
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 17,
    outputTokens: 7,
    unknownTokenCount: false,
  })
})

test("a within-round component overflow remains a gap after a valid replacement", () => {
  const { usage, checkpoints } = fixture("messages")
  usage.observe(
    {
      input_tokens: Number.MAX_SAFE_INTEGER - 2,
      cache_read_input_tokens: 10,
      output_tokens: 4,
    },
    true,
  )
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: Number.MAX_SAFE_INTEGER - 2,
    outputTokens: 4,
    unknownTokenCount: true,
  })
  usage.observe(
    { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 0 },
    true,
  )
  expect(checkpoints.at(-1)).toEqual({
    inputTokens: 3,
    outputTokens: 0,
    unknownTokenCount: true,
  })
})
