import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import {
  CAPI_RESPONSES_MAX_REQUEST_BYTES,
  RESPONSES_RECOVERY_MARGIN_BYTES,
} from "~/services/copilot/responses-payload-recovery"

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const requestBodies: Array<Record<string, unknown>> = []
const requestHeaders: Array<Headers> = []

const successResponse = () =>
  Response.json({
    id: "resp_recovered",
    object: "response",
    model: "gpt-4o",
    output: [],
    status: "completed",
  })

const fetchMock = mock((_url: string, init?: RequestInit) => {
  requestHeaders.push(new Headers(init?.headers))
  if (typeof init?.body === "string") {
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>)
  }
  return successResponse()
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  requestBodies.length = 0
  requestHeaders.length = 0
  fetchMock.mockClear()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
})

test("recovers oversized ordinary Responses payloads before one upstream dispatch", async () => {
  const preservedOutput =
    "BEGIN-ORDINARY\n" + "x".repeat(26 * 1024 * 1024) + "\nEND-ORDINARY"
  const inlineFile = `data:application/pdf;base64,${"A".repeat(7 * 1024 * 1024)}`

  await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          type: "custom_tool_call_output",
          call_id: "call_ordinary",
          output: [
            { type: "input_text", text: preservedOutput },
            {
              type: "input_file",
              filename: "oversized.pdf",
              file_data: inlineFile,
            },
          ],
        },
      ],
    },
    { vision: false, initiator: "user" },
  )

  expect(requestBodies).toHaveLength(1)
  const serialized = JSON.stringify(requestBodies[0])
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    CAPI_RESPONSES_MAX_REQUEST_BYTES - RESPONSES_RECOVERY_MARGIN_BYTES,
  )
  expect(serialized).toContain("BEGIN-ORDINARY")
  expect(serialized).toContain("END-ORDINARY")
  expect(serialized).toContain("call_ordinary")
  expect(serialized).not.toContain(inlineFile)
  expect(serialized).toContain(
    "omitted to fit the CAPI Responses request-size limit",
  )
  expect(serialized).not.toContain("UTF-8 bytes omitted during compaction")
})

test("rejects oversized ordinary preserved text without calling upstream", async () => {
  const error = await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "developer",
          content: "preserved".repeat(4 * 1024 * 1024),
        },
      ],
    },
    { vision: false, initiator: "user" },
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(413)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "responses_payload_too_large" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("removes the vision header when recovery removes every attachment", async () => {
  const preservedOutput = "x".repeat(31 * 1024 * 1024)
  const inlineFile = `data:application/pdf;base64,${"A".repeat(2 * 1024 * 1024)}`

  await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          type: "custom_tool_call_output",
          call_id: "call_header",
          output: [
            { type: "input_text", text: preservedOutput },
            {
              type: "input_file",
              filename: "header.pdf",
              file_data: inlineFile,
            },
          ],
        },
      ],
    },
    { vision: true, initiator: "user" },
  )

  expect(requestBodies).toHaveLength(1)
  expect(JSON.stringify(requestBodies[0])).not.toContain(inlineFile)
  expect(requestHeaders[0]?.has("Copilot-Vision-Request")).toBe(false)
})
