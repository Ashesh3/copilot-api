import { modelOmitsReasoningEffort } from "~/lib/model-settings"
import { reportNonDefaultBehavior } from "~/lib/request-logger"

/** The upstream request dialects that carry a reasoning effort. */
type ReasoningEffortDialect = "chat" | "messages" | "responses"

const EFFORT_FIELDS: Record<ReasoningEffortDialect, string> = {
  chat: "reasoning_effort",
  messages: "output_config.effort",
  responses: "reasoning.effort",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Deletes `record[key]` and returns the value it held, if any. */
function takeField(record: unknown, key: string): unknown {
  if (!isRecord(record) || !Object.hasOwn(record, key)) return undefined
  const value = record[key]
  Reflect.deleteProperty(record, key)
  return value
}

/** Deletes `body[wrapper].effort`, then the wrapper once nothing is left. */
function takeWrappedEffort(
  body: Record<string, unknown>,
  wrapper: string,
): unknown {
  const container = body[wrapper]
  const effort = takeField(container, "effort")
  if (isRecord(container) && Object.keys(container).length === 0) {
    Reflect.deleteProperty(body, wrapper)
  }
  return effort
}

function takeMessagesEffort(body: Record<string, unknown>): unknown {
  // Serialization folds per-turn controls into output_config, so their effort
  // must go as well. Their emptied containers stay, which still lets the
  // Messages contract drop control-only carrier messages.
  let messageEffort: unknown
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message)) continue
      messageEffort =
        takeField(message.output_config, "effort") ?? messageEffort
    }
  }
  return takeWrappedEffort(body, "output_config") ?? messageEffort
}

const TAKE_EFFORT: Record<
  ReasoningEffortDialect,
  (body: Record<string, unknown>) => unknown
> = {
  chat: (body) => takeField(body, "reasoning_effort"),
  messages: takeMessagesEffort,
  responses: (body) => takeWrappedEffort(body, "reasoning"),
}

/**
 * Removes the reasoning effort from an upstream request body when Model
 * Settings mark one of `models` as Omit, so the model applies its own
 * default. Other reasoning controls, such as Messages `thinking` or a
 * Responses `reasoning.summary`, are kept.
 */
export function omitConfiguredReasoningEffort(
  dialect: ReasoningEffortDialect,
  body: Record<string, unknown>,
  models: ReadonlyArray<unknown> = [body.model],
): boolean {
  const model = models.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && modelOmitsReasoningEffort(candidate),
  )
  if (model === undefined) return false

  const effort = TAKE_EFFORT[dialect](body)
  if (effort === undefined || effort === null) return false

  const field = EFFORT_FIELDS[dialect]
  const removed =
    typeof effort === "string" || typeof effort === "number" ?
      effort
    : JSON.stringify(effort)
  reportNonDefaultBehavior({
    kind: "reasoning_effort_omitted",
    message: `Model Settings omit reasoning effort for ${model}; removed ${field}=${removed}`,
    data: { model, field, removedEffort: removed },
  })
  return true
}
