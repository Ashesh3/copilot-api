import { expect, test } from "bun:test"

import { partitionTranscript } from "~/routes/desktop-dictation/transcript"

test("segment partitioning preserves original Unicode and punctuation instead of rebuilding words", () => {
  expect(
    partitionTranscript(
      {
        text: "你好👋世界。继续说话",
        segments: [
          { start: 0, end: 26, text: "你好👋世界。" },
          { start: 28, end: 30, text: "继续说话" },
        ],
      },
      960_000,
    ),
  ).toEqual({
    stableText: "你好👋世界。",
    interimText: "继续说话",
    retainFrom: 864_000,
  })
})

test("contiguous phrases retain the final phrase without lexical overlap guesses", () => {
  expect(
    partitionTranscript(
      {
        text: "Yes, yes. Yes, yes.",
        segments: [
          { start: 0, end: 25, text: "Yes, yes." },
          { start: 25, end: 30, text: " Yes, yes." },
        ],
      },
      960_000,
    ),
  ).toEqual({
    stableText: "Yes, yes.",
    interimText: "Yes, yes.",
    retainFrom: 800_000,
  })
})

for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`non-finite segment timing never commits words or discards PCM: ${value}`, () => {
    expect(
      partitionTranscript(
        {
          text: "First. Last.",
          segments: [
            { start: 0, end: 26, text: "First." },
            { start: value, end: 30, text: " Last." },
          ],
        },
        960_000,
      ),
    ).toEqual({
      stableText: "",
      interimText: "First. Last.",
      retainFrom: 0,
    })
  })
}

test("a phrase ending at the recording edge stays provisional even with trailing metadata", () => {
  expect(
    partitionTranscript(
      {
        text: "Do not cut this word.",
        segments: [
          { start: 0, end: 29.5, text: "Do not cut this word." },
          { start: 29.5, end: 30, text: "" },
        ],
      },
      960_000,
    ),
  ).toEqual({
    stableText: "",
    interimText: "Do not cut this word.",
    retainFrom: 0,
  })
})

for (const [text, first, last] of [
  ["The extraordinary result", "The extra", "ordinary result"],
  ["I don't know", "I don", "'t know"],
  ["U.S. examples", "U.", "S. examples"],
  ["twenty-one words", "twenty", "-one words"],
]) {
  test(`a no-space seam must not corrupt ${JSON.stringify(text)}`, () => {
    expect(
      partitionTranscript(
        {
          text,
          segments: [
            { start: 0, end: 25, text: first },
            { start: 25, end: 30, text: last },
          ],
        },
        960_000,
      ),
    ).toEqual({
      stableText: "",
      interimText: text,
      retainFrom: 0,
    })
  })
}
