import type { Context } from "hono"

import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { getCustomProviderModels } from "~/lib/custom-providers"
import { interceptEngine } from "~/lib/intercept/engine"
import { validateFilterRegex } from "~/lib/intercept/filters"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

const filterConditionSchema = z.object({
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
  headerName: z.string().max(128).optional(),
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
      model: z.string().max(256),
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

const editItemSchema = z.object({
  body: z.string().optional(),
  canonicalItems: z.array(canonicalItemSchema).optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

const assistantOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    id: z.string(),
    content: z.string().optional(),
    toolName: z.string().optional(),
    toolArguments: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal("delete"),
    id: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal("insert_after"),
    afterId: z.string().nullable(),
    kind: z.enum([
      "system",
      "developer",
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "thinking",
    ]),
    content: z.string(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    toolArguments: z.string().optional(),
    reason: z.string().optional(),
  }),
])

function collectAvailableModels(): Array<string> {
  const models = new Set<string>()
  for (const m of state.models?.data ?? []) {
    if (m.id) models.add(m.id)
  }
  for (const m of tokenPool.getAllModels().data) {
    if (m.id) models.add(m.id)
  }
  try {
    for (const m of getCustomProviderModels()) {
      if (m.kind === "chat" && m.id) models.add(m.id)
    }
  } catch {
    // Storage may not be initialized in unit tests
  }
  return [...models].sort((a, b) => a.localeCompare(b))
}

export function handleGetInterceptState(c: Context) {
  return c.json({
    ...interceptEngine.getSnapshot(),
    availableModels: collectAvailableModels(),
  })
}

export async function handleUpdateInterceptConfig(c: Context) {
  const raw: unknown = await c.req.json().catch(() => null)
  const parsed = configPatchSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid intercept config" },
      400,
    )
  }

  if (parsed.data.filters) {
    for (const cond of parsed.data.filters.conditions) {
      if (cond.operator === "regex" && cond.value) {
        const regexError = validateFilterRegex(cond.value)
        if (regexError) {
          return c.json(
            { error: `Invalid regex "${cond.value}": ${regexError}` },
            400,
          )
        }
      }
    }
  }

  const config = interceptEngine.updateConfig(parsed.data)
  return c.json({ config, snapshot: interceptEngine.getSnapshot() })
}

export function handleGetInterceptItem(c: Context) {
  const id = c.req.param("id") ?? ""
  const item = interceptEngine.getItem(id)
  if (!item) return c.json({ error: "Intercept item not found" }, 404)
  return c.json(item)
}

export async function handleEditInterceptItem(c: Context) {
  const id = c.req.param("id") ?? ""
  const raw: unknown = await c.req.json().catch(() => null)
  const parsed = editItemSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid edit payload" },
      400,
    )
  }
  const updated = interceptEngine.editPendingItem(id, parsed.data)
  if (!updated) {
    return c.json({ error: "Pending intercept item not found" }, 404)
  }
  return c.json(updated)
}

export async function handleForwardInterceptItem(c: Context) {
  const id = c.req.param("id") ?? ""
  const raw: unknown = await c.req.json().catch(() => undefined)
  let override: z.infer<typeof editItemSchema> | undefined
  if (raw !== undefined && raw !== null) {
    const parsed = editItemSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid forward payload" },
        400,
      )
    }
    override = parsed.data
  }
  const ok = interceptEngine.forwardItem(id, override)
  if (!ok) return c.json({ error: "Pending intercept item not found" }, 404)
  return c.json({ ok: true, id })
}

export async function handleDropInterceptItem(c: Context) {
  const id = c.req.param("id") ?? ""
  const raw: unknown = await c.req.json().catch(() => undefined)
  const reason =
    (
      raw
      && typeof raw === "object"
      && "reason" in raw
      && typeof raw.reason === "string"
      && raw.reason.trim()
    ) ?
      raw.reason.trim()
    : undefined
  const ok = interceptEngine.dropItem(id, reason)
  if (!ok) return c.json({ error: "Pending intercept item not found" }, 404)
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
  const id = c.req.param("id") ?? ""
  const raw: unknown = await c.req.json().catch(() => undefined)
  const instruction =
    (
      raw
      && typeof raw === "object"
      && "instruction" in raw
      && typeof raw.instruction === "string"
    ) ?
      raw.instruction
    : undefined
  const model =
    (
      raw
      && typeof raw === "object"
      && "model" in raw
      && typeof raw.model === "string"
    ) ?
      raw.model
    : undefined

  const updated = await interceptEngine.triggerAssistant(id, {
    instruction,
    model,
  })
  if (!updated) {
    return c.json({ error: "Pending intercept item not found" }, 404)
  }
  return c.json(updated)
}

export async function handleApplyInterceptAssistant(c: Context) {
  const id = c.req.param("id") ?? ""
  const raw: unknown = await c.req.json().catch(() => undefined)
  let operations: Array<z.infer<typeof assistantOpSchema>> | undefined
  if (
    raw
    && typeof raw === "object"
    && "operations" in raw
    && Array.isArray(raw.operations)
  ) {
    const parsed = z.array(assistantOpSchema).safeParse(raw.operations)
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid operations" },
        400,
      )
    }
    operations = parsed.data
  }

  const updated = interceptEngine.applyAssistantDiff(id, operations)
  if (!updated) {
    return c.json({ error: "Pending intercept item not found" }, 404)
  }
  return c.json(updated)
}

export function handleRejectInterceptAssistant(c: Context) {
  const id = c.req.param("id") ?? ""
  const updated = interceptEngine.rejectAssistantSuggestion(id)
  if (!updated) {
    return c.json({ error: "Pending intercept item not found" }, 404)
  }
  return c.json(updated)
}

export function handleInterceptEvents(c: Context) {
  c.header("Cache-Control", "no-store")
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify(interceptEngine.getSnapshot()),
    })

    let closed = false
    const unsubscribe = interceptEngine.subscribe((event) => {
      if (closed) return
      void stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    })

    const heartbeat = setInterval(() => {
      if (closed) return
      void stream.writeSSE({ event: "ping", data: String(Date.now()) })
    }, 15_000)

    const { promise, resolve } = Promise.withResolvers<null>()
    stream.onAbort(() => {
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      resolve(null)
    })

    await promise
  })
}
