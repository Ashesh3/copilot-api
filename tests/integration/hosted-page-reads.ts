import { expect } from "bun:test"

import { pageUrl } from "~/services/copilot/hosted-web-search"

/**
 * GitHub's hosted reader is sometimes unable to open any page and answers
 * "Cache miss" for every URL, whatever the gateway sends. The gateway then
 * reports the failure. Live tests waive their page-content check only when
 * every hosted read in the test was a verified cache miss and the client
 * still received an answer; every other outcome keeps the check.
 */

/** How GitHub's hosted reader answered one page read. */
export type HostedPageRead = "ok" | "cache_miss" | "error"

export interface HostedPageReadRecord {
  urls: Array<string>
  result: HostedPageRead
}

/** Text in the gateway's hosted-reader instructions. */
export const HOSTED_READER_MARKER = "GitHub-hosted webpage reader"
export const PAGE_TEXT = "Example Domain"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item: unknown) => isRecord(item)) : []

/** The URLs a hosted-reader request asks to open, from its input text. */
function requestedUrls(body: string): Array<string> {
  try {
    const { input } = JSON.parse(body) as { input?: unknown }
    if (typeof input !== "string") return []
    const match = /^Requested exact URLs:\n([\s\S]*?)\n\n/u.exec(input)
    return match ? match[1].split("\n").filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Record a hosted-reader request as an error until a successful JSON response
 * classifies it, so HTTP, non-JSON, and transport failures stay errors.
 */
export function startHostedPageRead(
  reads: Array<HostedPageReadRecord>,
  url: URL,
  init: RequestInit | undefined,
): HostedPageReadRecord | undefined {
  if (
    url.pathname !== "/responses"
    || typeof init?.body !== "string"
    || !init.body.includes(HOSTED_READER_MARKER)
  )
    return undefined
  const read: HostedPageReadRecord = {
    urls: requestedUrls(init.body),
    result: "error",
  }
  reads.push(read)
  return read
}

/** Assistant `output_text`, extracted and joined as the gateway parses it. */
function readerAnswerText(output: Array<Record<string, unknown>>): string {
  return output
    .filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => records(item.content))
    .filter(
      (part) => part.type === "output_text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n")
}

/**
 * A cache miss needs a completed response, a completed `open_page` for every
 * requested URL (as the gateway requires), and a structured reader answer
 * whose error mentions "Cache miss". Anything else is an error.
 */
export function classifyHostedPageRead(
  value: unknown,
  urls: ReadonlyArray<string>,
): HostedPageRead {
  if (!isRecord(value) || value.status !== "completed" || value.error)
    return "error"
  const output = records(value.output)
  const opened = new Set(
    output.flatMap((item) => {
      const action = item.action
      if (
        item.type !== "web_search_call"
        || item.status !== "completed"
        || !isRecord(action)
        || action.type !== "open_page"
        || typeof action.url !== "string"
      )
        return []
      const url = pageUrl(action.url)
      return url ? [url] : []
    }),
  )
  let answer: unknown
  try {
    answer = JSON.parse(
      readerAnswerText(output)
        .replace(/^```(?:json)?\s*/u, "")
        .replace(/\s*```$/u, ""),
    ) as unknown
  } catch {
    return "error"
  }
  if (!isRecord(answer) || typeof answer.content !== "string") return "error"
  if (answer.status === "ok") return "ok"
  const allOpened = urls.length > 0 && urls.every((url) => opened.has(url))
  return (
      allOpened
        && answer.status === "error"
        && /cache miss/iu.test(answer.content)
    ) ?
      "cache_miss"
    : "error"
}

/** Classify a recorded read from its successful JSON response. */
export function finishHostedPageRead(
  read: HostedPageReadRecord | undefined,
  value: unknown,
): void {
  if (read) read.result = classifyHostedPageRead(value, read.urls)
}

/** Assistant text of a buffered Messages or Responses client response. */
export function bufferedAnswer(body: string): string {
  let value: unknown
  try {
    value = JSON.parse(body) as unknown
  } catch {
    return ""
  }
  if (!isRecord(value)) return ""
  const messages =
    Array.isArray(value.output) ?
      records(value.output).filter(
        (item) => item.type === "message" && item.role === "assistant",
      )
    : [value]
  return messages
    .flatMap((message) => records(message.content))
    .filter(
      (part) =>
        (part.type === "text" || part.type === "output_text")
        && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("")
}

/** Whether a live test may skip its page-content check during an outage. */
export function waivesPageContent(options: {
  reads: ReadonlyArray<HostedPageReadRecord>
  text: string
  answer: string
}): boolean {
  const { reads, text, answer } = options
  return (
    reads.length > 0
    && reads.every((read) => read.result === "cache_miss")
    && !text.includes(PAGE_TEXT)
    && answer.trim() !== ""
  )
}

/** Require the page text, or warn when an outage waives the check. */
export function expectPageContent(options: {
  label: string
  reads: ReadonlyArray<HostedPageReadRecord>
  text: string
  answer: string
}): void {
  if (waivesPageContent(options)) {
    const message = `Skipped the page-content check in live test "${options.label}": GitHub-hosted page reading answered "Cache miss" for every page it opened.`
    console.warn(message)
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(
        `::warning file=tests/integration/default-web-tools.test.ts,title=GitHub-hosted page reading unavailable::${message}\n`,
      )
    }
    return
  }
  expect(options.text).toContain(PAGE_TEXT)
}
