import { randomUUID } from "node:crypto"
import { z } from "zod"

import type {
  AssistantDiffOp,
  AssistantSuggestion,
  CanonicalItem,
  CanonicalView,
  InterceptAssistantConfig,
  InterceptPendingItem,
} from "./types"

import {
  type AssistantSessionCache,
  assistantCacheScope,
  itemCacheKeys,
  START_KEY,
} from "./assistant-cache"
import { invokeAssistantModel } from "./assistant-model"
import {
  ASSISTANT_RESPONSE_CONTRACT,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
} from "./assistant-prompt"
import {
  applyCanonicalDiffOps,
  applyTextEdit,
  editableText,
  parseCanonicalView,
  serializeCanonicalItemsToBody,
} from "./canonical"
import { INTERCEPT_ASSISTANT_KINDS } from "./types"

/** Operations that cannot be applied to the item they were written for. */
export class AssistantDiffError extends Error {}

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
  /** The item exactly as the prompt shows it; the budget charges this. */
  rendered: string
}

/** Items shown in the target section; operations may address only these. */
export type AssistantTargets = ReadonlyMap<string, ProjectedItem>

function isInstruction(item: CanonicalItem): boolean {
  return item.kind === "system" || item.kind === "developer"
}

function renderItem(
  item: CanonicalItem,
  text: string,
  truncated: boolean,
): ProjectedItem {
  const meta = [`id=${item.id}`, `kind=${item.kind}`]
  if (item.toolName) meta.push(`tool=${item.toolName}`)
  if (item.toolCallId) meta.push(`call_id=${item.toolCallId}`)
  if (item.opaque) meta.push("read-only")
  if (truncated) meta.push("truncated")
  const rendered = `### [${meta.join(" | ")}]\n${text}\n\n`
  return { item, text, truncated, rendered }
}

function projectItem(item: CanonicalItem): ProjectedItem {
  if (item.opaque) {
    return renderItem(item, `(${item.label}: content not shown)`, false)
  }
  const text = editableText(item)
  const limit = isInstruction(item) ? INSTRUCTION_CHAR_LIMIT : ITEM_CHAR_LIMIT
  if (text.length <= limit) return renderItem(item, text, false)
  return renderItem(
    item,
    `${text.slice(0, limit)}\n[${text.length - limit} more characters not shown]`,
    true,
  )
}

interface ItemSelection {
  shown: Array<ProjectedItem>
  /** Instruction items left out because they do not fit the budget. */
  omittedInstructions: number
  /** The oldest non-instruction items, left out to fit the budget. */
  omittedOlder: number
}

function omissionNotes(
  omittedInstructions: number,
  omittedOlder: number,
): string {
  let notes = ""
  if (omittedInstructions > 0) {
    notes += `(${omittedInstructions} system or developer items are not shown: they exceed the size limit.)\n`
  }
  if (omittedOlder > 0) {
    notes += `(${omittedOlder} older items are not shown.)\n`
  }
  return notes && `${notes}\n`
}

/**
 * Instructions first, in order, while they fit; then the newest other items
 * that fit. The rendered section, omission notes included, stays within
 * `budget` and keeps the original order.
 */
function selectItems(
  items: ReadonlyArray<CanonicalItem>,
  budget: number,
): ItemSelection {
  const projected = items.map((item) => projectItem(item))
  const keep = new Set<number>()
  // Room for the notes at their longest: no count exceeds the item count.
  let used = omissionNotes(items.length, items.length).length
  let instructionsFit = true
  for (const [index, entry] of projected.entries()) {
    if (!isInstruction(entry.item)) continue
    if (instructionsFit && used + entry.rendered.length <= budget) {
      keep.add(index)
      used += entry.rendered.length
    } else {
      instructionsFit = false
    }
  }
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    if (isInstruction(projected[index].item)) continue
    used += projected[index].rendered.length
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
  const notes = omissionNotes(omittedInstructions, omittedOlder)
  const section = notes + shown.map((entry) => entry.rendered).join("")
  return section.trim() || "(no items)"
}

/** The operator's system prompt, or the default when blank, then the reply contract. */
export function resolveAssistantSystemPrompt(systemPrompt?: string): string {
  const role = systemPrompt?.trim() || DEFAULT_ASSISTANT_SYSTEM_PROMPT
  return `${role}\n\n${ASSISTANT_RESPONSE_CONTRACT}`
}

export function buildAssistantPrompt(options: {
  item: InterceptPendingItem
  instruction: string
  systemPrompt?: string
  /** Items the model may change; all of the item's items by default. */
  targets?: ReadonlyArray<CanonicalItem>
  /** Request items shown read-only for a response; its request by default. */
  context?: ReadonlyArray<CanonicalItem>
  /** Lines shown above the target items, such as what was left out. */
  notes?: ReadonlyArray<string>
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

  const context = options.context ?? item.requestContext?.canonical.items ?? []
  if (item.phase === "response" && context.length > 0) {
    parts.push(
      "# REQUEST CONTEXT (the request that produced this response; read-only)",
      formatItems(selectItems(context, CONTEXT_CHAR_BUDGET)),
      "",
    )
  }

  const selection = selectItems(
    options.targets ?? item.canonical.items,
    TARGET_CHAR_BUDGET,
  )
  parts.push(`# TARGET ITEMS (the ${item.phase} you are editing)`)
  if (options.notes?.length) parts.push(...options.notes, "")
  parts.push(formatItems(selection))

  return {
    system: resolveAssistantSystemPrompt(options.systemPrompt),
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
  z.object({
    op: z.literal("edit"),
    id: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
    reason: reasonSchema,
  }),
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
  // The search runs on the full text, so a cut view does not matter here.
  if (op.op === "edit") return
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

/** Apply `op` to the text earlier edits left; throws when it does not fit. */
function checkEdit(
  op: Extract<AssistantDiffOp, { op: "edit" }>,
  byId: ReadonlyMap<string, CanonicalItem>,
  edited: Map<string, string>,
): void {
  const item = byId.get(op.id) as CanonicalItem
  const result = applyTextEdit(
    edited.get(op.id) ?? editableText(item),
    op.find,
    op.replace,
  )
  if (!result.ok) {
    throw new AssistantDiffError(
      `The text to change in ${op.id} was ${result.reason}`,
    )
  }
  edited.set(op.id, result.text)
}

/**
 * Throw `AssistantDiffError` unless every operation addresses a known item in
 * a way that can be applied. Assistant output may address only `targets`, the
 * items its prompt showed. Edits apply in order, each to the text the
 * previous ones left.
 */
export function validateDiffOps(
  items: ReadonlyArray<CanonicalItem>,
  operations: ReadonlyArray<AssistantDiffOp>,
  targets?: AssistantTargets,
): void {
  const byId = new Map(items.map((item) => [item.id, item]))
  const changed = new Set<string>()
  const deleted = new Set<string>()
  const edited = new Map<string, string>()
  for (const op of operations) {
    checkOperation(op, byId, targets)
    if (op.op === "insert_after") continue
    if (changed.has(op.id) || (op.op !== "edit" && edited.has(op.id))) {
      throw new AssistantDiffError(`Item ${op.id} is changed more than once`)
    }
    if (op.op === "edit") {
      checkEdit(op, byId, edited)
      continue
    }
    changed.add(op.id)
    if (op.op === "delete") deleted.add(op.id)
  }
  for (const [id, text] of edited) {
    if (byId.get(id)?.kind === "tool_call") checkToolArguments(id, text)
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

export interface RunInterceptAssistantOptions {
  /** Snapshot of the held item; the engine binds the result to its revision. */
  item: InterceptPendingItem
  config: InterceptAssistantConfig
  instructionOverride?: string
  modelOverride?: string
  /** Aborted when the item resolves or a newer run replaces this one. */
  signal?: AbortSignal
  /** This Intercept session's earlier results; without it nothing is reused. */
  cache?: AssistantSessionCache
  /** Send every item to the model, ignoring `cache`. */
  fresh?: boolean
}

export type InterceptAssistantResult = Omit<AssistantSuggestion, "revision">

export type InterceptAssistantRunner = (
  options: RunInterceptAssistantOptions,
) => Promise<InterceptAssistantResult>

/** The model a run calls, or an error naming what is missing. */
function runModel(
  options: Pick<RunInterceptAssistantOptions, "config" | "modelOverride">,
): string {
  const model = (options.modelOverride ?? options.config.model).trim()
  if (!model) throw new Error("Select an assistant model in AI Assist settings")
  return model
}

/** The user message a run sends, or an error naming what is missing. */
function runInstruction(
  options: Pick<
    RunInterceptAssistantOptions,
    "config" | "instructionOverride" | "item"
  >,
): string {
  const instruction =
    options.instructionOverride?.trim()
    || resolveAssistantInstruction(options.config, options.item.phase)
  if (!instruction) {
    throw new Error(
      `No AI Assist user message is set for ${options.item.phase}s`,
    )
  }
  return instruction
}

/** The cache scope of a run: everything that changes the assistant's answer. */
export function assistantRunScope(
  options: Pick<
    RunInterceptAssistantOptions,
    "config" | "instructionOverride" | "modelOverride" | "item"
  >,
): string {
  return assistantCacheScope({
    model: runModel(options),
    reasoningEffort: options.config.reasoningEffort,
    systemPrompt: options.config.systemPrompt,
    instruction: runInstruction(options),
    messageKinds: options.config.messageKinds,
  })
}

interface AssistantPlan {
  /** Cache key per item id. */
  keys: Map<string, string>
  /** Earlier results for items handled before, addressed to this item. */
  reused: Array<AssistantDiffOp>
  reusedItemCount: number
  /** Items of the selected types the model has not handled yet. */
  fresh: Array<CanonicalItem>
  /** Items left out because their type is not selected. */
  otherKinds: number
  /** Read-only request items to show a response's model. */
  context: Array<CanonicalItem>
  contextKeys: Array<string>
}

function planContext(
  plan: AssistantPlan,
  options: { item: InterceptPendingItem; kinds: ReadonlySet<string> },
  memory: { cache?: AssistantSessionCache; scope: string },
): void {
  const context = options.item.requestContext?.canonical.items ?? []
  const keys = itemCacheKeys(context)
  for (const [index, entry] of context.entries()) {
    const key = keys[index]
    const seen =
      memory.cache?.wasShown(memory.scope, key)
      || memory.cache?.lookup(memory.scope, key, null) !== undefined
    if (!options.kinds.has(entry.kind) || seen) continue
    plan.context.push(entry)
    plan.contextKeys.push(key)
  }
}

function planAssistantRun(
  options: RunInterceptAssistantOptions,
  scope: string,
): AssistantPlan {
  const { item } = options
  const cache = options.fresh ? undefined : options.cache
  const kinds = new Set<string>(options.config.messageKinds)
  const items = item.canonical.items
  const keys = itemCacheKeys(items)
  const plan: AssistantPlan = {
    keys: new Map(items.map((entry, index) => [entry.id, keys[index]])),
    reused: [],
    reusedItemCount: 0,
    fresh: [],
    otherKinds: 0,
    context: [],
    contextKeys: [],
  }
  for (const [index, entry] of items.entries()) {
    if (!kinds.has(entry.kind)) {
      plan.otherKinds += 1
      continue
    }
    const earlier = cache?.lookup(scope, keys[index], entry.id)
    if (!earlier) {
      plan.fresh.push(entry)
      continue
    }
    plan.reusedItemCount += 1
    plan.reused.push(...earlier)
  }
  if (plan.reusedItemCount > 0) {
    const start = cache?.lookup(scope, `${START_KEY}:${item.phase}`, null)
    if (start) plan.reused.unshift(...start)
  }
  planContext(plan, { item, kinds }, { cache, scope })
  return plan
}

function planNotes(
  plan: AssistantPlan,
  kinds: ReadonlyArray<string>,
): Array<string> {
  const notes: Array<string> = []
  if (plan.reusedItemCount > 0) {
    notes.push(
      `(${plan.reusedItemCount} items handled earlier in this session are not shown; their changes are kept. Do not insert at the very start again.)`,
    )
  }
  if (plan.otherKinds > 0) {
    notes.push(`(${plan.otherKinds} items of other kinds are not shown.)`)
  }
  if (kinds.length < INTERCEPT_ASSISTANT_KINDS.length) {
    notes.push(
      `Change and insert only items of these kinds: ${kinds.join(", ")}.`,
    )
  }
  return notes
}

function checkInsertKinds(
  operations: ReadonlyArray<AssistantDiffOp>,
  kinds: ReadonlyArray<string>,
): void {
  for (const op of operations) {
    if (op.op === "insert_after" && !kinds.includes(op.kind)) {
      throw new AssistantDiffError(
        `AI Assist may only insert ${kinds.join(", ")} items, not ${op.kind}`,
      )
    }
  }
}

const REPLY_EXCERPT_LENGTH = 600

/** What was wrong with a reply, with the reply, for the operator and the log. */
function describeBadReply(error: AssistantDiffError, reply: string): Error {
  const text = reply.trim()
  const excerpt =
    text.length > REPLY_EXCERPT_LENGTH ?
      `${text.slice(0, REPLY_EXCERPT_LENGTH)}…`
    : text
  return new AssistantDiffError(
    `${error.message}\nModel reply: ${excerpt || "(empty)"}`,
  )
}

interface ModelAnswer {
  model: string
  summary: string
  operations: Array<AssistantDiffOp>
  /** Ids of the items the model was shown and may have changed. */
  shown: ReadonlyArray<string>
}

/** Ask the model about `plan.fresh`; its operations, checked against the item. */
async function askModel(
  options: RunInterceptAssistantOptions,
  plan: AssistantPlan,
): Promise<ModelAnswer> {
  const { item, config } = options
  const prompt = buildAssistantPrompt({
    item,
    instruction: runInstruction(options),
    systemPrompt: config.systemPrompt,
    targets: plan.fresh,
    context: plan.context,
    notes: planNotes(plan, config.messageKinds),
  })
  const reply = await invokeAssistantModel({
    model: runModel(options),
    system: prompt.system,
    user: prompt.user,
    effort:
      config.reasoningEffort === "default" ? undefined : config.reasoningEffort,
    signal: options.signal,
  })
  try {
    const { summary, operations } = parseAssistantDiffResponse(reply.content)
    checkInsertKinds(operations, config.messageKinds)
    validateDiffOps(item.canonical.items, operations, prompt.targets)
    return {
      model: reply.model,
      summary,
      operations,
      shown: [...prompt.targets.keys()],
    }
  } catch (error) {
    if (error instanceof AssistantDiffError) {
      throw describeBadReply(error, reply.content)
    }
    throw error
  }
}

/** Remember what the model decided for each item it was shown. */
function rememberAnswer(
  options: RunInterceptAssistantOptions & { cache: AssistantSessionCache },
  run: { scope: string; plan: AssistantPlan; answer: ModelAnswer },
): void {
  const { cache, item } = options
  const { scope, plan, answer } = run
  for (const id of answer.shown) {
    const key = plan.keys.get(id)
    if (key === undefined) continue
    const own = answer.operations.filter((op) =>
      op.op === "insert_after" ? op.afterId === id : op.id === id,
    )
    cache.remember(scope, key, { itemId: id, operations: own })
  }
  const start = answer.operations.filter(
    (op) => op.op === "insert_after" && op.afterId === null,
  )
  if (start.length > 0) {
    const startKey = `${START_KEY}:${item.phase}`
    const earlier = cache.lookup(scope, startKey, null) ?? []
    cache.remember(scope, startKey, {
      itemId: null,
      operations: [...earlier, ...start],
    })
  }
  cache.markShown(scope, plan.contextKeys)
}

function preview(
  item: InterceptPendingItem,
  operations: ReadonlyArray<AssistantDiffOp>,
): { previewBody: string | null; previewCanonical: CanonicalView | null } {
  if (operations.length === 0) {
    return { previewBody: null, previewCanonical: null }
  }
  // Throws CanonicalEditError when the result cannot be written back.
  const previewBody = serializeCanonicalItemsToBody({
    originalBody: item.currentBody,
    canonical: item.canonical,
    items: applyCanonicalDiffOps(item.canonical.items, operations),
    contentType: item.responseContentType,
  })
  return {
    previewBody,
    previewCanonical: parseCanonicalView({
      path: item.path,
      phase: item.phase,
      body: previewBody,
      contentType: item.responseContentType,
    }),
  }
}

/**
 * Propose changes for a held item. Items of the selected message types that
 * this session already handled reuse their earlier result; only the rest go
 * to the model, and none at all when nothing is new.
 */
export async function runInterceptAssistant(
  options: RunInterceptAssistantOptions,
): Promise<InterceptAssistantResult> {
  const startedAt = Date.now()
  const { item, cache } = options
  if (!item.canonical.editable) {
    throw new Error(
      `AI Assist needs a structured payload. ${item.canonical.readOnlyReason ?? "This one can only be edited as raw text."}`,
    )
  }
  const scope = assistantRunScope(options)
  const plan = planAssistantRun(options, scope)

  let model = runModel(options)
  let summary =
    plan.reusedItemCount > 0 ?
      `Reused earlier results for ${plan.reusedItemCount} items`
    : "No items of the selected message types to review"
  let operations = plan.reused
  if (plan.fresh.length > 0) {
    const answer = await askModel(options, plan)
    model = answer.model
    summary = answer.summary
    operations = [...plan.reused, ...answer.operations]
    // Reused and new changes must apply together.
    validateDiffOps(item.canonical.items, operations)
    if (cache) rememberAnswer({ ...options, cache }, { scope, plan, answer })
  }

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    model,
    summary,
    operations,
    ...preview(item, operations),
    durationMs: Date.now() - startedAt,
    reusedItemCount: plan.reusedItemCount,
    reusedOperationCount: plan.reused.length,
  }
}
