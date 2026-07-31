import { describe, expect, test } from "bun:test"

import type { ParsedResponsesBody } from "../ui/src/lib/responses-body"

import {
  createResponseExportActions,
  executeResponseExport,
  responseExportAvailability,
} from "../ui/src/lib/response-export-actions"

const parsed: ParsedResponsesBody = {
  assistantText: "Final answer",
  copilotUsage: null,
  errorMessage: null,
  events: [],
  isPartial: false,
  reasoningText: "",
  response: { id: "resp_1", status: "completed" },
  status: "completed",
  toolCalls: [],
  usage: null,
}

const response = {
  body: '{"ok":true}',
  headers: { "content-type": "application/json" },
  status: 200,
  statusText: "OK",
}

describe("response export actions", () => {
  test("does not build payloads until the matching action is activated", () => {
    const calls = { assistant: 0, json: 0, raw: 0 }
    const actions = createResponseExportActions(
      { parsed, response },
      {
        buildAssistantOutputMarkdown: () => {
          calls.assistant += 1
          return "assistant"
        },
        buildRawHttpResponse: () => {
          calls.raw += 1
          return "raw"
        },
        buildResponseJson: () => {
          calls.json += 1
          return "json"
        },
      },
    )

    expect(calls).toEqual({ assistant: 0, json: 0, raw: 0 })
    expect(actions.buildAssistantOutput()).toBe("assistant")
    expect(calls).toEqual({ assistant: 1, json: 0, raw: 0 })
    expect(actions.buildResponseJson()).toBe("json")
    expect(calls).toEqual({ assistant: 1, json: 1, raw: 0 })
    expect(actions.buildRawHttpResponse()).toBe("raw")
    expect(calls).toEqual({ assistant: 1, json: 1, raw: 1 })
  })

  test("derives menu availability without building an export payload", () => {
    expect(responseExportAvailability({ parsed, response })).toEqual({
      assistantOutput: true,
      rawHttpResponse: true,
      responseJson: true,
    })
    expect(
      responseExportAvailability({
        parsed: null,
        response: { ...response, body: "plain text", headers: {} },
      }),
    ).toEqual({
      assistantOutput: false,
      rawHttpResponse: true,
      responseJson: false,
    })
  })

  test("keeps JSON export eligible for a scalar JSON candidate", () => {
    expect(
      responseExportAvailability({
        parsed: null,
        response: { ...response, body: "  true", headers: {} },
      }).responseJson,
    ).toBe(true)
  })

  test("keeps normalized JSON eligible when parsed data has no raw response", () => {
    expect(
      responseExportAvailability({ parsed, response: undefined }).responseJson,
    ).toBe(true)
  })

  test("reports a lazy builder exception through the activation path", () => {
    const messages: Array<string> = []
    const downloads: Array<string> = []

    const result = executeResponseExport({
      build: () => {
        throw new Error("Response builder failed")
      },
      download: (contents) => downloads.push(contents),
      emptyMessage: "Response JSON is unavailable",
      onError: (message) => messages.push(message),
    })

    expect(result).toEqual({
      message: "Response builder failed",
      status: "error",
    })
    expect(messages).toEqual(["Response builder failed"])
    expect(downloads).toEqual([])
  })

  test("reports an enabled action that builds no payload", () => {
    const messages: Array<string> = []

    const result = executeResponseExport({
      build: () => null,
      download: () => {
        throw new Error("Download must not run")
      },
      emptyMessage: "Response JSON is unavailable",
      onError: (message) => messages.push(message),
    })

    expect(result).toEqual({
      message: "Response JSON is unavailable",
      status: "error",
    })
    expect(messages).toEqual(["Response JSON is unavailable"])
  })

  test("builds and downloads only when activated successfully", () => {
    const calls: Array<string> = []

    const result = executeResponseExport({
      build: () => {
        calls.push("build")
        return "payload"
      },
      download: (contents) => calls.push(`download:${contents}`),
      emptyMessage: "Response JSON is unavailable",
      onError: (message) => calls.push(`error:${message}`),
    })

    expect(result).toEqual({ status: "success" })
    expect(calls).toEqual(["build", "download:payload"])
  })
})
