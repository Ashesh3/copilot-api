import { expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { expandCompactionItems } from "../src/routes/responses/utils"

test("preserves native compaction items by default", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "compaction",
        encrypted_content: "opaque-native-compaction",
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "compaction",
      encrypted_content: "opaque-native-compaction",
    },
  ])
})

test("expands proxy-generated compaction items as a compatibility fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        id: "cmp_123",
        type: "compaction",
        encrypted_content: Buffer.from("summary").toString("base64"),
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "message",
      role: "assistant",
      content: "[Previous conversation summary]\nsummary",
    },
  ])
})
