import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { ReasoningStateRejection } from "~/services/copilot/responses-reasoning-state"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { adaptResponsesToMessagesCandidate } from "~/routes/responses/messages-bridge"
import { adaptResponsesToChatCandidate } from "~/routes/responses/responses-chat-adapter"
import { fitResponsesCompactionPayload } from "~/services/copilot/compaction-payload"
import { createResponses } from "~/services/copilot/create-responses"
import { recoverResponsesPayload } from "~/services/copilot/responses-payload-recovery"
import {
  classifyReasoningStateRejection,
  resetRejectedReasoningStateForTest,
} from "~/services/copilot/responses-reasoning-state"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const requests: Array<Record<string, unknown>> = []
const queued: Array<Response> = []

const FOREIGN_STATE = "input item does not belong to this connection"
const earlierReasoning = {
  type: "reasoning",
  summary: [{ type: "summary_text", text: "Planned the fix." }],
  encrypted_content: "state-from-earlier-turn",
}
const latestReasoning = {
  type: "reasoning",
  summary: [],
  encrypted_content: "state-from-this-turn",
}
const foreignReasoning = {
  type: "reasoning",
  summary: [],
  encrypted_content: "state-from-another-account",
}

function completed(): Response {
  return Response.json({
    id: "resp_reasoning",
    object: "response",
    model: "gpt-6-astra",
    status: "completed",
    output: [],
  })
}

function rejection(error: Record<string, unknown>): Response {
  return Response.json({ error }, { status: 400 })
}

function screenshot(size: number): Record<string, unknown> {
  return {
    type: "input_image",
    image_url: `data:image/png;base64,${"A".repeat(size)}`,
  }
}

beforeEach(() => {
  requests.length = 0
  queued.length = 0
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    return Promise.resolve(queued.shift() ?? completed())
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  resetRejectedReasoningStateForTest()
})

function conversation(
  ...reasoning: Array<Record<string, unknown>>
): ResponsesPayload {
  return {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: "Fix the failing test." },
      ...reasoning,
      {
        type: "function_call",
        call_id: "call_tests",
        name: "run_tests",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_tests", output: "failed" },
    ] as ResponsesPayload["input"],
    include: ["reasoning.encrypted_content"],
  }
}

async function send(
  payload: ResponsesPayload,
  allowCompatibilityRetry?: boolean,
): Promise<unknown> {
  await seedProtocolDatabase()
  return await createResponses(payload, {
    allowCompatibilityRetry,
    initiator: "agent",
    prepared: true,
    vision: false,
  })
}

test("replays Copilot reasoning state to the model", async () => {
  await send(conversation(earlierReasoning, latestReasoning))

  expect(requests).toHaveLength(1)
  expect(requests[0].input).toContainEqual(earlierReasoning)
  expect(requests[0].input).toContainEqual(latestReasoning)
})

test("removes unreadable reasoning state only from the request that failed", async () => {
  queued.push(
    rejection({
      code: "invalid_encrypted_content",
      message: "The encrypted content for item rs_1 could not be verified.",
    }),
  )
  await send(conversation(earlierReasoning))
  requests.length = 0

  await send(conversation(earlierReasoning))

  expect(requests).toHaveLength(1)
  expect(requests[0].input).toContainEqual(earlierReasoning)
})

test.each([
  { name: "another account's state", error: { message: FOREIGN_STATE } },
  {
    name: "unverifiable state",
    error: {
      code: "invalid_encrypted_content",
      message: "The encrypted content for item rs_1 could not be verified.",
    },
  },
  {
    name: "unreadable state",
    error: {
      code: "invalid_request_body",
      message: "Encrypted content could not be decrypted or parsed.",
    },
  },
])(
  "resends once without reasoning state Copilot rejects as $name",
  async ({ error }) => {
    queued.push(rejection(error))

    // WebSocket turns disable compatibility retries; this recovery still runs.
    await send(conversation(earlierReasoning), false)

    expect(requests).toHaveLength(2)
    expect(requests[0].input).toContainEqual(earlierReasoning)
    expect(requests[1].input).toContainEqual({
      type: "reasoning",
      summary: earlierReasoning.summary,
    })
    expect(JSON.stringify(requests[1].input)).not.toContain(
      earlierReasoning.encrypted_content,
    )
  },
)

test("omits refused reasoning state up front on later turns and keeps new state", async () => {
  queued.push(rejection({ message: FOREIGN_STATE }))
  await send(conversation(earlierReasoning))
  requests.length = 0

  await send(conversation(earlierReasoning, latestReasoning))

  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0].input)).not.toContain(
    earlierReasoning.encrypted_content,
  )
  expect(requests[0].input).toContainEqual(latestReasoning)
})

test("does not resend when no reasoning state was replayed", async () => {
  queued.push(
    rejection({
      code: "invalid_encrypted_content",
      message: "The encrypted content for item cmp_1 could not be verified.",
    }),
  )

  const error = await send(
    { model: "gpt-6-astra", input: "hello" },
    false,
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests).toHaveLength(1)
})

test("keeps reasoning state when removing it does not resolve the rejection", async () => {
  queued.push(
    rejection({ message: FOREIGN_STATE }),
    rejection({ message: FOREIGN_STATE }),
  )

  const error = await send(conversation(earlierReasoning)).catch(
    (caught: unknown) => caught,
  )
  requests.length = 0
  await send(conversation(earlierReasoning))

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests[0].input).toContainEqual(earlierReasoning)
})

test("keeps state the account accepted when a turn mixes in refused state", async () => {
  await send(conversation(earlierReasoning))
  queued.push(rejection({ message: FOREIGN_STATE }))
  requests.length = 0

  await send(conversation(earlierReasoning, foreignReasoning))
  await send(conversation(earlierReasoning, foreignReasoning))

  // Only the unfamiliar state is removed, then left out up front.
  expect(requests).toHaveLength(3)
  expect(requests[1].input).toContainEqual(earlierReasoning)
  for (const request of requests.slice(1)) {
    expect(JSON.stringify(request.input)).not.toContain(
      foreignReasoning.encrypted_content,
    )
  }
  expect(requests[2].input).toContainEqual(earlierReasoning)
})

test("does not remember state when the resend fails for another reason", async () => {
  queued.push(
    rejection({ message: FOREIGN_STATE }),
    rejection({ message: "prompt is too long" }),
  )

  const error = await send(conversation(foreignReasoning)).catch(
    (caught: unknown) => caught,
  )
  requests.length = 0
  await send(conversation(foreignReasoning))

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests).toHaveLength(1)
  expect(requests[0].input).toContainEqual(foreignReasoning)
})

test("removes all state, for this request only, when the account refuses state it accepted", async () => {
  await send(conversation(earlierReasoning, latestReasoning))
  // Accepted state can still expire.
  queued.push(rejection({ message: FOREIGN_STATE }))
  requests.length = 0

  await send(conversation(earlierReasoning, latestReasoning))
  await send(conversation(earlierReasoning, latestReasoning))

  expect(requests).toHaveLength(3)
  expect(JSON.stringify(requests[1].input)).not.toContain("encrypted_content")
  expect(requests[2].input).toContainEqual(earlierReasoning)
  expect(requests[2].input).toContainEqual(latestReasoning)
})

test("removes only the unreadable state Copilot quotes", async () => {
  const readable = {
    ...earlierReasoning,
    encrypted_content: "AAAAreadableZZZZ",
  }
  const corrupt = { ...latestReasoning, encrypted_content: "BBBBcorruptYYYY" }
  queued.push(
    rejection({
      code: "invalid_request_body",
      message:
        "The encrypted content BBBB...YYYY could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    }),
  )

  await send(conversation(readable, corrupt), false)

  expect(requests).toHaveLength(2)
  expect(requests[1].input).toContainEqual(readable)
  expect(requests[1].input).toContainEqual({ type: "reasoning", summary: [] })
})

test("keeps reasoning state when Copilot quotes other unreadable state", async () => {
  queued.push(
    rejection({
      code: "invalid_request_body",
      message:
        "The encrypted content QQQQ...WWWW could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    }),
  )

  const error = await send(conversation(earlierReasoning), false).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(HTTPError)
  expect(requests).toHaveLength(1)
})

test("recovers refused reasoning state that a compatibility resend reveals", async () => {
  queued.push(
    rejection({
      code: "invalid_request_body",
      message:
        "Unsupported parameter: 'temperature' is not supported with this model.",
    }),
    rejection({ message: FOREIGN_STATE }),
  )

  await send({ ...conversation(foreignReasoning), temperature: 0.2 })

  expect(requests).toHaveLength(3)
  expect(requests[1]).not.toHaveProperty("temperature")
  expect(requests[1].input).toContainEqual(foreignReasoning)
  expect(JSON.stringify(requests[2].input)).not.toContain(
    foreignReasoning.encrypted_content,
  )
})

test.each<[Record<string, unknown>, ReasoningStateRejection | undefined]>([
  [{ message: "Input item does not belong to this connection" }, "foreign"],
  [
    {
      code: "input_item_connection_mismatch",
      message: "input item does not belong to this connection",
    },
    "foreign",
  ],
  [{ code: "invalid_encrypted_content", message: "rejected" }, "unreadable"],
  [
    {
      code: "invalid_request_body",
      message:
        "The encrypted content a96q...p3k= could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    },
    "unreadable",
  ],
  [{ message: "Input item ID does not belong to this connection" }, undefined],
  [
    { message: "previous_response_id does not belong to this connection" },
    undefined,
  ],
  [{ code: "server_error", message: FOREIGN_STATE }, undefined],
  [{ message: "prompt is too long" }, undefined],
])("classifies %j as %p", async (error, expected) => {
  expect(
    await classifyReasoningStateRejection(
      Response.json({ error }, { status: 400 }),
    ),
  ).toBe(expected)
})

test("classifies only client errors as refused reasoning state", async () => {
  expect(
    await classifyReasoningStateRejection(
      Response.json({ error: { message: FOREIGN_STATE } }, { status: 500 }),
    ),
  ).toBeUndefined()
})

test("drops only the oldest reasoning state when that alone fits", async () => {
  const image = {
    type: "input_image",
    image_url: `data:image/png;base64,${"A".repeat(400)}`,
  }
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [image] },
      { type: "reasoning", summary: [], encrypted_content: "a".repeat(2000) },
      { type: "reasoning", summary: [], encrypted_content: "b".repeat(2000) },
      { type: "message", role: "user", content: "Continue." },
    ],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")

  const result = await recoverResponsesPayload(payload, {
    maxBytes: bytes - 1000,
    recoveryMarginBytes: 0,
  })

  expect(result).toMatchObject({
    omittedReasoningStates: 1,
    downscaledImages: 0,
    removedCurrentBinaries: 0,
    removedHistoricalBinaries: 0,
    reduced: true,
  })
  expect(result.payload.input[0]).toEqual(payload.input[0])
  expect(result.payload.input[1]).not.toHaveProperty("encrypted_content")
  expect(result.payload.input[2]).toEqual(payload.input[2])
  expect(result.finalBytes).toBe(
    Buffer.byteLength(JSON.stringify(result.payload), "utf8"),
  )
  expect(payload.input[1]).toHaveProperty("encrypted_content")
})

test("keeps reasoning state while images shrink when dropping it cannot fit", async () => {
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [screenshot(4000)] },
      { type: "reasoning", summary: [], encrypted_content: "a".repeat(500) },
      { type: "reasoning", summary: [], encrypted_content: "b".repeat(500) },
    ],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")

  const result = await recoverResponsesPayload(payload, {
    maxBytes: bytes - 2000,
    recoveryMarginBytes: 0,
    resizeImage: ({ dataUri, targetDataUriBytes }) =>
      Promise.resolve({
        dataUri: dataUri.slice(0, targetDataUriBytes),
        outcome: "resized",
      }),
  })

  expect(result).toMatchObject({
    omittedReasoningStates: 0,
    downscaledImages: 1,
    removedCurrentBinaries: 0,
    removedHistoricalBinaries: 0,
  })
  expect(result.payload.input[1]).toEqual(payload.input[1])
  expect(result.payload.input[2]).toEqual(payload.input[2])
})

test("drops old reasoning state before removing an image that cannot shrink enough", async () => {
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [screenshot(4000)] },
      { type: "reasoning", summary: [], encrypted_content: "a".repeat(1000) },
      { type: "reasoning", summary: [], encrypted_content: "b".repeat(1000) },
    ],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")

  const result = await recoverResponsesPayload(payload, {
    maxBytes: bytes - 3000,
    recoveryMarginBytes: 0,
    // Halves the image, short of the size it was asked for.
    resizeImage: ({ dataUri }) =>
      Promise.resolve({
        dataUri: dataUri.slice(0, dataUri.length / 2),
        outcome: "resized",
      }),
  })

  expect(result).toMatchObject({
    omittedReasoningStates: 1,
    downscaledImages: 1,
    removedCurrentBinaries: 0,
    removedHistoricalBinaries: 0,
  })
  expect(result.payload.input[1]).not.toHaveProperty("encrypted_content")
  expect(result.payload.input[2]).toEqual(payload.input[2])
})

test("compaction drops only the oldest reasoning state when that alone fits", () => {
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "reasoning", summary: [], encrypted_content: "a".repeat(3000) },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "x".repeat(3000),
      },
      { type: "reasoning", summary: [], encrypted_content: "b".repeat(3000) },
    ],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")

  const result = fitResponsesCompactionPayload(payload, bytes - 1000)

  expect(result).toMatchObject({
    omittedReasoningStates: 1,
    omittedBinaryBlocks: 0,
    truncatedToolOutputBytes: 0,
    reduced: true,
  })
  expect(result.payload.input[0]).not.toHaveProperty("encrypted_content")
  expect(result.payload.input[2]).toEqual(payload.input[2])
  expect(result.payload.input[3]).toEqual(payload.input[3])
})

test("compaction keeps reasoning state when eliding attachments is enough", () => {
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [screenshot(4000)] },
      { type: "reasoning", summary: [], encrypted_content: "a".repeat(500) },
      { type: "reasoning", summary: [], encrypted_content: "b".repeat(500) },
    ],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")

  const result = fitResponsesCompactionPayload(payload, bytes - 2000)

  expect(result).toMatchObject({
    omittedReasoningStates: 0,
    omittedBinaryBlocks: 1,
    truncatedToolOutputBytes: 0,
  })
  expect(result.payload.input[1]).toEqual(payload.input[1])
  expect(result.payload.input[2]).toEqual(payload.input[2])
})

test("compaction drops reasoning state before truncating tool output", () => {
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [screenshot(1000)] },
      { type: "reasoning", summary: [], encrypted_content: "a".repeat(1000) },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "x".repeat(4000),
      },
      { type: "reasoning", summary: [], encrypted_content: "b".repeat(1000) },
    ],
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8")

  const result = fitResponsesCompactionPayload(payload, bytes - 2500)

  expect(result).toMatchObject({
    omittedReasoningStates: 2,
    omittedBinaryBlocks: 1,
    truncatedToolOutputBytes: 0,
  })
  expect(result.payload.input[3]).toEqual(payload.input[3])
})

test("translated routes keep the reasoning summary without Copilot state", async () => {
  const source = {
    model: "claude-opus-5.5",
    input: [
      { type: "message", role: "user", content: "Hi" },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Considered options." }],
        encrypted_content: "copilot-reasoning-state",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello." }],
      },
    ],
  }

  const messages = await adaptResponsesToMessagesCandidate({ source })
  const chat = await adaptResponsesToChatCandidate({ source })

  for (const translated of [messages.payload, chat.payload]) {
    const serialized = JSON.stringify(translated)
    expect(serialized).toContain("Considered options.")
    expect(serialized).not.toContain("copilot-reasoning-state")
    expect(serialized).not.toContain("[Assistant reasoning context]")
  }
  expect(source.input[1]).toHaveProperty("encrypted_content")
})
