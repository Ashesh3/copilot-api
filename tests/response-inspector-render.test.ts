// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
import { expect, test } from "bun:test"

// UI dependencies and their declarations live outside the root TS project.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"
import { ResponseInspector } from "../ui/src/components/ResponseInspector"

const partialBody = [
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}',
  "",
  "",
].join("\n")

const anthropicBody = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":1}}}',
  "",
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final English response"}}',
  "",
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  "",
  'event: message_stop\ndata: {"type":"message_stop"}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n")

function renderPartialInspector(): string {
  return renderToStaticMarkup(
    createElement(ResponseInspector, {
      id: "response-1",
      responseIdentity: "response-session-1",
      response: {
        body: partialBody,
        headers: { "content-type": "text/event-stream" },
        status: 200,
        statusText: "OK",
      },
      onCopyError: () => {},
      onCopySuccess: () => {},
      onExport: () => {},
      onExportError: () => {},
    }),
  )
}

function renderAnthropicInspector(): string {
  return renderToStaticMarkup(
    createElement(ResponseInspector, {
      id: "anthropic-response",
      responseIdentity: "anthropic-session",
      response: {
        body: anthropicBody,
        headers: { "content-type": "text/event-stream" },
        status: 200,
        statusText: "OK",
      },
      onCopyError: () => {},
      onCopySuccess: () => {},
      onExport: () => {},
      onExportError: () => {},
    }),
  )
}

function renderTimedInspector(durationMs: number): string {
  return renderToStaticMarkup(
    createElement(ResponseInspector, {
      durationMs,
      id: "timed-response",
      responseIdentity: "timed-response-session",
      response: {
        body: '{"id":"response-1","output":[]}',
        headers: { "content-type": "application/json" },
        status: 200,
        statusText: "OK",
      },
      onCopyError: () => {},
      onCopySuccess: () => {},
      onExport: () => {},
      onExportError: () => {},
    }),
  )
}

test("labels the selected response view as a region", () => {
  const markup = renderPartialInspector()

  expect(markup).toContain('role="region" aria-label="output response view"')
  expect(markup).not.toContain('role="tabpanel"')
})

test("directs partial-capture users to the Events tab", () => {
  expect(renderPartialInspector()).toContain(
    "Open the Events tab to inspect the available events.",
  )
})

test("renders assembled Anthropic Messages output instead of an unknown format", () => {
  const markup = renderAnthropicInspector()

  expect(markup).toContain("Final English response")
  expect(markup).toContain("Events (6)")
  expect(markup).not.toContain("This response format is not recognized")
})

test("renders response duration in a human-friendly unit", () => {
  expect(renderTimedInspector(138_000)).toContain("2.3m")
  expect(renderTimedInspector(138_000)).not.toContain("138,000 ms")
})
