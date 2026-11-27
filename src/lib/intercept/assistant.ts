import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import type {
  AssistantDiffOp,
  AssistantSuggestion,
  CanonicalItem,
  CanonicalView,
  InterceptAssistantConfig,
  InterceptPendingItem,
} from "./types"

import {
  applyCanonicalDiffOps,
  parseCanonicalView,
  serializeCanonicalItemsToBody,
} from "./canonical"

const interceptBypassStorage = new AsyncLocalStorage<boolean>()

export function isInterceptBypassed(): boolean {
  return interceptBypassStorage.getStore() === true
}

export function runBypassingIntercept<T>(work: () => T): T {
  return interceptBypassStorage.run(true, work)
}

const MAX_ITEM_CHARS = 8000
const MAX_CONTEXT_ITEMS = 40

function truncateForContext(text: string, limit = MAX_ITEM_CHARS): string {
  if (text.length <= limit) return text
  const omitted = text.length - limit
  return `${text.slice(0, limit)}\n...[truncated ${omitted} chars]`
}

function formatCanonicalItemsForAssistant(
  items: ReadonlyArray<CanonicalItem>,
): string {
  const sliced =
    items.length > MAX_CONTEXT_ITEMS ?
      items.slice(items.length - MAX_CONTEXT_ITEMS)
    : items
  const lines: Array<string> = []
  if (items.length > MAX_CONTEXT_ITEMS) {
    lines.push(
      `(${items.length - MAX_CONTEXT_ITEMS} earlier items omitted for brevity)`,
    )
  }
  for (const item of sliced) {
    const meta: Array<string> = [`id=${item.id}`, `kind=${item.kind}`]
    if (item.toolName) meta.push(`tool=${item.toolName}`)
    if (item.toolCallId) meta.push(`call_id=${item.toolCallId}`)
    lines.push(
      `### [${meta.join(" | ")}]`,
      truncateForContext(item.content),
      "",
    )
  }
  return lines.join("\n").trim()
}

export function buildAssistantPrompt(options: {
  item: InterceptPendingItem
  instruction: string
}): { system: string; user: string } {
  const { item, instruction } = options
  const system = [
    "You are an AI Traffic Interception Assistant inside an HTTP/LLM proxy.",
    "You receive a structured, noise-free representation of an intercepted LLM request or response, along with the user's scenario instructions.",
    "Your job is to return ONLY a JSON object describing minimal diff operations to modify the intercepted payload so it matches the user's scenario.",
    "NEVER return raw HTTP payloads or prose outside the JSON object.",
    "Output JSON schema:",
    "{",
    '  "summary": "Brief 1-sentence summary of what you changed and why",',
    '  "operations": [',
    '    { "op": "replace", "id": "<existing item id>", "content": "<new text>", "toolName": "<optional>", "toolArguments": "<optional JSON string>", "reason": "<short reason>" },',
    '    { "op": "delete", "id": "<existing item id>", "reason": "<short reason>" },',
    '    { "op": "insert_after", "afterId": "<existing item id or null for start>", "kind": "system|developer|user|assistant|tool_call|tool_result|thinking", "content": "<text>", "toolName": "<optional>", "toolCallId": "<optional>", "toolArguments": "<optional JSON string>", "reason": "<short reason>" }',
    "  ]",
    "}",
    "Rules:",
    "- Reference ONLY exact item IDs from the TARGET section.",
    "- If no change is needed, return an empty operations array.",
    "- For tool_call items, toolArguments MUST be a valid JSON string.",
    "- Keep edits surgical and faithful to the user's scenario instruction.",
  ].join("\n")

  const userParts: Array<string> = [
    `# Intercepted Phase: ${item.phase.toUpperCase()}`,
    `Protocol: ${item.canonical.protocol}`,
    `Path: ${item.method} ${item.path}`,
    `Model: ${item.model ?? "unknown"}`,
    item.sessionId ? `Session: ${item.sessionId}` : "",
    "",
    "# User Scenario Instruction",
    instruction.trim(),
    "",
  ]

  if (item.phase === "response" && item.requestContext) {
    userParts.push(
      "# Triggering Request Context (read-only background, do NOT target these IDs)",
      formatCanonicalItemsForAssistant(item.requestContext.canonical.items),
      "",
    )
  }

  userParts.push(
    `# TARGET ${item.phase.toUpperCase()} ITEMS (editable — reference these IDs in operations)`,
    formatCanonicalItemsForAssistant(item.canonical.items),
  )

  return {
    system,
    user: userParts.join("\n"),
  }
}

export function resolveAssistantInstruction(
  config: InterceptAssistantConfig,
  phase: "request" | "response",
): string {
  if (config.instructionMode === "separate") {
    return (
      phase === "request" ?
        config.requestInstruction
      : config.responseInstruction).trim()
  }
  return config.sharedInstruction.trim()
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  let candidate = trimmed
  const fenceStart = trimmed.indexOf("```")
  if (fenceStart !== -1) {
    const firstNewline = trimmed.indexOf("\n", fenceStart)
    const fenceEnd = trimmed.indexOf("```", fenceStart + 3)
    if (firstNewline !== -1 && fenceEnd > firstNewline) {
      candidate = trimmed.slice(firstNewline + 1, fenceEnd).trim()
    }
  }
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  const slice =
    start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate
  const parsed: unknown = JSON.parse(slice)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Assistant response was not a JSON object")
  }
  return parsed as Record<string, unknown>
}

const VALID_KINDS = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "thinking",
])

// eslint-disable-next-line complexity
export function parseAssistantDiffResponse(raw: string): {
  summary: string
  operations: Array<AssistantDiffOp>
} {
  const parsed = extractJsonObject(raw)
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim() ?
      parsed.summary.trim()
    : "Suggested payload modification"

  const rawOps = Array.isArray(parsed.operations) ? parsed.operations : []
  const operations: Array<AssistantDiffOp> = []

  for (const entry of rawOps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const op = rec.op
    const reason = typeof rec.reason === "string" ? rec.reason : undefined

    if (op === "replace" && typeof rec.id === "string") {
      operations.push({
        op: "replace",
        id: rec.id,
        ...(typeof rec.content === "string" ? { content: rec.content } : {}),
        ...(typeof rec.toolName === "string" ? { toolName: rec.toolName } : {}),
        ...(typeof rec.toolArguments === "string" ?
          { toolArguments: rec.toolArguments }
        : {}),
        ...(reason ? { reason } : {}),
      })
    } else if (op === "delete" && typeof rec.id === "string") {
      operations.push({
        op: "delete",
        id: rec.id,
        ...(reason ? { reason } : {}),
      })
    } else if (
      op === "insert_after"
      && (typeof rec.afterId === "string" || rec.afterId === null)
      && typeof rec.kind === "string"
      && VALID_KINDS.has(rec.kind)
    ) {
      operations.push({
        op: "insert_after",
        afterId: rec.afterId,
        kind: rec.kind as Exclude<CanonicalItem["kind"], "other">,
        content: typeof rec.content === "string" ? rec.content : "",
        ...(typeof rec.toolName === "string" ? { toolName: rec.toolName } : {}),
        ...(typeof rec.toolCallId === "string" ?
          { toolCallId: rec.toolCallId }
        : {}),
        ...(typeof rec.toolArguments === "string" ?
          { toolArguments: rec.toolArguments }
        : {}),
        ...(reason ? { reason } : {}),
      })
    }
  }

  return { summary, operations }
}

async function invokeAssistantModel(options: {
  model: string
  system: string
  user: string
}): Promise<string> {
  const { model, system, user } = options
  const payload = {
    model,
    stream: false as const,
    temperature: 0.2,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  }

  return await runBypassingIntercept(async () => {
    const customRef = resolveCustomProviderModel({ model, kind: "chat" })
    if (customRef) {
      const result = await createCustomProviderChatCompletions(customRef, {
        ...payload,
        model: customRef.upstreamModel,
      })
      if (Symbol.asyncIterator in result) {
        throw new Error("Assistant model unexpectedly returned a stream")
      }
      const content = result.choices[0]?.message.content
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Assistant model returned empty content")
      }
      return content
    }

    const result = await createChatCompletions(payload)
    if (Symbol.asyncIterator in result) {
      throw new Error("Assistant model unexpectedly returned a stream")
    }
    const content = result.choices[0]?.message.content
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Assistant model returned empty content")
    }
    return content
  })
}

export async function runInterceptAssistant(options: {
  item: InterceptPendingItem
  config: InterceptAssistantConfig
  instructionOverride?: string
  modelOverride?: string
}): Promise<AssistantSuggestion> {
  const startedAt = Date.now()
  const model = (options.modelOverride ?? options.config.model).trim()
  if (!model) {
    throw new Error(
      "No assistant model selected in Intercept Assistant settings",
    )
  }
  const instruction =
    options.instructionOverride?.trim()
    || resolveAssistantInstruction(options.config, options.item.phase)
  if (!instruction) {
    throw new Error(
      `No assistant instruction configured for ${options.item.phase} interception`,
    )
  }

  const prompt = buildAssistantPrompt({ item: options.item, instruction })
  const rawResponse = await invokeAssistantModel({
    model,
    system: prompt.system,
    user: prompt.user,
  })
  const { summary, operations } = parseAssistantDiffResponse(rawResponse)

  let previewBody: string | null = null
  let previewCanonical: CanonicalView | null = null
  if (operations.length > 0 && options.item.canonical.editable) {
    const nextItems = applyCanonicalDiffOps(
      options.item.canonical.items,
      operations,
    )
    previewBody = serializeCanonicalItemsToBody({
      originalBody: options.item.currentBody,
      canonical: options.item.canonical,
      items: nextItems,
      contentType: options.item.responseContentType,
    })
    previewCanonical = parseCanonicalView({
      path: options.item.path,
      phase: options.item.phase,
      body: previewBody,
      contentType: options.item.responseContentType,
    })
  }

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    model,
    summary,
    operations,
    previewBody,
    previewCanonical,
    durationMs: Date.now() - startedAt,
  }
}
