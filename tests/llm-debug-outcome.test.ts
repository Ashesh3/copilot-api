import { expect, test } from "bun:test"

import { hasFailedLlmDebugResponse } from "~/lib/llm-debug-outcome"

test.each([
  {
    name: "JSON error envelope",
    body: '{"error":{"code":"invalid_request","message":"Bad request"}}',
  },
  {
    name: "JSON string error envelope",
    body: '{"error":"upstream unavailable"}',
  },
  {
    name: "Messages JSON error envelope",
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Busy"}}',
  },
  {
    name: "failed Responses result",
    body: '{"object":"response","status":"failed","error":null,"output":[]}',
  },
  {
    name: "incomplete Responses result",
    body: '{"object":"response","status":"incomplete","error":null,"output":[]}',
  },
  {
    name: "cancelled Responses result",
    body: '{"object":"response","status":"cancelled","error":null,"output":[]}',
  },
  {
    name: "completed event containing a failed response",
    body: '{"type":"response.completed","response":{"status":"failed","error":null}}',
  },
  {
    name: "completed event containing a response error",
    body: '{"type":"response.completed","response":{"status":"completed","error":{"message":"Failed"}}}',
  },
])("detects $name without an HTTP error status", ({ body }) => {
  expect(hasFailedLlmDebugResponse({ body })).toBe(true)
})

test.each([
  {
    name: "named Responses failure",
    body: 'event: response.failed\ndata: {"response":{"error":null}}\n\n',
  },
  {
    name: "Responses incomplete data event",
    body: 'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
  },
  {
    name: "Messages error event",
    body: 'event: error\ndata: {"type":"error","error":{"message":"Busy"}}\n\n',
  },
  {
    name: "Chat Completions error envelope",
    body: 'data: {"error":{"message":"Quota exceeded"}}\n\ndata: [DONE]\n\n',
  },
  {
    name: "Responses error type without an event field",
    body: 'data: {"type":"error","message":"Bad request","code":"invalid_request"}\n\n',
  },
  {
    name: "named error with a null payload",
    body: "event: error\ndata: null\n\n",
  },
  {
    name: "named error without a payload",
    body: "event: error\n\n",
  },
  {
    name: "named failure with malformed JSON",
    body: "event: response.failed\ndata: {broken\n\n",
  },
  {
    name: "completed event containing an incomplete response",
    body: 'event: response.completed\ndata: {"response":{"status":"incomplete","error":null}}\n\n',
  },
  {
    name: "completed event containing a response error",
    body: 'data: {"type":"response.completed","response":{"status":"completed","error":{"message":"Failed"}}}\n\n',
  },
  {
    name: "multiline data with CRLF",
    body: 'event: response.completed\r\ndata: {"response":\r\ndata: {"status":"failed"}}\r\n\r\n',
  },
  {
    name: "explicit error in the final frame without an empty line",
    body: 'data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"error":{"message":"Failed"}}',
  },
  {
    name: "named error after an initial BOM",
    body: "\uFEFFevent:error\ndata:null\n\n",
  },
])("detects $name in a successful HTTP stream", ({ body }) => {
  expect(
    hasFailedLlmDebugResponse({
      body,
      contentType: "Text/Event-Stream; charset=utf-8",
    }),
  ).toBe(true)
})

test.each([
  null,
  "",
  "This answer explains an error and response.failed events.",
  '{"object":"response","status":"completed","error":null,"output":[{"type":"message","content":[{"type":"output_text","text":"error: response.failed"}]}]}',
  '{"object":"response","status":"completed","error":null,"output":[{"type":"web_search_call","status":"failed"}]}',
  String.raw`{"choices":[{"message":{"content":"{\"error\":{\"message\":\"example\"}}"}}]}`,
  '{"type":"message","content":[{"type":"text","text":"response.incomplete"}],"stop_reason":"end_turn"}',
  '{"object":"response","status":"in_progress","error":null}',
  '{"object":"response","status":"future_status","error":null}',
  '{"type":"response.completed","response":{"status":"completed","error":null}}',
  '{"type":"response.output_item.done","item":{"status":"incomplete","error":{"message":"tool failure"}}}',
  '{"content":{"type":"error","error":{"message":"example"}}}',
  '{"error":null}',
  '{"error":false}',
  '{"error":[]}',
  '{"error":""}',
  '[{"error":{"message":"example"}}]',
  String.raw`"{\"error\":{\"message\":\"example\"}}"`,
  '{"error":',
])("does not infer an unsuccessful JSON response from %j", (body) => {
  expect(
    hasFailedLlmDebugResponse({ body, contentType: "application/json" }),
  ).toBe(false)
})

test.each([
  "data: [DONE]\n\n",
  ': event: error\ndata: {"type":"ping"}\n\n',
  'data: {"type":"response.output_text.delta","delta":"event: error\\ndata: {\\"error\\":true}"}\n\n',
  'event: response.output_item.done\ndata: {"item":{"status":"failed","error":{"message":"tool error"}}}\n\n',
  'data: {"choices":[{"delta":{"content":"error: response.failed"}}]}\n\ndata: [DONE]\n\n',
  'event: response.completed\ndata: {"response":{"status":"completed","error":null}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"unfinished"}\n\n',
  "data: {broken\n\n",
  "event: response.completed\ndata: null\n\n",
  'event: error\nevent: ping\ndata: {"type":"ping"}\n\n',
])("does not infer an unsuccessful stream from %j", (body) => {
  expect(
    hasFailedLlmDebugResponse({ body, contentType: "text/event-stream" }),
  ).toBe(false)
})

test("does not parse plain output as an SSE failure", () => {
  expect(
    hasFailedLlmDebugResponse({
      body: "event: error\ndata: null\n\n",
      contentType: "text/plain",
    }),
  ).toBe(false)
})
