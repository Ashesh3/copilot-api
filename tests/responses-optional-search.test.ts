import { expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { setModelSettingsForTest } from "~/lib/model-settings"
import { adaptResponsesToMessagesCandidate } from "~/routes/responses/messages-bridge"
import { adaptResponsesToChatCandidate } from "~/routes/responses/responses-chat-adapter"
import { runWithWebTools } from "~/services/web/tool-context"
import { runManagedWebRequest } from "~/services/web/tool-loop"

setModelSettingsForTest([])
const client = {
  type: "function",
  name: "read_file",
  description: "CALLER_READ",
  parameters: { type: "object", properties: {} },
}

for (const protocol of ["messages", "chat"] as const) {
  const adapt = (source: ResponsesPayload) =>
    protocol === "messages" ?
      adaptResponsesToMessagesCandidate({ source })
    : adaptResponsesToChatCandidate({ source })
  test.each([
    undefined,
    "auto",
    "none",
    "required",
    { type: "function", name: "read_file" },
  ])(
    `Responses->${protocol} omits optional search without blocking client tools, choice=%j`,
    async (choice) => {
      const source: ResponsesPayload = {
        model: "claude-opus-5.5",
        input: "hello",
        tools: [client, { type: "web_search", external_web_access: false }],
        ...(choice === undefined ? {} : { tool_choice: choice }),
      }
      const snapshot = structuredClone(source)
      await runWithWebTools(source, async () => {
        const candidate = await adapt(source)
        const wire = candidate.payload as unknown as Record<string, unknown>
        const dispatched = await runManagedWebRequest({
          protocol,
          payload: wire,
          send: (body, managed) => {
            expect(managed.size).toBe(0)
            return Promise.resolve({ wire: body })
          },
        })
        expect(dispatched).toMatchObject({
          wire: {
            tools: [
              protocol === "messages" ?
                { name: "read_file" }
              : { function: { name: "read_file" } },
            ],
          },
        })
        expect(JSON.stringify(wire.tools)).not.toContain('"web_search"')
        expect(candidate.check.findings).toContainEqual({
          class: "tool_shape",
          severity: "omitted",
        })
      })
      expect(source).toEqual(snapshot)
    },
  )

  test.each(["web_search", "web_search_preview"])(
    `Responses->${protocol} never substitutes another tool for explicitly forced %s`,
    async (type) => {
      const source: ResponsesPayload = {
        model: "claude-opus-5.5",
        input: "search",
        tools: [client, { type }],
        tool_choice: { type },
      }
      const result = await runWithWebTools(source, async () => {
        const candidate = await adapt(source)
        return runManagedWebRequest({
          protocol,
          payload: candidate.payload as unknown as Record<string, unknown>,
          send: () => Promise.resolve({ unexpected: true }),
        })
      }).catch((error: unknown) => error)
      expect(result).toHaveProperty(
        "clientBody.error.code",
        "unsupported_web_tool_combination",
      )
    },
  )

  test(`Responses->${protocol} retains standalone explicit search`, async () => {
    const candidate = await adapt({
      model: "claude-opus-5.5",
      input: "search",
      tools: [{ type: "web_search" }],
    })
    expect(JSON.stringify(candidate.payload.tools)).toContain('"web_search"')
  })

  test(`Responses->${protocol} preserves a caller function named web_search beside the optional hosted declaration`, async () => {
    const callerSearch = {
      ...client,
      name: "web_search",
      description: "CALLER_SEARCH",
    }
    const source: ResponsesPayload = {
      model: "claude-opus-5.5",
      input: "hello",
      tools: [callerSearch, { type: "web_search" }],
    }
    await runWithWebTools(source, async () => {
      const candidate = await adapt(source)
      expect(candidate.payload.tools).toHaveLength(1)
      expect(JSON.stringify(candidate.payload.tools)).toContain("CALLER_SEARCH")
      await runManagedWebRequest({
        protocol,
        payload: candidate.payload as unknown as Record<string, unknown>,
        send: (_body, managed) => {
          expect(managed.size).toBe(0)
          return Promise.resolve({ output: [] })
        },
      })
    })
  })

  test(`Responses->${protocol} rejects forced hosted search even when a caller has the same name`, async () => {
    const source: ResponsesPayload = {
      model: "claude-opus-5.5",
      input: "search",
      tools: [
        { ...client, name: "web_search", description: "CALLER_SEARCH" },
        { type: "web_search" },
      ],
      tool_choice: { type: "web_search" },
    }
    let sends = 0
    const result = await runWithWebTools(source, async () => {
      const candidate = await adapt(source)
      return runManagedWebRequest({
        protocol,
        payload: candidate.payload as unknown as Record<string, unknown>,
        send: () => {
          sends++
          return Promise.resolve({ unexpected: true })
        },
      })
    }).catch((error: unknown) => error)
    expect(result).toHaveProperty(
      "clientBody.error.code",
      "unsupported_web_tool_combination",
    )
    expect(sends).toBe(0)
  })
}
