const ROOT_COMPOSITIONS = ["oneOf", "anyOf", "allOf"] as const
const ROOT_RESOURCE_FIELDS = new Set([
  "$schema",
  "$id",
  "id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$vocabulary",
  "$defs",
  "definitions",
])
const SCHEMA_MAP_FIELDS = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
])
const SCHEMA_ARRAY_FIELDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])
const SCHEMA_FIELDS = new Set([
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
  "items",
  "extends",
])
const REFERENCE_FIELDS = ["$ref", "$dynamicRef", "$recursiveRef"] as const
const SCHEMA_BASE = "https://copilot-api.invalid/tool-schema"
const ROOT_DEFINITION = "__copilot_api_tool_input"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveUri(reference: string, base: string): string | undefined {
  try {
    return new URL(reference, base).href
  } catch {
    return undefined
  }
}

function schemaDialect(
  schema: Record<string, unknown>,
  parent: string,
): string {
  return typeof schema.$schema === "string" ? schema.$schema : parent
}

function schemaBase(
  schema: Record<string, unknown>,
  parent: string,
  dialect: string,
): string {
  const legacyId = /^https?:\/\/json-schema\.org\/draft-04\/schema#?$/.test(
    dialect,
  )
  const id = legacyId ? schema.id : schema.$id
  return typeof id === "string" ? (resolveUri(id, parent) ?? parent) : parent
}

function rebaseReference(options: {
  reference: string
  base: string
  rootBase: string
  target: string
}): string {
  const { reference, base, rootBase, target } = options
  const hash = reference.indexOf("#")
  if (hash === -1) return reference
  let pointer: string
  try {
    pointer = decodeURIComponent(reference.slice(hash + 1))
  } catch {
    return reference
  }
  // Empty fragments and anchors still identify the unchanged root resource.
  if (!pointer.startsWith("/")) return reference
  const field = pointer
    .split("/")[1]
    .replaceAll("~1", "/")
    .replaceAll("~0", "~")
  if (ROOT_RESOURCE_FIELDS.has(field)) return reference
  const resolved = resolveUri(reference, base)
  if (!resolved || resolved.split("#")[0] !== rootBase.split("#")[0])
    return reference
  return `${reference.slice(0, hash)}${target}${reference.slice(hash + 1)}`
}

function childSchemas(
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const children: Array<Record<string, unknown>> = []
  for (const [field, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_FIELDS.has(field) && isRecord(value)) {
      children.push(...Object.values(value).filter((child) => isRecord(child)))
    } else if (
      (SCHEMA_ARRAY_FIELDS.has(field)
        || field === "items"
        || field === "extends")
      && Array.isArray(value)
    ) {
      children.push(...value.filter((child) => isRecord(child)))
    } else if (SCHEMA_FIELDS.has(field) && isRecord(value)) {
      children.push(value)
    }
  }
  return children
}

function rebaseMovedSchemaReferences(
  schema: Record<string, unknown>,
  target: string,
): void {
  const rootDialect = schemaDialect(schema, "")
  const rootBase = schemaBase(schema, SCHEMA_BASE, rootDialect)
  const pending = [{ schema, base: SCHEMA_BASE, dialect: rootDialect }]
  while (pending.length > 0) {
    const entry = pending.pop()
    if (!entry) continue
    const dialect = schemaDialect(entry.schema, entry.dialect)
    const base = schemaBase(entry.schema, entry.base, dialect)
    for (const field of REFERENCE_FIELDS) {
      const reference = entry.schema[field]
      if (typeof reference !== "string") continue
      entry.schema[field] = rebaseReference({
        reference,
        base,
        rootBase,
        target,
      })
    }
    for (const child of childSchemas(entry.schema))
      pending.push({ schema: child, base, dialect })
  }
}

/** Keep the original schema semantics while avoiding Anthropic's root union restriction. */
function normalizeToolSchema(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const schema = structuredClone(source)
  const definitionField =
    (
      typeof schema.$schema === "string"
      && /^https?:\/\/json-schema\.org\/draft-0[467]\/schema#?$/.test(
        schema.$schema,
      )
    ) ?
      "definitions"
    : "$defs"
  const existing = schema[definitionField]
  const definitions = isRecord(existing) ? existing : {}
  let name = ROOT_DEFINITION
  for (let suffix = 2; Object.hasOwn(definitions, name); suffix += 1) {
    name = `${ROOT_DEFINITION}_${suffix}`
  }
  const reference = `#/${definitionField}/${name}`
  rebaseMovedSchemaReferences(schema, reference)
  const validation = Object.fromEntries(
    Object.entries(schema).filter(
      ([field]) => !ROOT_RESOURCE_FIELDS.has(field),
    ),
  )
  const resources = Object.fromEntries(
    Object.entries(schema).filter(([field]) => ROOT_RESOURCE_FIELDS.has(field)),
  )
  return {
    ...resources,
    type: "object",
    $ref: reference,
    [definitionField]: { ...definitions, [name]: validation },
  }
}

/** Operates only on the owned Messages wire clone, never opaque tool inputs or examples. */
export function normalizeAnthropicToolSchemas(
  body: Record<string, unknown>,
): void {
  if (!Array.isArray(body.tools)) return
  for (const tool of body.tools) {
    if (!isRecord(tool) || !isRecord(tool.input_schema)) continue
    const inputSchema = tool.input_schema
    if (!ROOT_COMPOSITIONS.some((field) => Object.hasOwn(inputSchema, field)))
      continue
    tool.input_schema = normalizeToolSchema(inputSchema)
  }
}
