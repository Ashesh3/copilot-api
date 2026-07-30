// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
import { expect, mock, test } from "bun:test"

// UI dependencies and their declarations live outside the root TS project.
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"

const detail = {
  durationMs: 125,
  id: "debug-session-1",
  request: {
    body: '{"model":"gpt-test","input":"Hello"}',
    bodyBytes: 36,
    headers: { "content-type": "application/json" },
    method: "POST",
    path: "/responses",
    url: "https://example.test/responses",
  },
  response: {
    body: '{"id":"response-1","output_text":"Hello back"}',
    bodyBytes: 50,
    headers: { "content-type": "application/json" },
    status: 200,
    statusText: "OK",
  },
  startedAt: "2026-07-31T00:00:00.000Z",
  startedAtMs: 1_775_088_000_000,
  status: "complete",
}

const hashRoute = () => ({ param: detail.id, section: "llm-debug" })
const toast = () => ({ error: () => {}, success: () => {} })
const asyncData = () => ({
  data: detail,
  error: undefined,
  loading: false,
  reload: () => {},
  reloadSilently: () => {},
})
const polling = () => {}

await mock.module("../ui/src/lib/router", () => ({
  navigate: () => {},
  useHashRoute: hashRoute,
}))

await mock.module("../ui/src/lib/toast", () => ({
  useToast: toast,
}))

await mock.module("../ui/src/lib/usePolling", () => ({
  useAsyncData: asyncData,
  usePolling: polling,
}))

const llmDebugModule = (await import("../ui/src/screens/LlmDebug")) as {
  default: unknown
}
const LlmDebugScreen = llmDebugModule.default

test("keeps request controls local and delegates response inspection", () => {
  const markup = renderToStaticMarkup(createElement(LlmDebugScreen)) as string
  const requestHeading = markup.indexOf(">Request</h3>")
  const requestExport = markup.indexOf("Export request")

  expect(requestHeading).toBeGreaterThanOrEqual(0)
  expect(requestExport).toBeGreaterThan(requestHeading)
  expect(markup.match(/>Export request<\/span>/g)).toHaveLength(1)
  expect(markup).toContain("Request body format")
  expect(markup).toContain("Wrap request")
  expect(markup).not.toContain("Body format")

  expect(markup).toContain('aria-label="Response views"')
  expect(markup).toContain("Wrap response")
  expect(markup).not.toContain("Response Headers (")
})
