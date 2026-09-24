import { createHash } from "node:crypto"

import type { AnthropicToolUseBlock } from "~/routes/messages/anthropic-types"
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

type ToolKind = "function" | "custom" | "tool_search"
const COLLABORATION_MESSAGE_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
])

interface ToolIdentity {
  readonly kind: ToolKind
  readonly name: string
  readonly namespace?: string
}

interface MappedTool extends ToolIdentity {
  readonly wireName: string
  readonly definition?: Record<string, unknown>
}

interface ToolDeclaration extends ToolIdentity {
  definition?: Record<string, unknown>
}

interface ToolCollection {
  declarations: Map<string, ToolDeclaration>
  passthrough: Array<Record<string, unknown>>
}

interface NamespaceContext {
  readonly name: string
  readonly descriptions: ReadonlyArray<string>
}

export interface ResponsesMessagesToolMap {
  readonly source: ResponsesPayload
  readonly restoreToolCall: (
    block: AnthropicToolUseBlock,
  ) => ResponseOutputItem | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function identityKey(identity: ToolIdentity): string {
  return JSON.stringify([
    identity.kind,
    identity.namespace ?? "",
    identity.name,
  ])
}

function getIdentity(
  value: Record<string, unknown>,
  parentNamespace?: string,
): ToolIdentity | undefined {
  const type = value.type
  if (
    (type === "tool_search" || type === "tool_search_call")
    && value.execution === "client"
  ) {
    return { kind: "tool_search", name: "tool_search" }
  }
  let kind: ToolKind | undefined
  if (type === "function" || type === "function_call") kind = "function"
  if (type === "custom" || type === "custom_tool_call") kind = "custom"
  if (!kind || typeof value.name !== "string" || !value.name.trim()) {
    return undefined
  }
  const namespace =
    parentNamespace
    ?? (typeof value.namespace === "string" && value.namespace ?
      value.namespace
    : undefined)
  return { kind, name: value.name, ...(namespace ? { namespace } : {}) }
}

function collectDeclarations(
  tools: unknown,
  collection: ToolCollection,
  namespace?: NamespaceContext,
): void {
  if (!Array.isArray(tools)) return
  for (const raw of tools) {
    if (!isRecord(raw)) continue
    if (raw.type === "namespace" && typeof raw.name === "string") {
      collectDeclarations(raw.tools, collection, {
        name: namespace ? `${namespace.name}.${raw.name}` : raw.name,
        descriptions: [
          ...(namespace?.descriptions ?? []),
          ...(typeof raw.description === "string" && raw.description ?
            [raw.description]
          : []),
        ],
      })
      continue
    }
    const identity = getIdentity(raw, namespace?.name)
    if (identity) {
      collection.declarations.set(identityKey(identity), {
        ...identity,
        definition: withNamespaceDescription(raw, namespace),
      })
    } else {
      collection.passthrough.push(raw)
    }
  }
}

function withNamespaceDescription(
  definition: Record<string, unknown>,
  namespace: NamespaceContext | undefined,
): Record<string, unknown> {
  if (!namespace?.descriptions.length) return definition
  return {
    ...definition,
    description: [
      ...namespace.descriptions,
      ...(typeof definition.description === "string" && definition.description ?
        [definition.description]
      : []),
    ].join("\n\n"),
  }
}

function collectTools(source: ResponsesPayload): ToolCollection {
  const declarations = new Map<string, ToolDeclaration>()
  const passthrough: Array<Record<string, unknown>> = []
  const collection = { declarations, passthrough }
  if (Array.isArray(source.input)) {
    for (const raw of source.input) {
      if (!isRecord(raw)) continue
      if (
        raw.type === "additional_tools"
        || raw.type === "tool_search_output"
      ) {
        collectDeclarations(raw.tools, collection)
      }
      const identity = getIdentity(raw)
      if (identity && !declarations.has(identityKey(identity))) {
        declarations.set(identityKey(identity), identity)
      }
    }
  }
  // Current explicit definitions supersede earlier discovery snapshots.
  collectDeclarations(source.tools, collection)
  return collection
}

function isLegalToolName(value: string): boolean {
  return /^[\w-]{1,64}$/.test(value)
}

function allocateToolNames(
  declarations: Map<string, ToolDeclaration>,
): Map<string, MappedTool> {
  const entries = [...declarations.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )
  const rootFunctions = new Set(
    entries.flatMap(([, tool]) =>
      (
        !tool.namespace
        && tool.kind === "function"
        && isLegalToolName(tool.name)
      ) ?
        [tool.name]
      : [],
    ),
  )
  const reserved = new Set(rootFunctions)
  const result = new Map<string, MappedTool>()
  for (const [key, tool] of entries) {
    if (
      !tool.namespace
      && isLegalToolName(tool.name)
      && (tool.kind === "function" || !reserved.has(tool.name))
    ) {
      result.set(key, { ...tool, wireName: tool.name })
      reserved.add(tool.name)
    }
  }
  for (const [key, tool] of entries) {
    if (result.has(key)) continue
    const label = `${tool.namespace ?? "capi"}__${tool.name}`
      .replaceAll(/[^\w-]/g, "_")
      .slice(0, 43)
    let attempt = 0
    let name: string
    do {
      const hash = createHash("sha256")
        .update(`${key}:${attempt++}`)
        .digest("hex")
        .slice(0, 20)
      name = `${label}_${hash}`
    } while (reserved.has(name))
    reserved.add(name)
    result.set(key, { ...tool, wireName: name })
  }
  return result
}

function customToolDescription(definition: Record<string, unknown>): string {
  const instructions = [
    typeof definition.description === "string" ? definition.description : "",
    "Pass the raw tool input as the string value of the input property. Preserve its exact whitespace and formatting.",
  ]
  const format = definition.format
  if (isRecord(format) && format.type === "grammar") {
    if (typeof format.syntax === "string") {
      instructions.push(
        `The raw input must match this ${format.syntax} grammar:`,
      )
    }
    if (typeof format.definition === "string")
      instructions.push(format.definition)
  }
  return instructions.filter(Boolean).join("\n\n")
}

function mappedDefinition(
  tool: MappedTool,
): Record<string, unknown> | undefined {
  if (!tool.definition) return undefined
  const definition = {
    ...structuredClone(tool.definition),
    type: "function",
    name: tool.wireName,
  }
  const message = collaborationMessageSchema({ ...tool, definition })
  if (message?.encrypted === true) delete message.encrypted
  if (tool.kind === "custom") {
    return {
      ...definition,
      description: customToolDescription(tool.definition),
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    }
  }
  return definition
}

function collaborationMessageSchema(
  tool: MappedTool,
): Record<string, unknown> | undefined {
  if (
    tool.kind !== "function"
    || tool.namespace !== "collaboration"
    || !COLLABORATION_MESSAGE_TOOLS.has(tool.name)
  ) {
    return undefined
  }
  const parameters = tool.definition?.parameters
  if (!isRecord(parameters) || !isRecord(parameters.properties)) {
    return undefined
  }
  const message = parameters.properties.message
  return isRecord(message) && message.type === "string" ? message : undefined
}

function mapInputItem(
  item: ResponseInputItem,
  tools: ReadonlyMap<string, MappedTool>,
): Array<ResponseInputItem> {
  if (!isRecord(item)) return [item]
  if (item.type === "additional_tools") return []
  if (item.type === "custom_tool_call_output") {
    return [{ ...item, type: "function_call_output" }]
  }
  if (item.type === "tool_search_output" && item.execution === "client") {
    return [
      {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify({ tools: item.tools ?? [] }),
      },
    ]
  }
  const identity = getIdentity(item)
  const mapped = identity ? tools.get(identityKey(identity)) : undefined
  if (!mapped) return [item]
  const { namespace: _namespace, input, ...rest } = item
  if (mapped.kind === "custom") {
    return [
      {
        ...rest,
        type: "function_call",
        name: mapped.wireName,
        arguments: JSON.stringify({ input }),
      },
    ]
  }
  if (mapped.kind === "tool_search") {
    return [
      {
        ...rest,
        type: "function_call",
        name: mapped.wireName,
        arguments:
          isRecord(item.arguments) ?
            JSON.stringify(item.arguments)
          : item.arguments,
      },
    ]
  }
  return [{ ...item, name: mapped.wireName }]
}

function mapToolChoice(
  choice: ResponsesPayload["tool_choice"],
  tools: ReadonlyMap<string, MappedTool>,
): ResponsesPayload["tool_choice"] {
  if (!isRecord(choice)) return choice
  const identity = getIdentity(
    choice.type === "tool_search" ? { ...choice, execution: "client" } : choice,
  )
  const tool = identity ? tools.get(identityKey(identity)) : undefined
  return tool ? { type: "function", name: tool.wireName } : choice
}

function restoreToolCall(
  block: AnthropicToolUseBlock,
  tools: ReadonlyMap<string, MappedTool>,
): ResponseOutputItem | undefined {
  const tool = tools.get(block.name)
  const common = { call_id: block.id, status: "completed" as const }
  if (tool?.kind === "custom") {
    if (typeof block.input.input !== "string") return undefined
    return {
      ...common,
      id: `ctc_${block.id}`,
      type: "custom_tool_call",
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      input: block.input.input,
    }
  }
  if (tool?.kind === "tool_search") {
    return {
      ...common,
      id: `ts_${block.id}`,
      type: "tool_search_call",
      execution: "client",
      arguments: structuredClone(block.input),
    }
  }
  return {
    ...common,
    id: `fc_${block.id}`,
    type: "function_call",
    name: tool?.name ?? block.name,
    ...(tool?.namespace ? { namespace: tool.namespace } : {}),
    ...(tool && collaborationMessageSchema(tool)?.encrypted === true ?
      { encrypted_function_args: [] }
    : {}),
    arguments: JSON.stringify(block.input),
  }
}

/** Translate client tools into ordinary Messages tools without changing their identity. */
export function createResponsesMessagesToolMap(
  input: ResponsesPayload,
): ResponsesMessagesToolMap {
  const source = structuredClone(input)
  const { declarations, passthrough } = collectTools(source)
  const mapping = allocateToolNames(declarations)
  const byWireName = new Map(
    [...mapping.values()].map((tool) => [tool.wireName, tool]),
  )
  const definitions = [...mapping.values()].flatMap((tool) => {
    const definition = mappedDefinition(tool)
    return definition ? [definition] : []
  })
  if (definitions.length > 0 || passthrough.length > 0) {
    source.tools = [...definitions, ...passthrough]
  }
  if (Array.isArray(source.input)) {
    source.input = source.input.flatMap((item) => mapInputItem(item, mapping))
  }
  if (source.tool_choice !== undefined) {
    source.tool_choice = mapToolChoice(source.tool_choice, mapping)
  }
  return {
    source,
    restoreToolCall: (block) => restoreToolCall(block, byWireName),
  }
}
