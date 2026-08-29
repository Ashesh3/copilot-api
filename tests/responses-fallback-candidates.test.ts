import { afterEach, expect, mock, test } from "bun:test"

import {
  prepareResponsesCandidates,
  selectResponsesCandidate,
} from "~/routes/responses/fallback-candidates"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const selectedModel = {
  id: "gpt-test",
  name: "test",
  object: "model" as const,
  version: "1",
  supported_endpoints: ["/chat/completions", "/responses", "/v1/messages"],
  capabilities: {
    family: "gpt",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities" as const,
    supports: {},
    tokenizer: "o200k_base",
    type: "chat" as const,
  },
}

test("builds independent endpoint-correlated Responses candidates", async () => {
  const source = {
    source: {
      model: "gpt-source",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [{ type: "future_tool", marker: "source-only" }],
      store: false,
    },
    normalizationClasses: [],
  }
  const nativeBody = {
    body: {
      model: "gpt-test",
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [{ type: "future_tool", marker: "native-only" }],
      store: false,
    },
    normalizationClasses: [],
  }

  const candidates = await prepareResponsesCandidates({
    preservedSource: source,
    adaptationSource: { ...source.source, model: "gpt-test" },
    nativeBody,
    selectedModel,
  })

  expect(candidates.native.payload).toEqual(nativeBody.body)
  expect(candidates.native.payload).not.toBe(nativeBody.body)
  expect(candidates.chat?.payload.tools).toBeUndefined()
  expect(candidates.messages?.payload.tools).toBeUndefined()
  ;(candidates.native.payload.tools?.[0] as Record<string, unknown>).marker =
    "changed"
  expect(nativeBody.body.tools[0].marker).toBe("native-only")
  expect(source.source.tools[0].marker).toBe("source-only")

  const selection = selectResponsesCandidate({ candidates, selectedModel })
  if ("code" in selection) throw new Error("selection unexpectedly failed")
  expect(selection.candidate).toBe(candidates.native)
  expect(selection.candidate.payload).toBe(candidates.native.payload)
})

test("selects the cheapest viable translated candidate when native is unavailable", async () => {
  const source = {
    source: {
      model: "gpt-test",
      input: [{ type: "message", role: "user", content: "hello" }],
      store: false,
    },
    normalizationClasses: [],
  }
  const model = {
    ...selectedModel,
    supported_endpoints: ["/chat/completions", "/v1/messages"],
  }
  const candidates = await prepareResponsesCandidates({
    preservedSource: source,
    adaptationSource: source.source,
    nativeBody: { body: source.source, normalizationClasses: [] },
    selectedModel: model,
  })

  const selection = selectResponsesCandidate({
    candidates,
    selectedModel: model,
  })
  if ("code" in selection) throw new Error("selection unexpectedly failed")
  expect(selection.candidate.endpoint).toBe("/chat/completions")
})

test("keeps redirect verbosity out of translated candidate scoring", async () => {
  const source = {
    source: {
      model: "gpt-test",
      input: [{ type: "message", role: "user", content: "hello" }],
      store: false,
    },
    normalizationClasses: [],
  }
  const model = {
    ...selectedModel,
    supported_endpoints: ["/chat/completions", "/v1/messages"],
  }

  const candidates = await prepareResponsesCandidates({
    preservedSource: source,
    adaptationSource: source.source,
    nativeBody: { body: source.source, normalizationClasses: [] },
    responsesVerbosity: "high",
    selectedModel: model,
  })

  expect(candidates.native.payload.text).toEqual({ verbosity: "high" })
  expect(candidates.chat?.check.findings).toEqual([])
  const selection = selectResponsesCandidate({
    candidates,
    selectedModel: model,
  })
  if ("code" in selection) throw new Error("selection unexpectedly failed")
  expect(selection.candidate.endpoint).toBe("/chat/completions")
})

test("shares same-mode attachment promises while separating PDF expectation", async () => {
  const requests: Array<string> = []
  globalThis.fetch = mock((input: string | URL | Request) => {
    requests.push(input instanceof Request ? input.url : input.toString())
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/octet-stream" },
      }),
    )
  }) as unknown as typeof fetch
  const attachment = "HTTP://USER:PASS@PRIVATE.TEST:80/shared"
  const source = {
    source: {
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: attachment },
            { type: "input_image", image_url: attachment },
            { type: "input_file", file_url: attachment, filename: "a.pdf" },
          ],
        },
      ],
      store: false,
    },
    normalizationClasses: [],
  }

  const candidates = await prepareResponsesCandidates({
    preservedSource: source,
    adaptationSource: source.source,
    nativeBody: { body: source.source, normalizationClasses: [] },
    selectedModel,
  })

  expect(requests).toEqual([
    "http://USER:PASS@private.test/shared",
    "http://USER:PASS@private.test/shared",
  ])
  expect(JSON.stringify(candidates.chat?.payload)).toContain("AQID")
  expect(JSON.stringify(candidates.messages?.payload)).toContain("AQID")
  expect(JSON.stringify(source)).toContain(attachment)
})
