// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { expect, test } from "bun:test"

import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"
import {
  LlmFallbackBadge,
  LlmFallbackBanner,
} from "../ui/src/components/LlmFallbackIndicator"
import { fallbackSearchText } from "../ui/src/lib/llm-fallback"

const configured = {
  reason: "http_422",
  sourceModel: "source-model",
  fromModel: "source-model",
  configuredTargetModel: "target-model",
  targetModel: "target-model",
  cached: false,
  hop: 1,
}

test("configured fallback badges name their source and expose keyboard focus", () => {
  const markup: string = renderToStaticMarkup(
    createElement(LlmFallbackBadge, { fallback: configured }),
  )
  expect(markup).toContain("Configured fallback")
  expect(markup).toContain('tabindex="0"')
  expect(markup).toContain('aria-hidden="true"')
})

test("remembered configured fallback stays explicit in the badge and detail", () => {
  const fallback = { ...configured, cached: true }
  const badge: string = renderToStaticMarkup(
    createElement(LlmFallbackBadge, { fallback }),
  )
  const banner: string = renderToStaticMarkup(
    createElement(LlmFallbackBanner, { fallback }),
  )
  expect(badge).toContain("Configured fallback · cached")
  expect(banner).toContain("Configured fallback · cached")
  expect(banner).toContain("No new HTTP 422 was required")
})

test("a requested fallback policy does not imply a model switch", () => {
  const markup: string = renderToStaticMarkup(
    createElement(LlmFallbackBanner, {
      fallbackObservations: [
        {
          kind: "requested",
          sourceModel: "source-model",
          targetModels: ["requested-model", "backup-model"],
        },
      ],
    }),
  )
  expect(markup).toContain("Fallback requested")
  expect(markup).toContain("requested-model → backup-model")
  expect(markup).toContain("does not confirm that a model switch occurred")
  expect(markup).not.toContain("Configured fallback")
})

test("upstream fallback is labeled from explicit response evidence", () => {
  const markup: string = renderToStaticMarkup(
    createElement(LlmFallbackBanner, {
      fallbackObservations: [
        {
          kind: "upstream",
          fromModel: "source-model",
          targetModel: "upstream-model",
        },
      ],
    }),
  )
  expect(markup).toContain("Upstream fallback")
  expect(markup).toContain("response contains a fallback block")
  expect(markup).toContain("source-model → upstream-model")
  expect(markup).not.toContain("Configured fallback")
})

test("an inferred client retry explains the uncertainty and links to the refusal", () => {
  const markup: string = renderToStaticMarkup(
    createElement(LlmFallbackBanner, {
      fallbackObservations: [
        {
          kind: "client",
          fromModel: "source-model",
          targetModel: "retry-model",
          previousLogId: "refused-capture",
          reason: "refusal",
          evidence: "inferred",
        },
      ],
    }),
  )
  expect(markup).toContain("Client retry (inferred)")
  expect(markup).toContain("same session")
  expect(markup).toContain("same content")
  expect(markup).toContain("after a refusal")
  expect(markup).toContain("automatic or manual")
  expect(markup).toContain('href="#llm-debug:refused-capture"')
  expect(markup).toContain("Open previous capture")
})

test("configured routing and every observed source coexist in one row", () => {
  const fallbackObservations = [
    { kind: "requested", sourceModel: "source-model", targetModels: "default" },
    {
      kind: "upstream",
      fromModel: "target-model",
      targetModel: "upstream-model",
    },
    {
      kind: "client",
      fromModel: "prior-model",
      targetModel: "source-model",
      previousLogId: "prior-capture",
      reason: "refusal",
      evidence: "inferred",
    },
  ]
  const markup: string = renderToStaticMarkup(
    createElement(LlmFallbackBadge, {
      fallback: configured,
      fallbackObservations,
    }),
  )
  expect(markup).toContain("Configured fallback")
  expect(markup).toContain("Fallback requested")
  expect(markup).toContain("server-defined default")
  expect(markup).toContain("Upstream fallback")
  expect(markup).toContain("Client retry (inferred)")
  expect([...markup.matchAll(/tabindex="0"/g)]).toHaveLength(4)
  expect([...markup.matchAll(/llm-fallback-tooltip/g)]).toHaveLength(4)
  expect([
    ...markup.matchAll(/data-variant="(warning|neutral|success|info)"/g),
  ]).toHaveLength(4)
})

test("fallback search finds inferred client retries by origin and both models", () => {
  const searchable = fallbackSearchText({
    fallbackObservations: [
      {
        kind: "client",
        fromModel: "Refusing-Model",
        targetModel: "Retry-Model",
        previousLogId: "prior-capture",
        reason: "refusal",
        evidence: "inferred",
      },
    ],
  })
  for (const term of [
    "fallback",
    "client",
    "inferred",
    "refusing-model",
    "retry-model",
  ]) {
    expect(searchable).toContain(term)
  }
})

test("search includes requested, upstream, and configured targets independently", () => {
  const searchable = fallbackSearchText({
    fallback: { ...configured, configuredTargetModel: "configured-alias" },
    fallbackObservations: [
      {
        kind: "requested",
        sourceModel: "source-model",
        targetModels: ["requested-model"],
      },
      {
        kind: "upstream",
        fromModel: "source-model",
        targetModel: "upstream-model",
      },
    ],
  })
  for (const term of [
    "configured",
    "configured-alias",
    "target-model",
    "requested",
    "requested-model",
    "upstream",
    "upstream-model",
  ]) {
    expect(searchable).toContain(term)
  }
  expect(fallbackSearchText({})).toBe("")
})
