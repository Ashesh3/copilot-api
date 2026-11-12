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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isArrayType(type: unknown): boolean {
  return (
    type === "array"
    || (Array.isArray(type)
      && type.includes("array")
      && type.every((member) => member === "array" || member === "null"))
  )
}

function matchesScalarType(
  value: unknown,
  type: unknown,
): value is boolean | number | string {
  switch (type) {
    case "string": {
      return typeof value === "string"
    }
    case "boolean": {
      return typeof value === "boolean"
    }
    case "integer": {
      return typeof value === "number" && Number.isInteger(value)
    }
    case "number": {
      return typeof value === "number" && Number.isFinite(value)
    }
    default: {
      return false
    }
  }
}

function hasReference(schema: Record<string, unknown>): boolean {
  return REFERENCE_FIELDS.some((field) => Object.hasOwn(schema, field))
}

function repairArrayItemEnum(schema: Record<string, unknown>): void {
  const items = schema.items
  const values = schema.enum
  if (!isArrayType(schema.type) || !isRecord(items)) return
  if (!Array.isArray(values) || values.length === 0) return
  if (
    Object.hasOwn(schema, "prefixItems")
    || Object.hasOwn(items, "enum")
    || hasReference(schema)
    || hasReference(items)
  )
    return
  if (!values.every((value) => matchesScalarType(value, items.type))) return

  // Scalar choices cannot describe an array value. Some generated MCP schemas
  // put item choices here, causing Gemini to reject the whole tool catalog.
  // Repair only this unambiguous placement error, retaining the item constraints.
  schema.items = { ...items, enum: [...values] }
  delete schema.enum
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

function collectSchemas(
  root: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const schemas: Array<Record<string, unknown>> = []
  const pending = [root]
  const visited = new WeakSet<Record<string, unknown>>()
  while (pending.length > 0) {
    const schema = pending.pop()
    if (!schema || visited.has(schema)) continue
    visited.add(schema)
    schemas.push(schema)
    pending.push(...childSchemas(schema))
  }
  return schemas
}

/** Repairs generated item enums only on the owned Gemini Chat wire clone. */
export function normalizeGeminiToolSchemas(
  body: Record<string, unknown>,
): void {
  if (
    typeof body.model !== "string"
    || !body.model.toLowerCase().startsWith("gemini-")
    || !Array.isArray(body.tools)
  )
    return

  for (const tool of body.tools) {
    if (
      !isRecord(tool)
      || tool.type !== "function"
      || !isRecord(tool.function)
      || !isRecord(tool.function.parameters)
    )
      continue
    const schemas = collectSchemas(tool.function.parameters)
    // Preserve reference-bearing parameters so shared targets keep their constraints.
    if (schemas.some((schema) => hasReference(schema))) continue
    for (const schema of schemas) repairArrayItemEnum(schema)
  }
}
