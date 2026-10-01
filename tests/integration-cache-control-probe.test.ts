import { expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { probeResponsesCacheControl } from "./integration/cache-control-probe"

function model(id: string, vendor = "openai"): Model {
  return {
    id,
    vendor,
    name: id,
    object: "model",
    version: "test",
    supported_endpoints: ["/responses"],
    capabilities: {
      family: vendor,
      object: "model_capabilities",
      supports: {},
      tokenizer: "test",
      type: "chat",
    },
  }
}

function rejection(status = 400, code = "invalid_request_body"): Response {
  return Response.json(
    { error: { code, message: "private upstream text" } },
    {
      status,
    },
  )
}

test("tries later models in provider rotation after unsupported and overloaded choices", async () => {
  const attempted: Array<string> = []
  const result = await probeResponsesCacheControl({
    models: [
      model("a-first"),
      model("a-second"),
      model("b-first", "xai"),
      model("b-second", "xai"),
      model("c-first", "google"),
    ],
    request: (candidate) => {
      attempted.push(candidate.id)
      if (candidate.id === "b-second")
        return Promise.resolve(Response.json({ output: [] }))
      if (candidate.id === "b-first")
        return Promise.resolve(rejection(503, "model_overloaded"))
      return Promise.resolve(rejection())
    },
  })

  expect(attempted).toEqual([
    "a-first",
    "b-first",
    "c-first",
    "a-second",
    "b-second",
  ])
  expect(result.status).toBe(200)
  expect(result.bodyUsed).toBe(true)
})

test("aborts a stalled candidate request and proceeds to a later model", async () => {
  let cancelled = false
  const result = await probeResponsesCacheControl({
    models: [model("stalled"), model("available")],
    candidateTimeoutMs: 15,
    request: (candidate, signal) => {
      if (candidate.id === "available")
        return Promise.resolve(Response.json({ output: [] }))
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true
            reject(signal.reason as Error)
          },
          { once: true },
        )
      })
    },
  })

  expect(cancelled).toBe(true)
  expect(result.status).toBe(200)
})

test("cancels a stalled 200 body instead of accepting its headers", async () => {
  let cancelled = false
  const result = await probeResponsesCacheControl({
    models: [model("stalled-body"), model("complete-body")],
    candidateTimeoutMs: 15,
    request: (candidate) =>
      Promise.resolve(
        candidate.id === "complete-body" ?
          Response.json({ output: [] })
        : new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
              },
            }),
          ),
      ),
  })

  expect(cancelled).toBe(true)
  expect(result.bodyUsed).toBe(true)
})

test("fails with safe provider metadata when every candidate rejects cache control", async () => {
  const pending = probeResponsesCacheControl({
    models: [model("private-model-a"), model("private-model-b", "xai")],
    request: () => Promise.resolve(rejection()),
  })

  const failure = await pending.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('"providerClass":"openai"')
  expect(String(failure)).toContain('"status":400')
  expect(String(failure)).toContain('"code":"invalid_request_body"')
  expect(String(failure)).not.toContain("private-")
  expect(String(failure)).not.toContain("private upstream text")
})

test("does not hide an unexpected local exception behind another candidate", async () => {
  const localError = new TypeError("local defect")
  const attempted: Array<string> = []
  const pending = probeResponsesCacheControl({
    models: [model("broken"), model("unused")],
    request: (candidate) => {
      attempted.push(candidate.id)
      return Promise.reject(localError)
    },
  })

  expect(await pending.catch((error: unknown) => error)).toBe(localError)
  expect(attempted).toEqual(["broken"])
})

test("does not treat an unexplained server failure as model overload", async () => {
  const attempted: Array<string> = []
  const pending = probeResponsesCacheControl({
    models: [model("broken"), model("unused", "xai")],
    request: (candidate) => {
      attempted.push(candidate.id)
      return Promise.resolve(rejection(500, "internal_error"))
    },
  })

  expect(String(await pending.catch((error: unknown) => error))).toContain(
    "internal_error",
  )
  expect(attempted).toEqual(["broken"])
})

test("bounds the number of attempted candidates", async () => {
  const attempted: Array<string> = []
  const pending = probeResponsesCacheControl({
    models: [model("first"), model("second"), model("third")],
    maxCandidates: 2,
    request: (candidate) => {
      attempted.push(candidate.id)
      return Promise.resolve(rejection())
    },
  })

  expect(String(await pending.catch((error: unknown) => error))).toContain(
    "No advertised Responses model",
  )
  expect(attempted).toEqual(["first", "second"])
})

test("stops at the total deadline while cancelling the current request", async () => {
  let cancelled = false
  const attempted: Array<string> = []
  const pending = probeResponsesCacheControl({
    models: [model("stalled"), model("unused")],
    candidateTimeoutMs: 1000,
    totalTimeoutMs: 15,
    request: (candidate, signal) => {
      attempted.push(candidate.id)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true
            reject(signal.reason as Error)
          },
          { once: true },
        )
      })
    },
  })

  expect(String(await pending.catch((error: unknown) => error))).toContain(
    "probe_deadline",
  )
  expect(cancelled).toBe(true)
  expect(attempted).toEqual(["stalled"])
})
