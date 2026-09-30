import type { ForeignThinkingState } from "~/lib/model-fallback-thinking"
import type { SqlSession, Storage } from "~/lib/storage/types"

import { mergeForeignThinking } from "~/lib/model-fallback-thinking"
import { StorageSchemaError } from "~/lib/storage/errors"

export interface ConversationModelRoute {
  source: string
  target: string
  resolved: string
}

export interface ConversationModelBinding {
  configRevision: number
  redirectRevision: number
  signature: string
}

export interface StoredConversationModel {
  sourceModel: string
  targetModel: string
  identitySignature: string
  route: Array<ConversationModelRoute>
  foreignThinking: ForeignThinkingState
  requestSequence: number
}

interface RememberedConversationModel extends StoredConversationModel {
  conversationKey: string
  binding: ConversationModelBinding
}

const digestPattern = /^[a-f\d]{64}$/
const modelPattern = /^[\x21-\x7E]{1,256}$/

function invalid(): never {
  throw new StorageSchemaError("Invalid stored conversation model")
}

function counter(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  )
    invalid()
  return value
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) invalid()
  return value
}

function model(value: unknown): string {
  if (typeof value !== "string" || !modelPattern.test(value)) invalid()
  return value
}

function bindingSnapshot(
  value: ConversationModelBinding,
): ConversationModelBinding {
  return {
    configRevision: counter(value.configRevision),
    redirectRevision: counter(value.redirectRevision),
    signature: digest(value.signature),
  }
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") invalid()
  try {
    return JSON.parse(value) as unknown
  } catch {
    return invalid()
  }
}

function decodeRoute(
  value: unknown,
  source: string,
  target: string,
): Array<ConversationModelRoute> {
  if (!Array.isArray(value) || value.length === 0) invalid()
  const route: Array<ConversationModelRoute> = []
  const visited = new Set([source])
  let current = source
  for (const item of value as Array<unknown>) {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "resolved,source,target"
      || !("source" in item)
      || !("target" in item)
      || !("resolved" in item)
    )
      invalid()
    const hop = {
      source: model(item.source),
      target: model(item.target),
      resolved: model(item.resolved),
    }
    if (hop.source !== current || visited.has(hop.resolved)) invalid()
    visited.add(hop.resolved)
    current = hop.resolved
    route.push(hop)
  }
  if (current !== target) invalid()
  return route
}

/** Used for database reads and the authenticated restore boundary. */
export function decodeStoredConversationModel(
  row: Record<string, unknown>,
): StoredConversationModel {
  const sourceModel = model(row.source_model)
  const targetModel = model(row.target_model)
  const fingerprints = decodeJson(row.fingerprints_json)
  if (
    !Array.isArray(fingerprints)
    || fingerprints.length > 4096
    || fingerprints.some(
      (value: unknown) =>
        typeof value !== "string" || !digestPattern.test(value),
    )
    || new Set(fingerprints).size !== fingerprints.length
    || (row.foreign_complete !== 0 && row.foreign_complete !== 1)
  )
    invalid()
  bindingSnapshot({
    configRevision: row.config_revision as number,
    redirectRevision: row.redirect_revision as number,
    signature: row.binding_signature as string,
  })
  return {
    sourceModel,
    targetModel,
    identitySignature: digest(row.identity_signature),
    route: decodeRoute(decodeJson(row.route_json), sourceModel, targetModel),
    foreignThinking: {
      fingerprints: new Set(fingerprints as Array<string>),
      complete: row.foreign_complete === 1,
    },
    requestSequence: counter(row.request_sequence, 1),
  }
}

async function currentBinding(
  session: SqlSession,
  binding: ConversationModelBinding,
): Promise<boolean> {
  const rows = await session.query({
    sql: "SELECT namespace,revision FROM capi_settings WHERE namespace IN ('model_fallbacks','model_redirects')",
    args: [],
  })
  const revisions = new Map(
    rows.map((row) => [row.namespace, counter(row.revision)]),
  )
  return (
    (revisions.get("model_fallbacks") ?? 0) === binding.configRevision
    && (revisions.get("model_redirects") ?? 0) === binding.redirectRevision
  )
}

async function remember(
  session: SqlSession,
  input: RememberedConversationModel,
  key: Uint8Array,
): Promise<void> {
  if (!(await currentBinding(session, input.binding))) return
  const tickets = await session.query({
    sql: "SELECT request_sequence FROM capi_conversation_model_requests WHERE conversation_key=?",
    args: [key],
  })
  if (
    !tickets[0]
    || input.requestSequence > counter(tickets[0].request_sequence, 1)
  )
    invalid()
  const rows = await session.query({
    sql: "SELECT * FROM capi_conversation_models WHERE conversation_key=? AND source_model=?",
    args: [key, input.sourceModel],
  })
  const row = rows.at(0)
  const previous = row ? decodeStoredConversationModel(row) : undefined
  const previousSequence = previous?.requestSequence ?? 0
  const matchingPrevious =
    (
      previous?.targetModel === input.targetModel
      && previous.identitySignature === input.identitySignature
      && JSON.stringify(previous.route) === JSON.stringify(input.route)
    ) ?
      previous
    : undefined
  if (previousSequence > input.requestSequence && !matchingPrevious) return
  const foreign =
    matchingPrevious ?
      mergeForeignThinking(
        matchingPrevious.foreignThinking,
        input.foreignThinking,
      )
    : input.foreignThinking
  const route =
    (
      matchingPrevious
      && matchingPrevious.requestSequence > input.requestSequence
    ) ?
      matchingPrevious.route
    : input.route
  await session.execute({
    sql: "INSERT INTO capi_conversation_models(conversation_key,source_model,target_model,identity_signature,route_json,fingerprints_json,foreign_complete,request_sequence,config_revision,redirect_revision,binding_signature) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_key,source_model) DO UPDATE SET target_model=excluded.target_model,identity_signature=excluded.identity_signature,route_json=excluded.route_json,fingerprints_json=excluded.fingerprints_json,foreign_complete=excluded.foreign_complete,request_sequence=excluded.request_sequence,config_revision=excluded.config_revision,redirect_revision=excluded.redirect_revision,binding_signature=excluded.binding_signature",
    args: [
      key,
      input.sourceModel,
      input.targetModel,
      input.identitySignature,
      JSON.stringify(route),
      JSON.stringify([...foreign.fingerprints].sort()),
      Number(foreign.complete),
      Math.max(previousSequence, input.requestSequence),
      input.binding.configRevision,
      input.binding.redirectRevision,
      input.binding.signature,
    ],
  })
}

export function createConversationModelsRepository(storage: Storage) {
  return {
    async begin(
      conversationKey: string,
      binding: ConversationModelBinding,
    ): Promise<{
      requestSequence: number
      routes: ReadonlyMap<string, StoredConversationModel>
    }> {
      const key = Buffer.from(digest(conversationKey), "hex")
      const captured = bindingSnapshot(binding)
      return storage.transaction(async (session) => {
        const rows = await session.query({
          sql: "SELECT request_sequence FROM capi_conversation_model_requests WHERE conversation_key=?",
          args: [key],
        })
        const requestSequence = counter(
          (rows[0] ? counter(rows[0].request_sequence, 1) : 0) + 1,
          1,
        )
        await session.execute({
          sql: "INSERT INTO capi_conversation_model_requests(conversation_key,request_sequence) VALUES(?,?) ON CONFLICT(conversation_key) DO UPDATE SET request_sequence=excluded.request_sequence",
          args: [key, requestSequence],
        })
        const routes = new Map<string, StoredConversationModel>()
        if (await currentBinding(session, captured)) {
          const stored = await session.query({
            // Configuration edits do not expire durable destinations. The caller
            // revalidates each candidate against its current rules and redirects.
            sql: "SELECT * FROM capi_conversation_models WHERE conversation_key=?",
            args: [key],
          })
          for (const row of stored) {
            const entry = decodeStoredConversationModel(row)
            if (entry.foreignThinking.complete)
              routes.set(entry.sourceModel, entry)
          }
        }
        return { requestSequence, routes }
      })
    },
    async remember(input: RememberedConversationModel): Promise<void> {
      const key = Buffer.from(digest(input.conversationKey), "hex")
      const binding = bindingSnapshot(input.binding)
      const owned = decodeStoredConversationModel({
        source_model: input.sourceModel,
        target_model: input.targetModel,
        identity_signature: input.identitySignature,
        route_json: JSON.stringify(input.route),
        fingerprints_json: JSON.stringify([
          ...input.foreignThinking.fingerprints,
        ]),
        foreign_complete: Number(input.foreignThinking.complete),
        request_sequence: input.requestSequence,
        config_revision: binding.configRevision,
        redirect_revision: binding.redirectRevision,
        binding_signature: binding.signature,
      })
      await storage.transaction((session) =>
        remember(
          session,
          { ...owned, conversationKey: input.conversationKey, binding },
          key,
        ),
      )
    },
  }
}

export async function validateConversationModelsState(
  session: SqlSession,
): Promise<void> {
  const rows = await session.query({
    sql: "SELECT m.*,r.request_sequence AS latest_sequence FROM capi_conversation_models m LEFT JOIN capi_conversation_model_requests r USING(conversation_key)",
    args: [],
  })
  for (const row of rows) {
    const model = decodeStoredConversationModel(row)
    if (model.requestSequence > counter(row.latest_sequence, 1)) invalid()
  }
}
