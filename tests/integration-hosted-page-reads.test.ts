import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import {
  bufferedAnswer,
  classifyHostedPageRead,
  expectPageContent,
  finishHostedPageRead,
  HOSTED_READER_MARKER,
  type HostedPageReadRecord,
  startHostedPageRead,
  waivesPageContent,
} from "./integration/hosted-page-reads"

const URL_TO_OPEN = "https://example.com/"
const CACHE_MISS = JSON.stringify({
  status: "error",
  content: `Failed to fetch ${URL_TO_OPEN}: Cache miss`,
  sources: [URL_TO_OPEN],
})

function readerResponse(
  options: {
    status?: string
    error?: unknown
    openStatus?: string
    openedUrl?: string
    parts?: Array<{ type: string; text: string }>
  } = {},
): Record<string, unknown> {
  return {
    status: options.status ?? "completed",
    error: options.error ?? null,
    output: [
      {
        type: "web_search_call",
        status: options.openStatus ?? "completed",
        action: { type: "open_page", url: options.openedUrl ?? URL_TO_OPEN },
      },
      {
        type: "message",
        role: "assistant",
        content: options.parts ?? [{ type: "output_text", text: CACHE_MISS }],
      },
    ],
  }
}

function readerRequest(): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify({
      instructions: `You are a ${HOSTED_READER_MARKER}.`,
      input: `Requested exact URLs:\n${URL_TO_OPEN}\n\nUser's web request:\nOpen it.`,
    }),
  }
}

test("a completed open with a structured cache-miss answer is a cache miss", () => {
  expect(classifyHostedPageRead(readerResponse(), [URL_TO_OPEN])).toBe(
    "cache_miss",
  )
  expect(
    classifyHostedPageRead(
      readerResponse({
        parts: [
          { type: "output_text", text: `\`\`\`json\n${CACHE_MISS}\n\`\`\`` },
        ],
      }),
      [URL_TO_OPEN],
    ),
  ).toBe("cache_miss")
})

test("a successful read is ok", () => {
  const ok = JSON.stringify({ status: "ok", content: "Example Domain" })
  expect(
    classifyHostedPageRead(
      readerResponse({ parts: [{ type: "output_text", text: ok }] }),
      [URL_TO_OPEN],
    ),
  ).toBe("ok")
})

test.each([
  ["an incomplete response", readerResponse({ status: "in_progress" })],
  ["an envelope error", readerResponse({ error: { message: "boom" } })],
  ["an open that did not complete", readerResponse({ openStatus: "failed" })],
  [
    "an open of a different URL",
    readerResponse({ openedUrl: "https://example.org/" }),
  ],
  [
    "a non-JSON answer",
    readerResponse({ parts: [{ type: "output_text", text: "Cache miss" }] }),
  ],
  [
    "an answer split so only direct concatenation forms JSON",
    readerResponse({
      parts: [
        { type: "output_text", text: CACHE_MISS.slice(0, 40) },
        { type: "output_text", text: CACHE_MISS.slice(40) },
      ],
    }),
  ],
  [
    "an answer in a block type the gateway ignores",
    readerResponse({ parts: [{ type: "text", text: CACHE_MISS }] }),
  ],
  [
    "another retrieval error",
    readerResponse({
      parts: [
        {
          type: "output_text",
          text: JSON.stringify({ status: "error", content: "HTTP 404" }),
        },
      ],
    }),
  ],
])("%s is an error", (_label, response) => {
  expect(classifyHostedPageRead(response, [URL_TO_OPEN])).toBe("error")
})

test("a read with no requested URLs is an error", () => {
  expect(classifyHostedPageRead(readerResponse(), [])).toBe("error")
})

test("reader requests start as errors until a JSON response classifies them", () => {
  const reads: Array<HostedPageReadRecord> = []
  const url = new URL("https://api.githubcopilot.com/responses")

  expect(
    startHostedPageRead(reads, url, { body: '{"input":"other"}' }),
  ).toBeUndefined()
  expect(
    startHostedPageRead(
      reads,
      new URL("https://api.githubcopilot.com/chat/completions"),
      readerRequest(),
    ),
  ).toBeUndefined()

  // A transport failure leaves the first read unclassified.
  startHostedPageRead(reads, url, readerRequest())
  const second = startHostedPageRead(reads, url, readerRequest())
  finishHostedPageRead(second, readerResponse())

  expect(reads).toEqual([
    { urls: [URL_TO_OPEN], result: "error" },
    { urls: [URL_TO_OPEN], result: "cache_miss" },
  ])
})

test.each([
  {
    when: "every read is a cache miss",
    results: ["cache_miss", "cache_miss"],
    answer: "Sorry.",
    waived: true,
  },
  {
    when: "a read failed another way",
    results: ["cache_miss", "error"],
    answer: "Sorry.",
    waived: false,
  },
  {
    when: "a read succeeded",
    results: ["cache_miss", "ok"],
    answer: "Sorry.",
    waived: false,
  },
  {
    when: "no hosted read happened",
    results: [],
    answer: "Sorry.",
    waived: false,
  },
  {
    when: "the client got an empty answer",
    results: ["cache_miss"],
    answer: "  ",
    waived: false,
  },
] as const)("waiver when $when", ({ results, answer, waived }) => {
  const reads = results.map((result) => ({ urls: [URL_TO_OPEN], result }))
  expect(waivesPageContent({ reads, text: answer, answer })).toBe(waived)
})

test("page text in the response never needs the waiver", () => {
  const reads: Array<HostedPageReadRecord> = [
    { urls: [URL_TO_OPEN], result: "cache_miss" },
  ]
  expect(
    waivesPageContent({ reads, text: "Example Domain", answer: "ok" }),
  ).toBe(false)
})

const originalGithubActions = process.env.GITHUB_ACTIONS
let warnings: Array<string> = []
let annotations: Array<string> = []

beforeEach(() => {
  process.env.GITHUB_ACTIONS = "true"
  warnings = []
  annotations = []
  spyOn(console, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })
  spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    annotations.push(String(chunk))
    return true
  })
})

afterEach(() => {
  mock.restore()
  process.env.GITHUB_ACTIONS = originalGithubActions
})

test("a waived page-content check warns on the console and in CI", () => {
  expectPageContent({
    label: "live streaming page reading",
    reads: [{ urls: [URL_TO_OPEN], result: "cache_miss" }],
    text: "I couldn't open the page.",
    answer: "I couldn't open the page.",
  })

  expect(warnings).toEqual([
    'Skipped the page-content check in live test "live streaming page reading": GitHub-hosted page reading answered "Cache miss" for every page it opened.',
  ])
  expect(annotations).toHaveLength(1)
  expect(annotations[0]).toStartWith(
    "::warning file=tests/integration/default-web-tools.test.ts,title=GitHub-hosted page reading unavailable::",
  )
})

test("an unwaived page-content check still requires the page text", () => {
  expect(() =>
    expectPageContent({
      label: "live default web search",
      reads: [{ urls: [URL_TO_OPEN], result: "error" }],
      text: "I couldn't open the page.",
      answer: "I couldn't open the page.",
    }),
  ).toThrow()
  expect(warnings).toEqual([])
})

test("buffered answers come from Messages and Responses assistant text", () => {
  expect(
    bufferedAnswer(
      JSON.stringify({ content: [{ type: "text", text: "Messages answer" }] }),
    ),
  ).toBe("Messages answer")
  expect(
    bufferedAnswer(
      JSON.stringify({
        output: [
          { type: "web_search_call", action: { type: "open_page" } },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Responses answer" }],
          },
        ],
      }),
    ),
  ).toBe("Responses answer")
  expect(bufferedAnswer("not json")).toBe("")
})
