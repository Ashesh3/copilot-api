import { expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { expandCompactionItems } from "../src/routes/responses/utils"

test("preserves native compaction items for the upstream account", () => {
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

test("decodes Unicode proxy-generated compaction summaries", () => {
  const summary = "Résumé — पिछला संदर्भ"
  const payload = {
    model: "gpt-4o",
    input: [
      {
        id: "cmp_unicode",
        type: "compaction",
        encrypted_content: Buffer.from(summary).toString("base64"),
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "message",
      role: "assistant",
      content: `[Previous conversation summary]\n${summary}`,
    },
  ])
})

test("drops superseded history before the latest compaction item", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "message",
        role: "user",
        content: "superseded history",
      },
      {
        id: "cmp_native_older",
        type: "compaction",
        encrypted_content: "opaque-older-compaction",
      },
      {
        type: "message",
        role: "assistant",
        content: "also superseded",
      },
      {
        id: "cmp_native_latest",
        type: "compaction",
        encrypted_content: "opaque-native-compaction",
      },
      {
        type: "message",
        role: "user",
        content: "post-compaction work",
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      id: "cmp_native_latest",
      type: "compaction",
      encrypted_content: "opaque-native-compaction",
    },
    {
      type: "message",
      role: "user",
      content: "post-compaction work",
    },
  ])
})
