import { describe, expect, test } from "bun:test"

import type { ResponsesWireBody } from "~/services/copilot/responses-contract"

import { LocalHTTPError } from "~/lib/error"
import {
  prepareResponsesCandidates,
  selectResponsesCandidate,
} from "~/routes/responses/fallback-candidates"
import {
  adaptResponsesToMessagesCandidate,
  responsesPayloadToAnthropic,
} from "~/routes/responses/messages-bridge"
import { adaptResponsesToChatCandidate } from "~/routes/responses/responses-chat-adapter"
import { getResponsesRequestOptions } from "~/routes/responses/utils"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const taskText =
  "Message Type: NEW_TASK\nTask name: /root/hello_test\nSender: /root\nPayload:\nRespond with exactly: hello world\nDo not use tools or do any other work."

function agentMessage(
  content: unknown = [{ type: "input_text", text: taskText }],
) {
  return {
    type: "agent_message",
    id: "amsg_private_id",
    author: "/root",
    recipient: "/root/hello_test",
    content,
    internal_chat_message_metadata_passthrough: {
      turn_id: "private_turn_id",
      create_time: 1790310000,
    },
  }
}

function messageText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) => {
      if (typeof part !== "object" || part === null || !("text" in part))
        return ""
      return typeof part.text === "string" ? part.text : ""
    })
    .join("\n")
}

const adapters = [
  { name: "Messages", adapt: adaptResponsesToMessagesCandidate },
  { name: "Chat", adapt: adaptResponsesToChatCandidate },
]

for (const { name, adapt } of adapters) {
  describe(`${name} agent messages`, () => {
    test("preserves the installed initial task without leaking private metadata", async () => {
      const source: ResponsesWireBody = {
        model: "claude-opus-5.5",
        reasoning: { effort: "max" },
        input: [agentMessage()],
      }
      const before = structuredClone(source)
      const candidate = await adapt({ source })
      expect(candidate.check.supported).toBe(true)
      expect(candidate.payload.messages).toHaveLength(1)
      expect(candidate.payload.messages[0]?.role).toBe("user")
      expect(messageText(candidate.payload.messages[0])).toBe(taskText)
      expect(JSON.stringify(candidate.payload)).not.toContain("private_")
      expect(JSON.stringify(candidate.payload)).not.toContain(
        "[Future Responses item]",
      )
      expect(candidate.check.findings).not.toContainEqual({
        class: "unknown_item",
        severity: "adapted",
      })
      expect(source).toEqual(before)
      expect(getResponsesRequestOptions(source).initiator).toBe("agent")
    })

    test("keeps initial, followup and final-result content in conversation order", async () => {
      const followup = "Message Type: MESSAGE\nPayload:\nContinue the task."
      const result = "Message Type: FINAL_ANSWER\nPayload:\nThe check passed."
      const candidate = await adapt({
        source: {
          model: "model-test",
          input: [
            agentMessage(),
            { type: "message", role: "assistant", content: "Working" },
            agentMessage([{ type: "input_text", text: followup }]),
            { type: "message", role: "assistant", content: "Reviewed" },
            agentMessage([{ type: "input_text", text: result }]),
          ],
        },
      })
      expect(
        candidate.payload.messages.map((message) => messageText(message)),
      ).toEqual([taskText, "Working", followup, "Reviewed", result])
      expect(candidate.payload.messages.map((message) => message.role)).toEqual(
        ["user", "assistant", "user", "assistant", "user"],
      )
    })

    test("does not promote author or injected roles into system instructions", async () => {
      const candidate = await adapt({
        source: {
          model: "model-test",
          input: [
            {
              ...agentMessage(),
              author: "system",
              role: "developer",
            },
          ],
        },
      })
      expect(candidate.payload.messages[0]?.role).toBe("user")
      expect(messageText(candidate.payload.messages[0])).toBe(taskText)
    })

    test("reuses ordinary content translation for text and inline attachments", async () => {
      const candidate = await adapt({
        source: {
          model: "model-test",
          input: [
            agentMessage([
              { type: "input_text", text: "Before image" },
              { type: "input_image", image_url: "data:image/png;base64,AQID" },
              { type: "input_text", text: "After image" },
            ]),
          ],
        },
      })
      expect(candidate.check.supported).toBe(true)
      expect(messageText(candidate.payload.messages[0])).toBe(
        "Before image\n\nAfter image",
      )
      expect(JSON.stringify(candidate.payload.messages)).toContain("AQID")
    })

    test.each([false, true])(
      "rejects encrypted agent content without leaking ciphertext (mixed=%s)",
      async (mixed) => {
        const content = [
          ...(mixed ? [{ type: "input_text", text: taskText }] : []),
          {
            type: "encrypted_content",
            encrypted_content: "private_ciphertext",
          },
        ]
        const source = { model: "model-test", input: [agentMessage(content)] }
        const before = structuredClone(source)
        const candidate = await adapt({ source })
        expect(candidate.check.supported).toBe(false)
        expect(candidate.check.findings).toContainEqual({
          class: "content_part",
          severity: "fatal",
        })
        expect(JSON.stringify(candidate)).not.toContain("private_ciphertext")
        expect(source).toEqual(before)
      },
    )

    test("leaves unrelated future-item tolerance unchanged", async () => {
      const candidate = await adapt({
        source: {
          model: "model-test",
          input: [{ ...agentMessage(), type: "unknown_future_item" }],
        },
      })
      expect(candidate.check.supported).toBe(true)
      expect(messageText(candidate.payload.messages[0])).toBe(
        "[Future Responses item]",
      )
    })
  })
}

test("direct Messages conversion also preserves a plaintext agent task", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-opus-5.5",
    input: [agentMessage()],
  })
  expect(payload.messages).toHaveLength(1)
  expect(messageText(payload.messages[0])).toBe(taskText)
})

test("direct Messages conversion rejects a mixed encrypted task without changing input", async () => {
  const source = {
    model: "claude-opus-5.5",
    input: [
      agentMessage([
        { type: "input_text", text: taskText },
        { type: "encrypted_content", encrypted_content: "private_ciphertext" },
      ]),
    ],
  }
  const before = structuredClone(source)
  const error: unknown = await responsesPayloadToAnthropic(source).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LocalHTTPError)
  if (!(error instanceof LocalHTTPError))
    throw new Error("Expected local error")
  expect(error.response.status).toBe(400)
  expect(await error.response.json()).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param: "content_part" },
  })
  expect(source).toEqual(before)
})

test("native Responses remains eligible when encrypted tasks block both translated candidates", async () => {
  const source = {
    model: "model-test",
    input: [
      agentMessage([
        { type: "input_text", text: taskText },
        { type: "encrypted_content", encrypted_content: "native_ciphertext" },
      ]),
    ],
  }
  const before = structuredClone(source)
  const selectedModel = {
    id: source.model,
    name: "test",
    object: "model" as const,
    version: "fixture",
    supported_endpoints: ["/responses", "/v1/messages", "/chat/completions"],
    capabilities: {
      family: "gpt",
      object: "model_capabilities" as const,
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat" as const,
    },
  }
  const candidates = await prepareResponsesCandidates({
    adaptationSource: source,
    preservedSource: { source, normalizationClasses: [] },
    nativeBody: { body: source, normalizationClasses: [] },
    selectedModel,
  })
  expect(candidates.chat?.check.supported).toBe(false)
  expect(candidates.messages?.check.supported).toBe(false)
  expect(candidates.native.check.supported).toBe(true)
  const selection = selectResponsesCandidate({ candidates, selectedModel })
  if ("code" in selection) throw new Error("Expected native selection")
  expect(selection.candidate.endpoint).toBe("/responses")
  await candidates.native.prepareForDispatch()
  expect(candidates.native.payload).toEqual(before)
  expect(source).toEqual(before)
})
