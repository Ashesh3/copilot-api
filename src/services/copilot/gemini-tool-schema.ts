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
const ANY_OF_SIBLING_CONSTRAINTS = ["type", "properties", "required"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((member) => typeof member === "string")
  )
}

function typeMembers(type: unknown): Array<string> | null {
  if (typeof type === "string") return [type]
  return isStringArray(type) && type.length > 0 ? type : null
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

interface AnyOfParentConstraints {
  hasType: boolean
  type: unknown
  properties?: Record<string, unknown>
  required?: Array<string>
}

interface AnyOfBranchUpdate {
  branch: Record<string, unknown>
  type?: unknown
  properties?: Record<string, unknown>
  required?: Array<string>
}

function intersectTypes(parentType: unknown, branchType: unknown): unknown {
  if (branchType === undefined) return structuredClone(parentType)
  const parentMembers = typeMembers(parentType)
  const branchMembers = typeMembers(branchType)
  if (!parentMembers || !branchMembers) return undefined
  const shared = branchMembers.filter((member) =>
    parentMembers.includes(member),
  )
  if (shared.length === 0) return undefined
  return shared.length === 1 ? shared[0] : shared
}

function anyOfParentConstraints(
  schema: Record<string, unknown>,
): AnyOfParentConstraints | null {
  if (!ANY_OF_SIBLING_CONSTRAINTS.some((field) => Object.hasOwn(schema, field)))
    return null
  const hasType = Object.hasOwn(schema, "type")
  const { type, properties, required } = schema
  if (
    (hasType && !typeMembers(type))
    || (properties !== undefined && !isRecord(properties))
    || (required !== undefined && !isStringArray(required))
  )
    return null
  return {
    hasType,
    type,
    properties: properties,
    required: required,
  }
}

function isRepairableBranch(
  branch: unknown,
): branch is Record<string, unknown> {
  return (
    isRecord(branch)
    && !hasReference(branch)
    && (branch.properties === undefined || isRecord(branch.properties))
    && (branch.required === undefined || isStringArray(branch.required))
  )
}

function planBranchUpdate(
  branch: Record<string, unknown>,
  parent: AnyOfParentConstraints,
): AnyOfBranchUpdate | null {
  const update: AnyOfBranchUpdate = { branch }
  if (parent.hasType) {
    update.type = intersectTypes(parent.type, branch.type)
    // A branch outside the parent type cannot match; leave the schema intact.
    if (update.type === undefined) return null
  }
  const branchProperties =
    isRecord(branch.properties) ? branch.properties : undefined
  if (parent.properties) {
    update.properties = {
      ...structuredClone(parent.properties),
      ...branchProperties,
    }
  }
  if (parent.required) {
    const properties = update.properties ?? branchProperties ?? {}
    const required = new Set(
      isStringArray(branch.required) ? branch.required : [],
    )
    for (const name of parent.required) {
      if (Object.hasOwn(properties, name)) required.add(name)
    }
    if (required.size > 0) update.required = [...required]
  }
  return update
}

function repairAnyOfSiblingConstraints(schema: Record<string, unknown>): void {
  const branches = schema.anyOf
  if (!Array.isArray(branches) || branches.length === 0) return
  const parent = anyOfParentConstraints(schema)
  if (!parent) return

  const updates: Array<AnyOfBranchUpdate> = []
  for (const branch of branches) {
    if (!isRepairableBranch(branch)) return
    const update = planBranchUpdate(branch, parent)
    if (!update) return
    updates.push(update)
  }

  // Gemini rejects object constraints beside anyOf, which some MCP servers use
  // for discriminated unions. Each branch must satisfy those constraints anyway,
  // so carrying them into the branches keeps the tool instead of failing the
  // whole request. Gemini also rejects required names absent from properties.
  for (const { branch, type, properties, required } of updates) {
    if (type !== undefined) branch.type = type
    if (properties !== undefined) branch.properties = properties
    if (required !== undefined) branch.required = required
  }
  delete schema.type
  delete schema.properties
  delete schema.required
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

/** Repairs Gemini-rejected schema shapes only on the owned Gemini Chat wire clone. */
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
    // Children precede parents, so properties copied into branches are already repaired.
    for (const schema of schemas.toReversed()) {
      repairAnyOfSiblingConstraints(schema)
    }
  }
}
