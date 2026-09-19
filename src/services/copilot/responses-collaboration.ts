import type { ServerSentEventMessage } from "fetch-event-stream"

const COLLABORATION_NAMESPACE = "collaboration"
const PLAINTEXT_NAMESPACE = "copilot_collaboration"
const MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"])

export interface ResponsesCollaboration {
  namespace: string
  plaintextTools: ReadonlySet<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function inputRecords(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(body.input) ?
      body.input.filter((item) => isRecord(item))
    : []
}

function namespaceTools(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const groups: Array<unknown> = [body.tools]
  for (const item of inputRecords(body)) {
    if (item.type === "additional_tools") groups.push(item.tools)
  }
  return groups.flatMap((group) =>
    Array.isArray(group) ?
      group.filter(
        (tool): tool is Record<string, unknown> =>
          isRecord(tool)
          && tool.type === "namespace"
          && Array.isArray(tool.tools),
      )
    : [],
  )
}

function messageSchema(tool: unknown): Record<string, unknown> | undefined {
  if (
    !isRecord(tool)
    || tool.type !== "function"
    || typeof tool.name !== "string"
    || !MESSAGE_TOOLS.has(tool.name)
    || !isRecord(tool.parameters)
    || !isRecord(tool.parameters.properties)
  )
    return undefined
  const message = tool.parameters.properties.message
  return isRecord(message) && message.type === "string" ? message : undefined
}

function mapToolChoice(value: unknown, from: string, to: string): void {
  if (!isRecord(value)) return
  if (value.type === "function" && value.namespace === from)
    value.namespace = to
  if (value.type === "allowed_tools" && Array.isArray(value.tools)) {
    for (const tool of value.tools) mapToolChoice(tool, from, to)
  }
}

function availableNamespace(
  namespaces: Array<Record<string, unknown>>,
  input: Array<Record<string, unknown>>,
): string {
  const occupied = new Set(namespaces.map((tool) => tool.name))
  for (const item of input) {
    if (typeof item.namespace === "string") occupied.add(item.namespace)
  }
  let namespace: string = PLAINTEXT_NAMESPACE
  for (let suffix = 2; occupied.has(namespace); suffix += 1) {
    namespace = `${PLAINTEXT_NAMESPACE}_${suffix}`
  }
  return namespace
}

/** Mutates only the owned Copilot wire clone, never caller history. */
export function prepareResponsesCollaboration(
  body: Record<string, unknown>,
): ResponsesCollaboration | undefined {
  const namespaces = namespaceTools(body)
  const collaboration = namespaces.filter(
    (tool) => tool.name === COLLABORATION_NAMESPACE,
  )
  const plaintextTools = new Set<string>()
  for (const namespace of collaboration) {
    for (const tool of namespace.tools as Array<unknown>) {
      if (isRecord(tool) && messageSchema(tool)?.encrypted === true) {
        plaintextTools.add(tool.name as string)
      }
    }
  }
  if (plaintextTools.size === 0) return undefined

  const namespace = availableNamespace(namespaces, inputRecords(body))

  // Copilot reserves the original collaboration schema, including encrypted:true.
  // Use an ordinary namespace upstream and restore Codex's namespace downstream.
  for (const toolNamespace of collaboration) {
    toolNamespace.name = namespace
    for (const tool of toolNamespace.tools as Array<unknown>) {
      const message = messageSchema(tool)
      if (message?.encrypted === true) delete message.encrypted
    }
  }
  for (const item of inputRecords(body)) {
    if (
      item.type === "function_call"
      && item.namespace === COLLABORATION_NAMESPACE
    ) {
      item.namespace = namespace
    }
  }
  mapToolChoice(body.tool_choice, COLLABORATION_NAMESPACE, namespace)
  return { namespace, plaintextTools }
}

function restoreFunctionCall(
  value: unknown,
  context: ResponsesCollaboration,
): void {
  if (
    !isRecord(value)
    || value.type !== "function_call"
    || value.namespace !== context.namespace
  )
    return
  value.namespace = COLLABORATION_NAMESPACE
  if (
    typeof value.name === "string"
    && context.plaintextTools.has(value.name)
    && (value.encrypted_function_args === undefined
      || value.encrypted_function_args === null)
  ) {
    // Codex otherwise treats even a readable message as opaque ciphertext.
    value.encrypted_function_args = []
  }
}

export function restoreResponsesCollaboration(
  value: unknown,
  context: ResponsesCollaboration | undefined,
): void {
  if (!context || !isRecord(value)) return
  if (Array.isArray(value.output)) {
    for (const item of value.output) restoreFunctionCall(item, context)
  }
  if (Array.isArray(value.tools)) {
    for (const namespace of value.tools) {
      if (
        !isRecord(namespace)
        || namespace.type !== "namespace"
        || namespace.name !== context.namespace
      )
        continue
      namespace.name = COLLABORATION_NAMESPACE
      if (!Array.isArray(namespace.tools)) continue
      for (const tool of namespace.tools) {
        if (!isRecord(tool) || !context.plaintextTools.has(String(tool.name)))
          continue
        const message = messageSchema(tool)
        if (message) message.encrypted = true
      }
    }
  }
  mapToolChoice(value.tool_choice, context.namespace, COLLABORATION_NAMESPACE)
}

export function restoreResponsesCollaborationEvent(
  event: ServerSentEventMessage,
  context: ResponsesCollaboration | undefined,
): ServerSentEventMessage {
  if (!context || !event.data) return event
  let value: unknown
  try {
    value = JSON.parse(event.data) as unknown
  } catch {
    return event
  }
  if (!isRecord(value)) return event
  const type = value.type ?? event.event
  if (
    type === "response.output_item.added"
    || type === "response.output_item.done"
  ) {
    restoreFunctionCall(value.item, context)
  } else if (typeof type === "string" && type.startsWith("response.")) {
    restoreResponsesCollaboration(value.response, context)
  } else {
    return event
  }
  return { ...event, data: JSON.stringify(value) }
}
