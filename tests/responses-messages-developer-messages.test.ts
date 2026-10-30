import { expect, test } from "bun:test"

import type { ResponseInputItem } from "~/services/copilot/create-responses"

import { adaptResponsesToMessagesCandidate } from "~/routes/responses/messages-bridge"

import { mergeTurns } from "./helpers/messages-turns"
import { systemText } from "./helpers/prompt-cache"

const MODEL = "claude-opus-4.7"
const EXEC = {
  type: "function" as const,
  name: "exec_command",
  parameters: { type: "object", properties: { cmd: { type: "string" } } },
}
const ASK = { type: "message", role: "user", content: "Run the tests" } as const
const FIRST_TURN: Array<ResponseInputItem> = [
  { type: "message", role: "developer", content: "Sandbox: workspace-write" },
  ASK,
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "All tests pass." }],
  },
]

function reminder(text: string) {
  return {
    type: "text",
    text: `<system-reminder>\n${text}\n</system-reminder>`,
  }
}

async function translate(input: Array<ResponseInputItem>) {
  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      model: MODEL,
      instructions: "You are Codex.",
      input,
      tools: [EXEC],
    },
  })
  return candidate.payload
}

test("a developer message after the model answered stays in place", async () => {
  const next = {
    type: "message",
    role: "user",
    content: "Edit the file",
  } as const
  const before = await translate([...FIRST_TURN, next])
  const after = await translate([
    ...FIRST_TURN,
    { type: "message", role: "developer", content: "Sandbox: read-only" },
    next,
  ])

  // The system prompt, the start of the cached prefix, does not change.
  expect(systemText(after.system)).toBe(
    "You are Codex.\n\nSandbox: workspace-write",
  )
  expect(after.system).toEqual(before.system)
  expect(mergeTurns(after.messages)).toEqual([
    { role: "user", content: [{ type: "text", text: ASK.content }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "All tests pass." }],
    },
    {
      role: "user",
      content: [
        reminder("Sandbox: read-only"),
        { type: "text", text: next.content },
      ],
    },
  ])
})

test("an instruction that arrives during a tool call follows its result", async () => {
  const payload = await translate([
    ...FIRST_TURN.slice(0, 2),
    {
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
      arguments: '{"cmd":"bun test"}',
    },
    { type: "message", role: "developer", content: "Approval: never" },
    { type: "function_call_output", call_id: "call_1", output: "2 passed" },
  ])

  expect(systemText(payload.system)).toBe(
    "You are Codex.\n\nSandbox: workspace-write",
  )
  expect(mergeTurns(payload.messages).slice(1)).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "exec_command",
          input: { cmd: "bun test" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "2 passed" },
        reminder("Approval: never"),
      ],
    },
  ])
})

test("instructions before the first answer remain the system prompt", async () => {
  const payload = await translate([
    FIRST_TURN[0],
    { type: "message", role: "user", content: "<environment_context />" },
    { type: "message", role: "developer", content: "Mode: plan" },
    ASK,
  ])

  expect(systemText(payload.system)).toBe(
    "You are Codex.\n\nSandbox: workspace-write\n\nMode: plan",
  )
  expect(JSON.stringify(payload.messages)).not.toContain("system-reminder")
})
