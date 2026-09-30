// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { expect, mock, test } from "bun:test"

import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"

let redirectsUnavailable = false
let safety = { safe: true }

await mock.module("../ui/src/lib/usePolling", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useAsyncData: () => ({
    data: {
      config: {
        enabled: true,
        notifyClient: true,
        nativeClientNotice: false,
        rules: [
          {
            id: "start-a",
            sourceModel: "gpt-6-astra",
            targetModel: "gpt-6-luna",
            enabled: true,
          },
          {
            id: "start-b",
            sourceModel: "gpt-6-sol",
            targetModel: "gpt-6-luna",
            enabled: true,
          },
          {
            id: "shared-1",
            sourceModel: "gpt-6-luna",
            targetModel: "gpt-5.5",
            enabled: true,
          },
          {
            id: "shared-2",
            sourceModel: "gpt-5.5",
            targetModel: "gpt-5.3-codex",
            enabled: true,
          },
          {
            id: "shared-3",
            sourceModel: "gpt-5.3-codex",
            targetModel: "gpt-5.2-codex",
            enabled: true,
          },
          {
            id: "disabled-duplicate",
            sourceModel: "gpt-6-astra",
            targetModel: "claude-sonnet-5",
            enabled: false,
          },
        ],
      },
      safety,
      revision: 13,
      redirectsUnavailable,
      redirects: [
        {
          id: "redirect-1",
          sourceModel: "claude-gpt-5.6-sol",
          sourceEffort: "all",
          targetModel: "gpt-6-sol",
          enabled: true,
          conflicts: [],
        },
        {
          id: "redirect-unrelated",
          sourceModel: "unrelated-redirect",
          sourceEffort: "all",
          targetModel: "unrelated-target",
          enabled: true,
          conflicts: [],
        },
      ],
    },
    error: undefined,
    loading: false,
    reload: () => {},
    reloadSilently: () => {},
  }),
  usePolling: () => {},
  useDelayedPolling: () => {},
}))
await mock.module("../ui/src/lib/toast", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useToast: () => ({ success: () => {}, error: () => {} }),
}))

const { default: FallbacksScreen } = await import("../ui/src/screens/Fallbacks")

test("fallback screen shows unlimited configured chains and keeps disabled rules visible", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))

  expect(markup).toContain("Configured chains")
  expect(markup).toContain("5 possible attempts")
  expect(markup).toContain("Joins the shared continuation at")
  expect(markup).toContain("Additional configured rules")
  expect(markup).toContain("claude-sonnet-5")
  expect(markup).toContain("Also redirects here:")
  expect(markup).toContain("configured fallback links only")
  expect(markup).not.toContain("Conversation affinity")
  expect(markup).not.toContain("Cache lifetime")
  expect(markup).not.toMatch(/3[- ]hop|4 model attempt/i)
})

function elementCount(markup: string, selector: string): number {
  let count = 0
  new HTMLRewriter().on(selector, { element: () => count++ }).transform(markup)
  return count
}

test("the primary add action is in the header before fallback content", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))

  expect(markup.indexOf("Add fallback")).toBeGreaterThan(-1)
  expect(markup.indexOf("Add fallback")).toBeLessThan(
    markup.indexOf("Enable fallbacks"),
  )
  expect(elementCount(markup, 'button[aria-label="Add fallback"]')).toBe(1)
})

test("both client notice controls are visible without opening a disclosure", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))

  expect(
    elementCount(markup, ".fallback-notices details, details.fallback-notices"),
  ).toBe(0)
  expect(elementCount(markup, '.fallback-notices [role="switch"]')).toBe(2)
  expect(markup).toContain("Include diagnostic response headers")
  expect(markup).toContain("Show native client fallback notice")
})

test("redirect aliases appear inline under only the matching chain", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))

  expect(
    elementCount(
      markup,
      '.fallback-chain[data-start-model="gpt-6-sol"] .fallback-redirect-context',
    ),
  ).toBe(1)
  expect(
    elementCount(
      markup,
      '.fallback-chain[data-start-model="gpt-6-astra"] .fallback-redirect-context',
    ),
  ).toBe(0)
  expect(
    elementCount(
      markup,
      '.fallback-redirect-context a[href="#model-redirects"]',
    ),
  ).toBe(1)
  expect(markup).not.toContain("unrelated-redirect")
})

test("the train uses aligned visual connectors and can be extended at its terminal model", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))

  expect(
    elementCount(markup, '.fallback-connector[aria-hidden="true"]'),
  ).toBeGreaterThan(3)
  expect(
    elementCount(markup, 'button[aria-label="Add fallback for gpt-5.2-codex"]'),
  ).toBe(1)
  expect(elementCount(markup, ".fallback-chain h3")).toBe(0)
})

test("duplicate-source rules expose distinct edit actions", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))

  expect(
    elementCount(markup, 'button[aria-label="Edit fallback for gpt-6-astra"]'),
  ).toBe(1)
  expect(
    elementCount(
      markup,
      'button[aria-label="Edit disabled fallback from gpt-6-astra to claude-sonnet-5"]',
    ),
  ).toBe(1)
})

test("every rendered model selector uses native button semantics and pressed state", () => {
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))
  const selectors = [
    ...markup.matchAll(/<button[^>]*fallback-model-button[^>]*>/g),
  ]

  expect(selectors.length).toBeGreaterThan(5)
  expect(selectors.every(([button]) => button.includes('type="button"'))).toBe(
    true,
  )
  expect(selectors.every(([button]) => button.includes("aria-pressed"))).toBe(
    true,
  )
})

test("redirect load failure is disclosed instead of silently presenting an incomplete preview", () => {
  redirectsUnavailable = true
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))
  redirectsUnavailable = false

  expect(markup).toContain("Model Redirects are unavailable")
  expect(markup).toContain("cannot show which redirected requests may enter")
})

test("unsafe routing previews only the original starting model", () => {
  safety = {
    safe: false,
    loop: {
      kind: "fallback",
      models: ["gpt-6-luna", "gpt-5.5", "gpt-6-luna"],
      ruleIds: ["shared-1", "shared-2"],
    },
  }
  const markup: string = renderToStaticMarkup(createElement(FallbacksScreen))
  safety = { safe: true }

  expect(markup).toContain("1 possible attempt")
  expect(markup).toContain("Routing safety is paused by a loop")
  expect(markup).toContain("uses only its original starting model")
})
