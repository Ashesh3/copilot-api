/**
 * Factory's Droid runs its WebSearch and FetchUrl tools through Factory's own
 * API. For Droid, the gateway answers those calls itself and returns them in a
 * carrier: an opaque reasoning item (Responses) or thinking block (Messages)
 * that Droid stores and replays verbatim. Each request expands carriers back
 * into the exact tool calls and results the model saw, so the model keeps its
 * evidence and its reasoning stays valid on every later turn.
 */

export const DROID_WEB_CARRIER_PREFIX = "capi_droid_web_v1:"
/** Droid does not store thinking blocks without text, so carriers carry this. */
export const DROID_WEB_CARRIER_LABEL = "Web tool results kept by copilot-api."

export type DroidWebToolKind = "fetch" | "search"

export interface DroidWebCarrier {
  /** The calls the model made, in order, with their raw arguments. */
  calls: Array<{ id: string; name: string; input: unknown }>
  /** The result the model received for each call. */
  results: Array<{ id: string; text: string; isError: boolean }>
  /** The visible narration that Droid shows, and replays, before the carrier. */
  narration: string
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function schemaOf(tool: JsonRecord): unknown {
  if (tool.type === "function") return tool.parameters
  return tool.type === undefined || tool.type === "custom" ?
      tool.input_schema
    : undefined
}

const SEARCH_FIELDS = new Set(["query", "numResults", "text", "knowledge"])
const OBJECTIVE_FIELDS = new Set(["objective", "searchQueries", "numResults"])

/** Droid's WebSearch or FetchUrl declaration, recognized by name and schema. */
export function droidWebToolKind(tool: unknown): DroidWebToolKind | undefined {
  if (!isRecord(tool)) return undefined
  const schema = schemaOf(tool)
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined
  const fields = Object.keys(schema.properties)
  const required: Array<unknown> =
    Array.isArray(schema.required) ? schema.required : []
  if (tool.name === "FetchUrl")
    return (
        fields.length === 1 && fields[0] === "url" && required.includes("url")
      ) ?
        "fetch"
      : undefined
  if (tool.name !== "WebSearch" || fields.length === 0) return undefined
  if (
    fields.every((field) => SEARCH_FIELDS.has(field))
    && required.includes("query")
  )
    return "search"
  return (
      fields.every((field) => OBJECTIVE_FIELDS.has(field))
        && required.includes("objective")
    ) ?
      "search"
    : undefined
}

export function encodeDroidWebCarrier(carrier: DroidWebCarrier): string {
  const json = JSON.stringify(carrier)
  return `${DROID_WEB_CARRIER_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`
}

function carrierCall(value: unknown): DroidWebCarrier["calls"][number] | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || !value.id
    || typeof value.name !== "string"
    || !value.name
  )
    return null
  return { id: value.id, name: value.name, input: value.input }
}

function carrierResult(
  value: unknown,
): DroidWebCarrier["results"][number] | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.text !== "string"
    || typeof value.isError !== "boolean"
  )
    return null
  return { id: value.id, text: value.text, isError: value.isError }
}

/** A carrier this gateway issued, or undefined for anything else. */
export function decodeDroidWebCarrier(
  value: unknown,
): DroidWebCarrier | undefined {
  if (typeof value !== "string" || !value.startsWith(DROID_WEB_CARRIER_PREFIX))
    return undefined
  let parsed: unknown
  try {
    const encoded = value.slice(DROID_WEB_CARRIER_PREFIX.length)
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed)
    || typeof parsed.narration !== "string"
    || !Array.isArray(parsed.calls)
    || !Array.isArray(parsed.results)
  )
    return undefined
  const calls = parsed.calls.map((call) => carrierCall(call))
  const results = parsed.results.map((result) => carrierResult(result))
  const ids = new Set(calls.map((call) => call?.id))
  // Every call needs exactly one result, or the expanded history is invalid.
  if (
    calls.length === 0
    || ids.size !== calls.length
    || results.length !== calls.length
    || calls.includes(null)
    || results.some((result) => result === null || !ids.delete(result.id))
  )
    return undefined
  return {
    calls: calls.filter((call) => call !== null),
    results: results.filter((result) => result !== null),
    narration: parsed.narration,
  }
}

export function droidNarrationMessage(id: string, text: string): JsonRecord {
  return {
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

export function droidCarrierReasoning(
  id: string,
  carrier: DroidWebCarrier,
): JsonRecord {
  return {
    type: "reasoning",
    id,
    summary: [],
    encrypted_content: encodeDroidWebCarrier(carrier),
  }
}

export function droidCarrierThinking(carrier: DroidWebCarrier): JsonRecord {
  return {
    type: "thinking",
    thinking: DROID_WEB_CARRIER_LABEL,
    signature: encodeDroidWebCarrier(carrier),
  }
}

function isResponsesCarrier(item: unknown): item is JsonRecord {
  return (
    isRecord(item)
    && item.type === "reasoning"
    && typeof item.encrypted_content === "string"
    && item.encrypted_content.startsWith(DROID_WEB_CARRIER_PREFIX)
  )
}

const RESPONSES_CALL_TYPES = new Set([
  "apply_patch_call",
  "computer_call",
  "custom_tool_call",
  "function_call",
  "local_shell_call",
  "mcp_call",
  "shell_call",
  "tool_search_call",
])

/** Droid joins adjacent text, so the narration ends the preceding message. */
function withoutResponsesNarration(
  items: Array<unknown>,
  narration: string,
): void {
  const last = items.at(-1)
  if (!narration || !isRecord(last) || last.role !== "assistant") return
  if (typeof last.content === "string") {
    if (!last.content.endsWith(narration)) return
    const rest = last.content.slice(0, -narration.length)
    if (rest) items.splice(-1, 1, { ...last, content: rest })
    else items.pop()
    return
  }
  const parts: Array<unknown> = Array.isArray(last.content) ? last.content : []
  const part = parts.at(-1)
  if (
    !isRecord(part)
    || typeof part.text !== "string"
    || !part.text.endsWith(narration)
  )
    return
  const rest = part.text.slice(0, -narration.length)
  const content =
    rest ? [...parts.slice(0, -1), { ...part, text: rest }] : parts.slice(0, -1)
  if (content.length > 0) items.splice(-1, 1, { ...last, content })
  else items.pop()
}

/** Restore the hidden calls and results each Responses carrier holds. */
export function expandDroidResponsesCarriers<T>(input: T): T {
  if (!Array.isArray(input) || !input.some((item) => isResponsesCarrier(item)))
    return input
  const expanded: Array<unknown> = []
  let outputs: Array<JsonRecord> = []
  for (const item of input as Array<unknown>) {
    // Droid stores client calls after its text and reasoning. Results of a
    // carrier follow the calls Droid moved there, as they did upstream.
    if (
      outputs.length > 0
      && (!isRecord(item) || !RESPONSES_CALL_TYPES.has(String(item.type)))
    ) {
      expanded.push(...outputs)
      outputs = []
    }
    if (!isResponsesCarrier(item)) {
      expanded.push(item)
      continue
    }
    const carrier = decodeDroidWebCarrier(item.encrypted_content)
    if (!carrier) continue
    withoutResponsesNarration(expanded, carrier.narration)
    for (const call of carrier.calls)
      expanded.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments:
          typeof call.input === "string" ?
            call.input
          : JSON.stringify(call.input ?? {}),
      })
    outputs = carrier.results.map((result) => ({
      type: "function_call_output",
      call_id: result.id,
      output: result.text,
    }))
  }
  expanded.push(...outputs)
  return expanded as T
}

function isMessagesCarrier(block: unknown): block is JsonRecord {
  return (
    isRecord(block)
    && block.type === "thinking"
    && typeof block.signature === "string"
    && block.signature.startsWith(DROID_WEB_CARRIER_PREFIX)
  )
}

function hasMessagesCarrier(message: unknown): message is JsonRecord {
  return (
    isRecord(message)
    && message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block: unknown) => isMessagesCarrier(block))
  )
}

function carrierToolUses(
  carrier: DroidWebCarrier,
  cacheControl: unknown,
): Array<JsonRecord> {
  return carrier.calls.map((call, index) => ({
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: isRecord(call.input) ? call.input : {},
    ...(cacheControl && index === carrier.calls.length - 1 ?
      { cache_control: cacheControl }
    : {}),
  }))
}

function carrierToolResults(carrier: DroidWebCarrier): Array<JsonRecord> {
  return carrier.results.map((result) => ({
    type: "tool_result",
    tool_use_id: result.id,
    content: result.text,
    ...(result.isError ? { is_error: true } : {}),
  }))
}

/**
 * Push one assistant message as the turns the model actually took. Returns
 * hidden results that belong at the start of the next user message.
 */
function expandAssistantCarriers(
  message: JsonRecord,
  expanded: Array<unknown>,
): Array<JsonRecord> {
  const blocks = message.content as Array<unknown>
  let segment: Array<unknown> = []
  for (const [index, block] of blocks.entries()) {
    if (!isMessagesCarrier(block)) {
      segment.push(block)
      continue
    }
    // An unreadable carrier holds nothing the model can use; drop it.
    const carrier = decodeDroidWebCarrier(block.signature)
    if (!carrier) continue
    const narration = segment.at(-1)
    if (
      isRecord(narration)
      && narration.type === "text"
      && narration.text === carrier.narration
    )
      segment.pop()
    segment.push(...carrierToolUses(carrier, block.cache_control))
    // Droid stores client tool_use blocks last. A carrier followed only by
    // those shares their turn, so its results join the next user message.
    const rest = blocks.slice(index + 1)
    if (rest.every((item) => isRecord(item) && item.type === "tool_use")) {
      expanded.push({ ...message, content: [...segment, ...rest] })
      return carrierToolResults(carrier)
    }
    expanded.push(
      { ...message, content: segment },
      { role: "user", content: carrierToolResults(carrier) },
    )
    segment = []
  }
  if (segment.length > 0) expanded.push({ ...message, content: segment })
  return []
}

function userBlocks(content: unknown): Array<unknown> {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : []
  return Array.isArray(content) ? content : []
}

/** Restore the hidden tool turns each Messages carrier holds. */
export function expandDroidMessagesCarriers<T extends Array<unknown>>(
  messages: T,
): T {
  if (!messages.some((message) => hasMessagesCarrier(message))) return messages
  const expanded: Array<unknown> = []
  let carried: Array<JsonRecord> = []
  for (const message of messages) {
    if (carried.length > 0) {
      if (isRecord(message) && message.role === "user") {
        expanded.push({
          ...message,
          content: [...carried, ...userBlocks(message.content)],
        })
        carried = []
        continue
      }
      expanded.push({ role: "user", content: carried })
      carried = []
    }
    if (hasMessagesCarrier(message))
      carried = expandAssistantCarriers(message, expanded)
    else expanded.push(message)
  }
  if (carried.length > 0) expanded.push({ role: "user", content: carried })
  return expanded as T
}
