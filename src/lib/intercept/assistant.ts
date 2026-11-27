import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import {
  createCustomProviderChatCompletions,
  type CustomProviderModelReference,
  getCustomProviderModels,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import { getModelEndpointSupport } from "~/lib/endpoint-routing"
import {
  applyModelFallbackToPayload,
  getModelFallbackEffort,
  runWithModelFallback,
} from "~/lib/model-fallback"
import { normalizeReasoningEffortForModel } from "~/lib/model-suffix"
import { runAsIndependentRequest } from "~/lib/request-scopes"
import { state } from "~/lib/state"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  createChatCompletions,
} from "~/services/copilot/create-chat-completions"

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

/** Operations that cannot be applied to the item they were written for. */
export class AssistantDiffError extends Error {}

// --- Destinations -----------------------------------------------------------

type AssistantDestination =
  | { kind: "copilot" }
  | { kind: "custom"; reference: CustomProviderModelReference }

/**
 * The Copilot-or-custom decision the Chat Completions route makes for the same
 * model ID. AI Assist sends Chat Completions only, so Copilot models must
 * support that endpoint.
 */
function resolveAssistantDestination(
  model: string,
): AssistantDestination | undefined {
  const copilotModels = state.models?.data ?? []
  const reference = resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds: new Set(copilotModels.map((entry) => entry.id)),
  })
  if (reference) return { kind: "custom", reference }
  const copilotModel = copilotModels.find((entry) => entry.id === model)
  return copilotModel && getModelEndpointSupport(copilotModel).chat ?
      { kind: "copilot" }
    : undefined
}

/** Model IDs AI Assist can call, each resolving as it will be sent. */
export function listAssistantModels(): Array<string> {
  const ids = new Set(state.models?.data.map((entry) => entry.id) ?? [])
  for (const listing of getCustomProviderModels()) {
    if (listing.kind === "chat") ids.add(listing.id)
  }
  return [...ids]
    .filter((id) => resolveAssistantDestination(id) !== undefined)
    .sort((a, b) => a.localeCompare(b))
}

// --- Prompt projection ------------------------------------------------------

// The assistant sees a structured projection, never the HTTP payload:
// read-only nodes (images, documents, signed or encrypted blocks) appear by
// label only, long text is cut, and older turns are dropped first.
const INSTRUCTION_CHAR_LIMIT = 16_000
const ITEM_CHAR_LIMIT = 8_000
const TARGET_CHAR_BUDGET = 120_000
const CONTEXT_CHAR_BUDGET = 40_000

interface ProjectedItem {
  item: CanonicalItem
  text: string
  truncated: boolean
}

/** Items shown in the target section; operations may address only these. */
export type AssistantTargets = ReadonlyMap<string, ProjectedItem>

function isInstruction(item: CanonicalItem): boolean {
  return item.kind === "system" || item.kind === "developer"
}

function projectItem(item: CanonicalItem): ProjectedItem {
  if (item.opaque) {
    return {
      item,
      text: `(${item.label}: content not shown)`,
      truncated: false,
    }
  }
  const text =
    item.kind === "tool_call" ?
      (item.toolArguments ?? item.content)
    : item.content
  const limit = isInstruction(item) ? INSTRUCTION_CHAR_LIMIT : ITEM_CHAR_LIMIT
  if (text.length <= limit) return { item, text, truncated: false }
  return {
    item,
    text: `${text.slice(0, limit)}\n[${text.length - limit} more characters not shown]`,
    truncated: true,
  }
}

interface ItemSelection {
  shown: Array<ProjectedItem>
  /** Instruction items left out because they do not fit the budget. */
  omittedInstructions: number
  /** The oldest non-instruction items, left out to fit the budget. */
  omittedOlder: number
}

/**
 * Instructions first, in order, while they fit; then the newest other items
 * that fit. Everything shown stays within `budget` and keeps its order.
 */
function selectItems(
  items: ReadonlyArray<CanonicalItem>,
  budget: number,
): ItemSelection {
  const projected = items.map((item) => projectItem(item))
  const keep = new Set<number>()
  let used = 0
  let instructionsFit = true
  for (const [index, entry] of projected.entries()) {
    if (!isInstruction(entry.item)) continue
    if (instructionsFit && used + entry.text.length <= budget) {
      keep.add(index)
      used += entry.text.length
    } else {
      instructionsFit = false
    }
  }
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    if (isInstruction(projected[index].item)) continue
    used += projected[index].text.length
    if (used > budget) break
    keep.add(index)
  }
  const shown = projected.filter((_, index) => keep.has(index))
  const omittedInstructions = projected.filter(
    (entry, index) => isInstruction(entry.item) && !keep.has(index),
  ).length
  return {
    shown,
    omittedInstructions,
    omittedOlder: projected.length - shown.length - omittedInstructions,
  }
}

function formatItems(selection: ItemSelection): string {
  const { shown, omittedInstructions, omittedOlder } = selection
  const lines: Array<string> = []
  if (omittedInstructions > 0) {
    lines.push(
      `(${omittedInstructions} system or developer items are not shown: they exceed the size limit.)`,
    )
  }
  if (omittedOlder > 0) {
    lines.push(`(${omittedOlder} older items are not shown.)`)
  }
  if (lines.length > 0) lines.push("")
  for (const { item, text, truncated } of shown) {
    const meta = [`id=${item.id}`, `kind=${item.kind}`]
    if (item.toolName) meta.push(`tool=${item.toolName}`)
    if (item.toolCallId) meta.push(`call_id=${item.toolCallId}`)
    if (item.opaque) meta.push("read-only")
    if (truncated) meta.push("truncated")
    lines.push(`### [${meta.join(" | ")}]`, text, "")
  }
  return lines.join("\n").trim() || "(no items)"
}

const SYSTEM_PROMPT = [
  "You edit intercepted LLM traffic inside an HTTP proxy so it fits the operator's scenario.",
  "You receive a structured view of one request or response: each item is a message, content part, tool call, tool result, or reasoning block with a stable id.",
  "Reply with exactly one JSON object and nothing else: no prose, no code fences.",
  "",
  "{",
  '  "summary": "One sentence: what you changed and why",',
  '  "operations": [',
  '    { "op": "replace", "id": "<target id>", "content": "<new text>", "toolName": "<tool_call only>", "toolArguments": "<tool_call only: JSON object as a string>", "reason": "<short reason>" },',
  '    { "op": "delete", "id": "<target id>", "reason": "<short reason>" },',
  '    { "op": "insert_after", "afterId": "<target id, or null for the very start>", "kind": "system|developer|user|assistant|tool_call|tool_result|thinking", "content": "<text>", "toolName": "<required for tool_call>", "toolCallId": "<required for tool_result: the call_id it answers>", "toolArguments": "<required for tool_call: JSON object as a string>", "reason": "<short reason>" }',
  "  ]",
  "}",
  "",
  "Rules:",
  "- Address only ids listed under TARGET ITEMS. Items under REQUEST CONTEXT are background and cannot be edited.",
  "- Each id may appear in at most one replace or delete. Never insert after an item you delete.",
  "- Items marked read-only can be kept or deleted, never replaced.",
  "- Items marked truncated show only their beginning: never replace their content or toolArguments; delete them or insert new items instead.",
  "- A replace sets the item's whole content; write the complete new text.",
  "- For tool_call items put the arguments in toolArguments as a JSON object string.",
  "- Make the smallest change that satisfies the scenario. If nothing needs to change, return an empty operations array.",
].join("\n")

export function buildAssistantPrompt(options: {
  item: InterceptPendingItem
  instruction: string
}): { system: string; user: string; targets: AssistantTargets } {
  const { item, instruction } = options
  const phase = item.phase.toUpperCase()
  const parts: Array<string> = [
    `# Intercepted ${phase}`,
    `Protocol: ${item.canonical.protocol}`,
    `Endpoint: ${item.method} ${item.path}`,
    `Model: ${item.model ?? "unknown"}`,
  ]
  if (item.stream !== undefined) parts.push(`Streaming: ${item.stream}`)
  if (item.responseStatus !== undefined) {
    parts.push(`Response status: ${item.responseStatus}`)
  }
  if (item.canonical.stopReason) {
    parts.push(`Stop reason: ${item.canonical.stopReason}`)
  }
  parts.push("", "# Operator scenario", instruction.trim(), "")

  const context = item.requestContext?.canonical
  if (item.phase === "response" && context && context.items.length > 0) {
    parts.push(
      "# REQUEST CONTEXT (the request that produced this response; read-only)",
      formatItems(selectItems(context.items, CONTEXT_CHAR_BUDGET)),
      "",
    )
  }

  const selection = selectItems(item.canonical.items, TARGET_CHAR_BUDGET)
  parts.push(
    `# TARGET ITEMS (the ${item.phase} you are editing)`,
    formatItems(selection),
  )

  return {
    system: SYSTEM_PROMPT,
    user: parts.join("\n"),
    targets: new Map(selection.shown.map((entry) => [entry.item.id, entry])),
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

// --- Operations -------------------------------------------------------------

const EDITABLE_KINDS = [
  "system",
  "developer",
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "thinking",
] as const

const reasonSchema = z.string().optional()

/** One diff operation, from the assistant or submitted by the operator. */
export const assistantDiffOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("replace"),
      id: z.string().min(1),
      content: z.string().optional(),
      toolName: z.string().min(1).optional(),
      toolArguments: z.string().optional(),
      reason: reasonSchema,
    })
    .refine(
      (op) =>
        op.content !== undefined
        || op.toolName !== undefined
        || op.toolArguments !== undefined,
      { message: "replace must set content, toolName, or toolArguments" },
    ),
  z.object({
    op: z.literal("delete"),
    id: z.string().min(1),
    reason: reasonSchema,
  }),
  z.object({
    op: z.literal("insert_after"),
    afterId: z.string().min(1).nullable(),
    kind: z.enum(EDITABLE_KINDS),
    content: z.string().default(""),
    toolName: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    toolArguments: z.string().optional(),
    reason: reasonSchema,
  }),
])

export const assistantDiffOpsSchema = z.array(assistantDiffOpSchema).max(200)

const assistantReplySchema = z.object({
  summary: z.string().optional(),
  operations: assistantDiffOpsSchema,
})

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function checkToolArguments(id: string, args: string | undefined): void {
  if (args === undefined || !isJsonText(args)) {
    throw new AssistantDiffError(`Tool call ${id} needs JSON arguments`)
  }
}

// eslint-disable-next-line complexity
function checkOperation(
  op: AssistantDiffOp,
  byId: ReadonlyMap<string, CanonicalItem>,
  targets: AssistantTargets | undefined,
): void {
  const target = op.op === "insert_after" ? op.afterId : op.id
  if (target !== null) {
    const known = targets ? targets.has(target) : byId.has(target)
    if (!known) throw new AssistantDiffError(`Unknown item id ${target}`)
  }
  if (op.op === "delete") return
  if (op.op === "insert_after") {
    if (op.kind === "tool_call") {
      if (!op.toolName) {
        throw new AssistantDiffError("An inserted tool call needs toolName")
      }
      checkToolArguments("insert", op.toolArguments ?? op.content)
    }
    if (op.kind === "tool_result" && !op.toolCallId) {
      throw new AssistantDiffError("An inserted tool result needs toolCallId")
    }
    return
  }

  const item = byId.get(op.id)
  if (!item) throw new AssistantDiffError(`Unknown item id ${op.id}`)
  if (item.opaque) {
    throw new AssistantDiffError(
      `Item ${op.id} is read-only; it can be kept or deleted`,
    )
  }
  // Tool calls show their arguments, so those are the text a cut view hides.
  const replacesText =
    op.content !== undefined || op.toolArguments !== undefined
  if (replacesText && targets?.get(op.id)?.truncated) {
    throw new AssistantDiffError(
      `Item ${op.id} was shown truncated, so its content cannot be replaced`,
    )
  }
  if (item.kind === "tool_call") {
    if (op.toolArguments !== undefined || op.content !== undefined) {
      checkToolArguments(op.id, op.toolArguments ?? op.content)
    }
  } else if (op.toolName !== undefined || op.toolArguments !== undefined) {
    throw new AssistantDiffError(
      `Item ${op.id} is not a tool call; toolName and toolArguments do not apply`,
    )
  }
}

/**
 * Throw `AssistantDiffError` unless every operation addresses a known item in
 * a way that can be applied. Assistant output may address only `targets`, the
 * items its prompt showed.
 */
export function validateDiffOps(
  items: ReadonlyArray<CanonicalItem>,
  operations: ReadonlyArray<AssistantDiffOp>,
  targets?: AssistantTargets,
): void {
  const byId = new Map(items.map((item) => [item.id, item]))
  const changed = new Set<string>()
  const deleted = new Set<string>()
  for (const op of operations) {
    checkOperation(op, byId, targets)
    if (op.op === "insert_after") continue
    if (changed.has(op.id)) {
      throw new AssistantDiffError(`Item ${op.id} is changed more than once`)
    }
    changed.add(op.id)
    if (op.op === "delete") deleted.add(op.id)
  }
  for (const op of operations) {
    if (op.op === "insert_after" && op.afterId && deleted.has(op.afterId)) {
      throw new AssistantDiffError(
        `Cannot insert after ${op.afterId}, which is deleted`,
      )
    }
  }
}

function extractJson(raw: string): unknown {
  let candidate = raw.trim()
  // A reply wrapped in a Markdown code fence: drop the fence lines.
  if (candidate.startsWith("```") && candidate.endsWith("```")) {
    const firstLineEnd = candidate.indexOf("\n")
    candidate = firstLineEnd === -1 ? "" : candidate.slice(firstLineEnd, -3)
  }
  try {
    return JSON.parse(candidate)
  } catch {
    throw new AssistantDiffError("The assistant did not reply with JSON")
  }
}

/** Parse and schema-check an assistant reply. Malformed replies throw. */
export function parseAssistantDiffResponse(raw: string): {
  summary: string
  operations: Array<AssistantDiffOp>
} {
  const parsed = assistantReplySchema.safeParse(extractJson(raw))
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0)
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new AssistantDiffError(
      `The assistant's reply is not a valid change set${where}: ${issue?.message ?? "invalid"}`,
    )
  }
  return {
    summary: parsed.data.summary?.trim() || "Suggested changes",
    operations: parsed.data.operations,
  }
}

// --- Invocation -------------------------------------------------------------

function assistantReplyText(
  result: ChatCompletionResponse | AsyncIterable<unknown>,
): string {
  if (Symbol.asyncIterator in result) {
    throw new Error("The assistant model returned a stream")
  }
  const content = result.choices[0]?.message.content
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The assistant model returned no text")
  }
  return content
}

/** One attempt; the fallback runner supplies the model for retries. */
async function sendAssistantAttempt(
  source: ChatCompletionsPayload,
  signal: AbortSignal | undefined,
): Promise<{ model: string; content: string }> {
  const payload = applyModelFallbackToPayload(structuredClone(source))
  const { model } = payload
  const destination = resolveAssistantDestination(model)
  if (!destination) {
    throw new Error(
      `${model} cannot run AI Assist: it is not an available Chat Completions model`,
    )
  }
  const effort = normalizeReasoningEffortForModel(
    model,
    getModelFallbackEffort(),
  )
  if (destination.kind === "custom") {
    const result = await createCustomProviderChatCompletions(
      destination.reference,
      { ...payload, model: destination.reference.upstreamModel },
      { signal, reasoningEffort: effort },
    )
    return { model, content: assistantReplyText(result) }
  }
  if (effort) payload.reasoning_effort = effort
  const result = await createChatCompletions(payload, { signal })
  return { model, content: assistantReplyText(result) }
}

async function invokeAssistantModel(options: {
  model: string
  system: string
  user: string
  signal?: AbortSignal
}): Promise<{ model: string; content: string }> {
  const { signal } = options
  const payload: ChatCompletionsPayload = {
    model: options.model,
    stream: false,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
  }
  // A separate request: the held request's account, fallback, telemetry and
  // response headers stay untouched, and its own traffic is never intercepted.
  // Configured model fallbacks apply as on the Chat Completions route.
  return await runAsIndependentRequest(
    "Intercept Assistant",
    async () =>
      await runBypassingIntercept(
        async () =>
          await runWithModelFallback(
            { payload, signal },
            async () => await sendAssistantAttempt(payload, signal),
          ),
      ),
  )
}

export interface RunInterceptAssistantOptions {
  /** Snapshot of the held item; the engine binds the result to its revision. */
  item: InterceptPendingItem
  config: InterceptAssistantConfig
  instructionOverride?: string
  modelOverride?: string
  /** Aborted when the item resolves or a newer run replaces this one. */
  signal?: AbortSignal
}

export type InterceptAssistantResult = Omit<AssistantSuggestion, "revision">

export type InterceptAssistantRunner = (
  options: RunInterceptAssistantOptions,
) => Promise<InterceptAssistantResult>

export async function runInterceptAssistant(
  options: RunInterceptAssistantOptions,
): Promise<InterceptAssistantResult> {
  const startedAt = Date.now()
  const { item, signal } = options
  if (!item.canonical.editable) {
    throw new Error(
      `AI Assist needs a structured payload. ${item.canonical.readOnlyReason ?? "This one can only be edited as raw text."}`,
    )
  }
  const model = (options.modelOverride ?? options.config.model).trim()
  if (!model) throw new Error("Select an assistant model in AI Assist settings")
  const instruction =
    options.instructionOverride?.trim()
    || resolveAssistantInstruction(options.config, item.phase)
  if (!instruction) {
    throw new Error(`No AI Assist instruction is set for ${item.phase}s`)
  }

  const prompt = buildAssistantPrompt({ item, instruction })
  const reply = await invokeAssistantModel({
    model,
    system: prompt.system,
    user: prompt.user,
    signal,
  })
  const { summary, operations } = parseAssistantDiffResponse(reply.content)
  validateDiffOps(item.canonical.items, operations, prompt.targets)

  let previewBody: string | null = null
  let previewCanonical: CanonicalView | null = null
  if (operations.length > 0) {
    // Throws CanonicalEditError when the result cannot be written back.
    previewBody = serializeCanonicalItemsToBody({
      originalBody: item.currentBody,
      canonical: item.canonical,
      items: applyCanonicalDiffOps(item.canonical.items, operations),
      contentType: item.responseContentType,
    })
    previewCanonical = parseCanonicalView({
      path: item.path,
      phase: item.phase,
      body: previewBody,
      contentType: item.responseContentType,
    })
  }

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    model: reply.model,
    summary,
    operations,
    previewBody,
    previewCanonical,
    durationMs: Date.now() - startedAt,
  }
}
