import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

import type {
  PageLink,
  WebDocument,
  WebFetchInput,
  WebFetchSuccess,
} from "./types"

interface InertElement {
  textContent: string | null
  innerHTML: string
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  remove(): void
}
interface InertDocument {
  body: InertElement
  querySelector(selector: string): InertElement | null
  querySelectorAll(selector: string): Iterable<InertElement>
}

function httpLink(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base)
    return (
        ["http:", "https:"].includes(url.protocol)
          && !url.username
          && !url.password
      ) ?
        url.href
      : undefined
  } catch {
    return undefined
  }
}

// eslint-disable-next-line complexity -- Normalize links and remove executable HTML in one inert document.
export function extractPageContent(
  rawBody: string,
  url: string,
): {
  text: string
  title: string
  links: Array<PageLink>
  warnings: Array<string>
} {
  const links: Array<PageLink> = []
  try {
    const source =
      /<html[\s>]/i.test(rawBody) ? rawBody : (
        `<html><body>${rawBody}</body></html>`
      )
    // linkedom's Window return type depends on browser globals; only this inert
    // DOM surface is used on the Bun server, with no scripts or resource loads.
    const { document } = parseHTML(source) as unknown as {
      document: InertDocument
    }
    const title =
      document.querySelector("title")?.textContent?.trim()
      || document.querySelector("h1")?.textContent?.trim()
      || url
    for (const node of document.querySelectorAll(
      "script,style,template,noscript",
    ))
      node.remove()
    for (const anchor of document.querySelectorAll("a[href]")) {
      const target = httpLink(anchor.getAttribute("href") ?? "", url)
      if (target) {
        anchor.setAttribute("href", target)
        if (links.length < 2_000)
          links.push({
            id: links.length + 1,
            url: target,
            text: (anchor.textContent ?? "").trim().slice(0, 500),
          })
      } else {
        anchor.removeAttribute("href")
      }
    }
    for (const image of document.querySelectorAll("img[src]")) {
      const target = httpLink(image.getAttribute("src") ?? "", url)
      if (target) image.setAttribute("src", target)
      else image.remove()
    }
    const converter = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    })
    converter.use(gfm)
    return {
      title,
      text: converter.turndown(document.body.innerHTML).trim(),
      links,
      warnings: [],
    }
  } catch {
    return {
      title: url,
      text: rawBody,
      links,
      warnings: ["HTML extraction failed; raw HTML returned."],
    }
  }
}

function splitsScalar(text: string, offset: number): boolean {
  return (
    offset > 0
    && offset < text.length
    && /[\uD800-\uDBFF]/u.test(text[offset - 1])
    && /[\uDC00-\uDFFF]/u.test(text[offset])
  )
}

export function sliceWebDocument(
  document: WebDocument,
  input: Pick<WebFetchInput, "raw" | "start_index" | "max_length">,
  warnings: ReadonlyArray<string> = [],
): WebFetchSuccess {
  const text = input.raw ? document.rawBody : document.text
  let start = Math.min(input.start_index ?? 0, text.length)
  if (splitsScalar(text, start)) start--
  let end = Math.min(
    start + Math.min(input.max_length ?? 5_000, 20_000),
    text.length,
  )
  if (splitsScalar(text, end)) end--
  if (end <= start && start < text.length)
    end = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1)
  return {
    ok: true,
    document,
    content: text.slice(start, end),
    full_length: text.length,
    next_start_index: end < text.length ? end : null,
    warnings,
  }
}
