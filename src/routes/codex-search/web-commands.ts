import type { WebDocument, WebFetchOptions } from "~/services/web/types"

import { webDocuments } from "~/services/web/document-store"
import { executeWebFetch, parseWebUrl } from "~/services/web/fetch-page"
import { isRecord } from "~/services/web/tool-context"

interface WebCommandOptions {
  fetch?: WebFetchOptions["request"]
  search: (commands: Record<string, unknown>) => Promise<string>
  signal?: AbortSignal
}
function displayLines(text: string): Array<string> {
  return text.split("\n").flatMap((line) => {
    // Stable wrapping makes even minified one-line pages addressable by lineno.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- Stable display lines preserve every Unicode scalar for subsequent reads.
    const characters = [...line]
    const lines: Array<string> = []
    for (let start = 0; start < characters.length; start += 400)
      lines.push(characters.slice(start, start + 400).join(""))
    return lines.length > 0 ? lines : [""]
  })
}
function pageOutput(
  document: WebDocument,
  reference: string | null,
  options: { line?: number; limit: number },
): string {
  const { line = 0, limit } = options
  const lines = displayLines(document.text)
  const start = Math.max(0, Math.min(Math.floor(line), lines.length))
  const header = `${document.title.slice(0, 200)}\n${document.url.slice(0, 1000)}\nReference: ${reference ?? "unavailable"}\nTotal lines: ${lines.length}\n`
  const continuation = (end: number) =>
    `\nMore content: open ${reference ?? document.url} at lineno ${end}.\n`
  const text: Array<string> = []
  let size = header.length
  let end = start
  const bodyLimit = limit - continuation(lines.length).length
  while (end < lines.length) {
    const chunk = `L${end}: ${lines[end]}\n`
    if (size + chunk.length > bodyLimit) break
    text.push(chunk)
    size += chunk.length
    end++
  }
  const links = document.links
    .slice(0, 30)
    .map((link) => `[${link.id}] ${link.text}: ${link.url}`)
    .join("\n")
  const body =
    header + text.join("") + (end < lines.length ? continuation(end) : "")
  return (
    body + (links ? ("\nLinks:\n" + links).slice(0, limit - body.length) : "")
  )
}
function commandList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ?
      value.filter((item: unknown) => isRecord(item))
    : []
}
async function openPage(
  command: Record<string, unknown>,
  scope: string,
  options: WebCommandOptions & { limit: number },
): Promise<string> {
  const { limit } = options
  const ref = command.ref_id
  if (typeof ref !== "string") return '{"error":"invalid_tool_input"}'
  const line = command.lineno ?? 0
  if (!Number.isSafeInteger(line) || Number(line) < 0)
    return '{"error":"invalid_tool_input"}'
  if (!parseWebUrl(ref)) {
    const cached = webDocuments.get(scope, ref)
    return cached ?
        pageOutput(cached, ref, { line: Number(line), limit })
      : '{"error":"reference_not_found"}'
  }
  const fetched = await executeWebFetch(
    { url: ref, max_length: limit },
    { request: options.fetch, signal: options.signal },
  )
  if (!fetched.ok) return JSON.stringify(fetched)
  const reference = webDocuments.put(scope, fetched.document)
  return pageOutput(fetched.document, reference, { line: Number(line), limit })
}
export async function dispatchWebCommands(
  commands: Record<string, unknown>,
  scope: string,
  options: WebCommandOptions,
): Promise<string> {
  const outputs: Array<string> = []
  let limit = 10000
  if (commands.response_length === "short") limit = 5000
  if (commands.response_length === "long") limit = 20000
  const hasBrowsing = ["open", "find", "click"].some(
    (key) => commandList(commands[key]).length > 0,
  )
  if (!hasBrowsing) return await options.search(commands)
  if (commandList(commands.search_query).length > 0) {
    const search = { ...commands }
    delete search.open
    delete search.find
    delete search.click
    outputs.push(await options.search(search))
  }
  for (const command of commandList(commands.open))
    outputs.push(await openPage(command, scope, { ...options, limit }))
  for (const command of commandList(commands.find)) {
    const document =
      typeof command.ref_id === "string" ?
        webDocuments.get(scope, command.ref_id)
      : undefined
    if (!document) {
      outputs.push('{"error":"reference_not_found"}')
      continue
    }
    if (typeof command.pattern !== "string" || !command.pattern) {
      outputs.push('{"error":"invalid_tool_input"}')
      continue
    }
    const pattern = command.pattern.toLowerCase()
    const lines = displayLines(document.text)
    const found = lines
      .flatMap((line, index) =>
        line.toLowerCase().includes(pattern) ? [`L${index}: ${line}`] : [],
      )
      .slice(0, 20)
      .join("\n")
    outputs.push((found || "No matching text in fetched page.").slice(0, limit))
  }
  for (const command of commandList(commands.click)) {
    const document =
      typeof command.ref_id === "string" ?
        webDocuments.get(scope, command.ref_id)
      : undefined
    const link = document?.links.find((link) => link.id === command.id)
    outputs.push(
      link ?
        await openPage({ ref_id: link.url }, scope, { ...options, limit })
      : '{"error":"reference_not_found"}',
    )
  }
  return outputs.join("\n\n")
}
