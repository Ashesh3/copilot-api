import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const requestBodies: Array<Record<string, unknown>> = []
let upstreamResponse: Response

beforeEach(() => {
  requestBodies.length = 0
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  upstreamResponse = Response.json({
    id: "resp_plaintext",
    object: "response",
    model: "gpt-6-astra",
    status: "completed",
    output: [functionCall()],
  })
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON request")
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return Promise.resolve(upstreamResponse)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
})

function namespaceTool() {
  return {
    type: "namespace",
    name: "collaboration",
    description: "Agent collaboration",
    tools: ["spawn_agent", "send_message", "followup_task"].map((name) => ({
      type: "function",
      name,
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", encrypted: true },
          target: { type: "string" },
        },
      },
    })),
  }
}

function functionCall() {
  return {
    id: "fc_plaintext",
    type: "function_call",
    namespace: "copilot_collaboration",
    name: "send_message",
    call_id: "call_plaintext",
    arguments: '{"target":"/root/test","message":"hello compatibility"}',
    status: "completed",
    provider_extension: "preserved",
  }
}

function payload(additionalTools: boolean): ResponsesPayload {
  return {
    model: "gpt-6-astra",
    input: [
      ...(additionalTools ?
        [
          {
            type: "additional_tools",
            role: "developer",
            tools: [namespaceTool()],
          },
        ]
      : []),
      { role: "user", content: "Send a test message." },
    ],
    ...(additionalTools ? {} : { tools: [namespaceTool()] }),
  } as ResponsesPayload
}

function wireNamespace(additionalTools: boolean) {
  const body = requestBodies[0]
  const tools =
    additionalTools ?
      (
        body.input as Array<{ tools: Array<ReturnType<typeof namespaceTool>> }>
      )[0].tools
    : (body.tools as Array<ReturnType<typeof namespaceTool>>)
  return tools[0]
}

for (const additionalTools of [false, true]) {
  for (const prepared of [false, true]) {
    test(`preserves plaintext collaboration across the Copilot boundary (additional_tools=${additionalTools}, prepared=${prepared})`, async () => {
      const source = payload(additionalTools)
      const before = structuredClone(source)
      await seedProtocolDatabase()
      const response = await createResponses(source, {
        initiator: "user",
        vision: false,
        prepared,
      })

      expect(requestBodies).toHaveLength(1)
      const namespace = wireNamespace(additionalTools)
      expect(namespace.name).toBe("copilot_collaboration")
      for (const tool of namespace.tools) {
        expect(
          tool.parameters.properties.message as Record<string, unknown>,
        ).toEqual({ type: "string" })
      }
      expect(response).toMatchObject({
        output: [
          {
            ...functionCall(),
            namespace: "collaboration",
            encrypted_function_args: [],
          },
        ],
      })
      expect(source).toEqual(before)
    })
  }
}

test("restores collaboration on streaming item and terminal output snapshots", async () => {
  const frames = [
    {
      type: "response.output_item.added",
      item: { ...functionCall(), arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_plaintext",
      delta: "hello",
    },
    { type: "response.output_item.done", item: functionCall() },
    {
      type: "response.completed",
      response: { id: "resp_plaintext", output: [functionCall()] },
    },
  ]
  upstreamResponse = new Response(
    frames
      .map(
        (frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
  await seedProtocolDatabase()
  const response = await createResponses(
    { ...payload(true), stream: true },
    {
      initiator: "user",
      vision: false,
      prepared: true,
    },
  )
  if (!(Symbol.asyncIterator in response)) throw new Error("Expected stream")
  const received: Array<Record<string, unknown>> = []
  for await (const event of response)
    received.push(JSON.parse(event.data ?? "{}") as Record<string, unknown>)

  for (const index of [0, 2]) {
    expect(received[index].item).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
      call_id: "call_plaintext",
    })
  }
  expect(received[1]).toEqual(frames[1])
  expect(received[3].response).toMatchObject({
    output: [{ namespace: "collaboration", encrypted_function_args: [] }],
  })
})

test("does not relabel an explicitly encrypted upstream function argument", async () => {
  upstreamResponse = Response.json({
    output: [{ ...functionCall(), encrypted_function_args: ["message"] }],
  })
  await seedProtocolDatabase()
  const response = await createResponses(payload(true), {
    initiator: "user",
    vision: false,
    prepared: true,
  })
  expect(response).toMatchObject({
    output: [
      { namespace: "collaboration", encrypted_function_args: ["message"] },
    ],
  })
})

test("aliases history and named tool choices while preserving unrelated schemas", async () => {
  const source = payload(false)
  const historical = {
    ...functionCall(),
    namespace: "collaboration",
    encrypted_function_args: [],
  }
  source.input = [
    historical,
    { type: "function_call_output", call_id: historical.call_id, output: "ok" },
  ]
  source.tool_choice = {
    type: "allowed_tools",
    mode: "required",
    tools: [
      { type: "function", namespace: "collaboration", name: "send_message" },
    ],
  }
  const unrelated = {
    type: "function",
    name: "store_secret",
    parameters: {
      type: "object",
      properties: {
        encrypted: { type: "boolean" },
        message: { type: "string", encrypted: true },
      },
    },
  }
  source.tools?.push(unrelated)
  const before = structuredClone(source)
  await seedProtocolDatabase()
  await createResponses(source, {
    initiator: "user",
    vision: false,
    prepared: true,
  })
  expect(requestBodies[0].input).toEqual([
    { ...historical, namespace: "copilot_collaboration" },
    { type: "function_call_output", call_id: historical.call_id, output: "ok" },
  ])
  expect(requestBodies[0].tool_choice).toEqual({
    type: "allowed_tools",
    mode: "required",
    tools: [
      {
        type: "function",
        namespace: "copilot_collaboration",
        name: "send_message",
      },
    ],
  })
  expect((requestBodies[0].tools as Array<unknown>)[1]).toEqual(unrelated)
  expect(source).toEqual(before)
})

test("avoids alias collisions and restores response tool echoes", async () => {
  const source = payload(false)
  const existing = {
    type: "namespace",
    name: "copilot_collaboration",
    tools: [{ type: "function", name: "lookup" }],
  }
  source.tools?.push(existing)
  const echoedNamespace = namespaceTool()
  echoedNamespace.name = "copilot_collaboration_2"
  for (const tool of echoedNamespace.tools)
    Reflect.deleteProperty(tool.parameters.properties.message, "encrypted")
  upstreamResponse = Response.json({
    output: [
      { ...functionCall(), namespace: "copilot_collaboration_2" },
      { ...functionCall(), name: "lookup" },
    ],
    tools: [echoedNamespace, existing],
    tool_choice: {
      type: "function",
      namespace: "copilot_collaboration_2",
      name: "send_message",
    },
  })
  await seedProtocolDatabase()
  const response = await createResponses(source, {
    initiator: "user",
    vision: false,
    prepared: true,
  })
  expect(wireNamespace(false).name).toBe("copilot_collaboration_2")
  expect(response).toMatchObject({
    output: [
      { namespace: "collaboration", encrypted_function_args: [] },
      { namespace: "copilot_collaboration", name: "lookup" },
    ],
    tools: [namespaceTool(), existing],
    tool_choice: {
      type: "function",
      namespace: "collaboration",
      name: "send_message",
    },
  })
})

test("leaves ordinary collaboration schemas and responses unchanged", async () => {
  const source = payload(false)
  const namespace = source.tools?.[0] as ReturnType<typeof namespaceTool>
  for (const tool of namespace.tools)
    Reflect.deleteProperty(tool.parameters.properties.message, "encrypted")
  const before = structuredClone(source)
  await seedProtocolDatabase()
  const response = await createResponses(source, {
    initiator: "user",
    vision: false,
    prepared: true,
  })
  expect(requestBodies[0].tools).toEqual(before.tools)
  expect(response).toMatchObject({ output: [functionCall()] })
})

test("leaves existing encrypted agent messages intact after a single upstream rejection", async () => {
  const agentMessage = {
    type: "agent_message",
    author: "/root/worker",
    recipient: "/root",
    content: [
      { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "opaque-prior-message" },
    ],
  }
  const source = payload(true)
  if (!Array.isArray(source.input)) throw new Error("Expected array input")
  source.input.push(agentMessage)
  upstreamResponse = Response.json(
    {
      error: {
        code: "invalid_request_body",
        message:
          "Encrypted function output content could not be decrypted or decoded.",
      },
    },
    { status: 400 },
  )
  await seedProtocolDatabase()
  const error = await createResponses(source, {
    initiator: "user",
    vision: false,
    prepared: true,
  }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response.status).toBe(400)
  expect(requestBodies).toHaveLength(1)
  expect((requestBodies[0].input as Array<unknown>).at(-1)).toEqual(
    agentMessage,
  )
  expect(source.input.at(-1)).toEqual(agentMessage)
})
