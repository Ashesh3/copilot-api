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
