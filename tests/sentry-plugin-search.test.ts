import * as Sentry from "@sentry/bun"
import { expect, test } from "bun:test"

import {
  applySentryRequestDiagnosticsToScope,
  createSentryInitOptions,
} from "../src/lib/sentry"

test("scrubs Codex plugin search queries within local Sentry context", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  const span = {
    description:
      "GET https://voice.openai.com/ps/plugins/search?q=private+search&pageToken=private-cursor&scope=USER",
    data: {
      "http.query": "?q=http-secret&pageToken=http-cursor&scope=USER",
      url: {
        query: "?q=semantic-secret&pageToken=semantic-cursor&scope=USER",
      },
    },
  }
  const unrelated = {
    description: "GET https://example.test/search?q=keep-me",
    data: { url: { query: "q=keep-me&pageToken=keep-me" } },
  }
  const request = {
    description: "GET /ps/plugins/search",
    query_string: {
      q: "object-secret",
      pageToken: "object-cursor",
      scope: "USER",
    },
    query: [
      ["q", "tuple-secret"],
      ["pageToken", "tuple-cursor"],
      ["scope", "USER"],
    ],
  }
  const payload = { request, span, unrelated }
  const beforeSend = options.beforeSend as
    | ((value: typeof payload) => typeof payload | null)
    | undefined

  expect(beforeSend?.(payload)).toBe(payload)
  expect(span.description).toBe(
    "GET https://voice.openai.com/ps/plugins/search?q=[REDACTED]&pageToken=[REDACTED]&scope=USER",
  )
  expect(span.data.url.query).toBe(
    "?q=[REDACTED]&pageToken=[REDACTED]&scope=USER",
  )
  expect(span.data["http.query"]).toBe(
    "?q=[REDACTED]&pageToken=[REDACTED]&scope=USER",
  )
  expect(request.query_string).toEqual({
    q: "[REDACTED]",
    pageToken: "[REDACTED]",
    scope: "USER",
  })
  expect(request.query).toEqual([
    ["q", "[REDACTED]"],
    ["pageToken", "[REDACTED]"],
    ["scope", "USER"],
  ])
  expect(unrelated.description).toBe(
    "GET https://example.test/search?q=keep-me",
  )
  expect(unrelated.data.url.query).toBe("q=keep-me&pageToken=keep-me")
})

test("sanitizes Codex plugin search diagnostics stored on a Sentry scope", () => {
  const scope = new Sentry.Scope()
  const path =
    "/ps/plugins/search?q=private+search&pageToken=private-cursor&scope=USER"

  scope.setSDKProcessingMetadata({
    normalizedRequest: {
      query_string: "?q=scope-secret&pageToken=scope-cursor",
    },
  })
  applySentryRequestDiagnosticsToScope(scope, {
    method: "GET",
    path,
    url: `https://voice.openai.com${path}`,
  })

  const scopeData = scope.getScopeData()
  expect(scopeData.transactionName).toBe("GET /ps/plugins/search")
  expect(scopeData.sdkProcessingMetadata.normalizedRequest).toMatchObject({
    method: "GET",
    url: "https://voice.openai.com/ps/plugins/search?q=[REDACTED]&pageToken=[REDACTED]&scope=USER",
  })
  expect(
    scopeData.sdkProcessingMetadata.normalizedRequest?.query_string,
  ).toBeUndefined()
})

test("scrubs category page cursors from actual Sentry query fields", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  const event = {
    transaction: "GET /ps/plugin-categories/developer-tools/plugins",
    request: {
      query_string: "?scope=GLOBAL&pageToken=private-cursor",
      url: "https://voice.openai.com/ps/plugin-categories/developer-tools/plugins?scope=GLOBAL&pageToken=private-cursor",
    },
    contexts: {
      trace: {
        data: {
          "http.query": "?scope=GLOBAL&pageToken=private-http-cursor",
          "url.query": "?scope=GLOBAL&pageToken=private-url-cursor",
        },
      },
    },
  }
  const beforeSendTransaction = options.beforeSendTransaction as
    | ((value: typeof event) => typeof event | null)
    | undefined

  expect(beforeSendTransaction?.(event)).toBe(event)
  const serialized = JSON.stringify(event)
  expect(serialized).not.toContain("private-cursor")
  expect(serialized).not.toContain("private-http-cursor")
  expect(serialized).not.toContain("private-url-cursor")
  expect(serialized).toContain("scope=GLOBAL")
})

test("fails closed instead of mutating a frozen query tuple", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  const frozenTuple = Object.freeze(["q", "private-query"])
  const event = {
    description: "GET /ps/plugins/search",
    query: [frozenTuple],
  }
  const beforeSend = options.beforeSend as
    | ((value: typeof event) => typeof event | null)
    | undefined

  expect(beforeSend?.(event)).toBeNull()
})

test("replaces structured sensitive query values without traversing them", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  const event = {
    description: "GET /ps/plugins/search",
    query: [
      ["q", { secret: "tuple-secret" }],
      ["scope", { safe: "visible" }],
    ],
    query_string: {
      pageToken: ["object-secret"],
      q: { secret: "object-secret" },
      scope: { safe: "visible" },
    },
  }
  const beforeSend = options.beforeSend as
    | ((value: typeof event) => typeof event | null)
    | undefined

  expect(beforeSend?.(event)).toBe(event)
  const serialized = JSON.stringify(event)
  expect(serialized).not.toContain("tuple-secret")
  expect(serialized).not.toContain("object-secret")
  expect(event.query[0]?.[1]).toBe("[REDACTED]")
  expect(event.query_string.q as unknown).toBe("[REDACTED]")
  expect(event.query_string.pageToken as unknown).toBe("[REDACTED]")
  expect(serialized).toContain("visible")
})

test("fails closed on an enumerable sensitive query accessor", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  const queryString: Record<string, unknown> = {}
  Object.defineProperty(queryString, "q", {
    enumerable: true,
    get: () => "accessor-secret",
  })
  const event = {
    description: "GET /ps/plugins/search",
    query_string: queryString,
  }
  const beforeSend = options.beforeSend as
    | ((value: typeof event) => typeof event | null)
    | undefined

  expect(beforeSend?.(event)).toBeNull()
})
