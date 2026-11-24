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
const ANY_OF_MOVABLE_CONSTRAINTS = ["type", "required"] as const
const UNION_FIELDS = ["anyOf", "oneOf", "allOf"] as const

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
  types?: Array<string>
  required?: Array<string>
}

interface AnyOfBranchUpdate {
  branch: Record<string, unknown>
  type?: string | Array<string>
  required?: Array<string>
}

function intersectTypeMember(
  member: string,
  parentMembers: Array<string>,
): string | null {
  if (parentMembers.includes(member)) return member
  // Every JSON Schema integer is also a number, in either operand order.
  if (
    (member === "integer" && parentMembers.includes("number"))
    || (member === "number" && parentMembers.includes("integer"))
  )
    return "integer"
  return null
}

function intersectTypes(
  parentMembers: Array<string>,
  branchType: unknown,
): string | Array<string> | null {
  const branchMembers =
    branchType === undefined ? parentMembers : typeMembers(branchType)
  if (!branchMembers) return null
  const shared = [
    ...new Set(
      branchMembers
        .map((member) => intersectTypeMember(member, parentMembers))
        .filter((member) => member !== null),
    ),
  ]
  if (shared.length === 0) return null
  return shared.length === 1 ? shared[0] : shared
}

function movableParentConstraints(
  schema: Record<string, unknown>,
): AnyOfParentConstraints | null {
  if (!ANY_OF_MOVABLE_CONSTRAINTS.some((field) => Object.hasOwn(schema, field)))
    return null
  // Moving parent properties would have to intersect or rescope them, so leave
  // those unions unchanged rather than weakening the tool schema.
  if (Object.hasOwn(schema, "properties")) return null
  const constraints: AnyOfParentConstraints = {}
  if (Object.hasOwn(schema, "type")) {
    const types = typeMembers(schema.type)
    if (!types) return null
    constraints.types = types
  }
  if (Object.hasOwn(schema, "required")) {
    if (!isStringArray(schema.required)) return null
    constraints.required = schema.required
  }
  return constraints
}

function planBranchUpdate(
  branch: unknown,
  parent: AnyOfParentConstraints,
): AnyOfBranchUpdate | null {
  if (
    !isRecord(branch)
    || hasReference(branch)
    || UNION_FIELDS.some((field) => Object.hasOwn(branch, field))
  )
    return null
  const update: AnyOfBranchUpdate = { branch }
  if (parent.types) {
    const type = intersectTypes(parent.types, branch.type)
    // A branch outside the parent type cannot match; leave the schema intact.
    if (type === null) return null
    update.type = type
  }
  if (parent.required) {
    const { properties, required } = branch
    // Keep every requirement: each branch must declare the names it inherits.
    if (
      !isRecord(properties)
      || !parent.required.every((name) => Object.hasOwn(properties, name))
      || (required !== undefined && !isStringArray(required))
    )
      return null
    const branchRequired = isStringArray(required) ? required : []
    update.required = [...new Set([...branchRequired, ...parent.required])]
  }
  return update
}

function repairAnyOfSiblingConstraints(schema: Record<string, unknown>): void {
  const branches = schema.anyOf
  if (!Array.isArray(branches) || branches.length === 0) return
  const parent = movableParentConstraints(schema)
  if (!parent) return

  const updates: Array<AnyOfBranchUpdate> = []
  for (const branch of branches) {
    const update = planBranchUpdate(branch, parent)
    if (!update) return
    updates.push(update)
  }

  // Gemini rejects type or required beside anyOf, which some MCP servers use
  // for discriminated unions. Every branch must satisfy them anyway, so moving
  // them into the branches keeps the same schema instead of failing the whole
  // request.
  for (const { branch, type, required } of updates) {
    if (type !== undefined) branch.type = type
    if (required !== undefined) branch.required = required
  }
  delete schema.type
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
    // The array repair can replace items objects, so walk the current tree again.
    for (const schema of collectSchemas(tool.function.parameters)) {
      repairAnyOfSiblingConstraints(schema)
    }
  }
}
