import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { isAdminSessionActive } from "~/lib/admin-auth"
import {
  AssistantDiffError,
  assistantDiffOpsSchema,
  listAssistantModels,
} from "~/lib/intercept/assistant"
import {
  ASSISTANT_RESPONSE_CONTRACT,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
} from "~/lib/intercept/assistant-prompt"
import { CanonicalEditError } from "~/lib/intercept/canonical"
import {
  CaptureBudgetError,
  interceptEngine,
  StaleRevisionError,
} from "~/lib/intercept/engine"
import { validateFilterRegex } from "~/lib/intercept/filters"
import { INTERCEPT_ASSISTANT_EFFORTS } from "~/lib/intercept/types"

const filterConditionSchema = z
  .object({
    id: z.string().max(128).optional().default(""),
    enabled: z.boolean().optional().default(true),
    field: z.enum([
      "sessionId",
      "model",
      "path",
      "upstream",
      "requestBody",
      "responseBody",
      "header",
      "direction",
    ]),
    headerName: z.string().trim().max(128).optional(),
    operator: z.enum([
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "regex",
      "starts_with",
    ]),
    value: z.string().max(4000).optional().default(""),
    caseSensitive: z.boolean().optional().default(false),
  })
  .refine(
    (condition) =>
      condition.field !== "header" || Boolean(condition.headerName),
    { message: "Header conditions need a header name", path: ["headerName"] },
  )

const configPatchSchema = z.object({
  enabled: z.boolean().optional(),
  direction: z.enum(["both", "request", "response"]).optional(),
  timeoutSeconds: z.number().min(15).max(3600).optional(),
  timeoutAction: z.enum(["forward", "drop"]).optional(),
  filters: z
    .object({
      enabled: z.boolean(),
      matchMode: z.enum(["all", "any"]),
      conditions: z.array(filterConditionSchema).max(50),
    })
    .optional(),
  assistant: z
    .object({
      enabled: z.boolean(),
      autoRun: z.boolean(),
      autopilot: z.enum(["off", "request", "response", "both"]).default("off"),
      model: z.string().max(256),
      reasoningEffort: z.enum(INTERCEPT_ASSISTANT_EFFORTS),
      systemPrompt: z.string().max(16000),
      instructionMode: z.enum(["shared", "separate"]),
      sharedInstruction: z.string().max(16000),
      requestInstruction: z.string().max(16000),
      responseInstruction: z.string().max(16000),
    })
    .optional(),
})

const canonicalItemSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "system",
    "developer",
    "user",
    "assistant",
    "tool_call",
    "tool_result",
    "thinking",
    "other",
  ]),
  role: z.string().optional(),
  label: z.string(),
  content: z.string(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  toolArguments: z.string().optional(),
  opaque: z.boolean().optional(),
})

// Structured item IDs are positional, so a structured edit may only patch the
// revision it was parsed from. A raw body is an explicit full replacement.
const editItemSchema = z
  .object({
    body: z.string().optional(),
    canonicalItems: z.array(canonicalItemSchema).optional(),
    baseRevision: z.number().int().min(0).optional(),
  })
  .refine((edit) => (edit.body === undefined) !== !edit.canonicalItems, {
    message: "Send either body or canonicalItems",
  })
  .refine((edit) => !edit.canonicalItems || edit.baseRevision !== undefined, {
    message: "canonicalItems needs the baseRevision it was edited from",
  })

const dropSchema = z.object({ reason: z.string().max(500).optional() })

const triggerAssistantSchema = z.object({
  instruction: z.string().max(16000).optional(),
  model: z.string().max(256).optional(),
})

const applyAssistantSchema = z.object({
  suggestionId: z.string().min(1),
  revision: z.number().int().min(0),
  operations: assistantDiffOpsSchema.optional(),
})

type ParsedBody<T> = { ok: true; value: T } | { ok: false; error: string }

function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback
}

/**
 * Parse a JSON body against `schema`. An empty body is `undefined`; malformed
 * JSON or a schema mismatch is an error, never treated as an absent body.
 */
async function readJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
  options: { optional: boolean },
): Promise<ParsedBody<T | undefined>> {
  const text = await c.req.text()
  if (!text.trim()) {
    return options.optional ?
        { ok: true, value: undefined }
      : { ok: false, error: "A JSON body is required" }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: "The body is not valid JSON" }
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ?
      { ok: true, value: parsed.data }
    : { ok: false, error: firstIssue(parsed.error, "Invalid request body") }
}

/**
 * 409: the item changed underneath. 413: capture memory cannot hold the edit.
 * 422: the edit cannot be written back.
 */
function editFailure(c: Context, error: unknown) {
  if (error instanceof StaleRevisionError) {
    return c.json({ error: error.message }, 409)
  }
  if (error instanceof CaptureBudgetError) {
    return c.json({ error: error.message }, 413)
  }
  if (
    error instanceof CanonicalEditError
    || error instanceof AssistantDiffError
  ) {
    return c.json({ error: error.message }, 422)
  }
  throw error
}

function notHeld(c: Context) {
  return c.json({ error: "Pending intercept item not found" }, 404)
}

export function handleGetInterceptState(c: Context) {
  return c.json({
    ...interceptEngine.getSnapshot(),
    availableModels: listAssistantModels(),
    assistantDefaults: {
      systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      responseFormat: ASSISTANT_RESPONSE_CONTRACT,
    },
  })
}

export async function handleUpdateInterceptConfig(c: Context) {
  const body = await readJsonBody(c, configPatchSchema, { optional: false })
  if (!body.ok) return c.json({ error: body.error }, 400)
  const patch = body.value ?? {}

  for (const condition of patch.filters?.conditions ?? []) {
    if (condition.operator !== "regex" || !condition.value) continue
    const regexError = validateFilterRegex(condition.value)
    if (regexError) {
      return c.json(
        { error: `Invalid regex "${condition.value}": ${regexError}` },
        400,
      )
    }
  }

  const config = interceptEngine.updateConfig(patch)
  return c.json({ config, snapshot: interceptEngine.getSnapshot() })
}

export function handleGetInterceptItem(c: Context) {
  const item = interceptEngine.getItem(c.req.param("id") ?? "")
  if (!item) return c.json({ error: "Intercept item not found" }, 404)
  return c.json(item)
}

export async function handleEditInterceptItem(c: Context) {
  const body = await readJsonBody(c, editItemSchema, { optional: false })
  if (!body.ok) return c.json({ error: body.error }, 400)
  try {
    const updated = interceptEngine.editPendingItem(
      c.req.param("id") ?? "",
      body.value ?? {},
    )
    return updated ? c.json(updated) : notHeld(c)
  } catch (error) {
    return editFailure(c, error)
  }
}

export async function handleForwardInterceptItem(c: Context) {
  const id = c.req.param("id") ?? ""
  const body = await readJsonBody(c, editItemSchema, { optional: true })
  if (!body.ok) return c.json({ error: body.error }, 400)
  try {
    if (!interceptEngine.forwardItem(id, body.value)) return notHeld(c)
  } catch (error) {
    return editFailure(c, error)
  }
  return c.json({ ok: true, id })
}

export async function handleDropInterceptItem(c: Context) {
  const id = c.req.param("id") ?? ""
  const body = await readJsonBody(c, dropSchema, { optional: true })
  if (!body.ok) return c.json({ error: body.error }, 400)
  const reason = body.value?.reason?.trim() || undefined
  if (!interceptEngine.dropItem(id, reason)) return notHeld(c)
  return c.json({ ok: true, id })
}

export function handleForwardAllIntercept(c: Context) {
  const count = interceptEngine.forwardAllPending()
  return c.json({ ok: true, count })
}

export function handleDropAllIntercept(c: Context) {
  const count = interceptEngine.dropAllPending()
  return c.json({ ok: true, count })
}

export function handleClearInterceptRecent(c: Context) {
  interceptEngine.clearRecent()
  return c.json({ ok: true })
}

export async function handleTriggerInterceptAssistant(c: Context) {
  const body = await readJsonBody(c, triggerAssistantSchema, {
    optional: true,
  })
  if (!body.ok) return c.json({ error: body.error }, 400)
  const updated = await interceptEngine.triggerAssistant(
    c.req.param("id") ?? "",
    body.value,
  )
  return updated ? c.json(updated) : notHeld(c)
}

export async function handleApplyInterceptAssistant(c: Context) {
  const body = await readJsonBody(c, applyAssistantSchema, { optional: false })
  if (!body.ok || !body.value) {
    return c.json(
      { error: body.ok ? "A JSON body is required" : body.error },
      400,
    )
  }
  const { suggestionId, revision, operations } = body.value
  try {
    const updated = interceptEngine.applyAssistantDiff(
      c.req.param("id") ?? "",
      { suggestionId, revision },
      operations,
    )
    return updated ? c.json(updated) : notHeld(c)
  } catch (error) {
    return editFailure(c, error)
  }
}

export function handleRejectInterceptAssistant(c: Context) {
  const updated = interceptEngine.rejectAssistantSuggestion(
    c.req.param("id") ?? "",
  )
  return updated ? c.json(updated) : notHeld(c)
}

const HEARTBEAT_MS = 15_000
/** A client this far behind reconnects and starts again from a snapshot. */
const MAX_QUEUED_EVENTS = 500

export function handleInterceptEvents(c: Context) {
  c.header("Cache-Control", "no-store")
  return streamSSE(c, async (stream) => {
    const { promise: finished, resolve: finish } = Promise.withResolvers<null>()
    let closed = false
    let queued = 0
    let delivery = Promise.resolve()

    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      finish(null)
    }

    // Every event is delivered only while the session that opened the stream
    // is current: logout, a password change, or expiry ends it at once. The
    // check never extends the session, so an open stream cannot keep it alive.
    const deliver = async (message: { event: string; data: string }) => {
      if (closed) return
      if (!(await isAdminSessionActive(c.req.raw))) {
        close()
        return
      }
      await stream.writeSSE(message)
    }

    // Writes run one at a time and in order.
    const send = (event: string, data: string) => {
      if (closed) return
      if (queued >= MAX_QUEUED_EVENTS) {
        close()
        return
      }
      queued += 1
      delivery = delivery
        .then(() => deliver({ event, data }))
        .catch(close)
        .finally(() => {
          queued -= 1
        })
    }

    // Cleanup is registered and the snapshot queued in the same tick as the
    // subscription, so no event is lost and an early disconnect is seen.
    stream.onAbort(close)
    const unsubscribe = interceptEngine.subscribe((event) => {
      send(event.type, JSON.stringify(event))
    })
    const heartbeat = setInterval(() => {
      send("ping", String(Date.now()))
    }, HEARTBEAT_MS)
    send("snapshot", JSON.stringify(interceptEngine.getSnapshot()))
    if (stream.aborted) close()

    await finished
  })
}
