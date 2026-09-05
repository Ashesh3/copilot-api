function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeGoogleSchema(
  value: unknown,
  changed: { value: boolean },
): Record<string, unknown> {
  if (!isRecord(value)) {
    changed.value = true
    return { type: "object", properties: {} }
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "type") {
      if (typeof item === "string") {
        const normalized = item.toLowerCase()
        output.type = normalized
        if (normalized !== item) changed.value = true
      } else if (Array.isArray(item)) {
        output.type = item.map((entry: unknown) =>
          typeof entry === "string" ? entry.toLowerCase() : entry,
        )
      } else output.type = structuredClone(item)
      continue
    }
    if (
      [
        "$defs",
        "definitions",
        "dependentSchemas",
        "patternProperties",
        "properties",
      ].includes(key)
      && isRecord(item)
    ) {
      output[key] = Object.fromEntries(
        Object.entries(item).map(([name, schema]) => [
          name,
          normalizeSchemaNode(schema, changed),
        ]),
      )
      continue
    }
    if (
      [
        "additionalItems",
        "additionalProperties",
        "contains",
        "else",
        "if",
        "items",
        "not",
        "propertyNames",
        "then",
        "unevaluatedItems",
        "unevaluatedProperties",
      ].includes(key)
    ) {
      output[key] =
        Array.isArray(item) ?
          item.map((entry) => normalizeSchemaNode(entry, changed))
        : normalizeSchemaNode(item, changed)
      continue
    }
    if (
      ["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)
      && Array.isArray(item)
    ) {
      output[key] = item.map((entry) => normalizeSchemaNode(entry, changed))
      continue
    }
    output[key] = structuredClone(item)
  }
  if (Array.isArray(output.required)) {
    const repaired = Array.from(
      new Set(
        output.required.filter(
          (item): item is string => typeof item === "string",
        ),
      ),
    )
    if (JSON.stringify(repaired) !== JSON.stringify(output.required))
      changed.value = true
    output.required = repaired
  }
  return output
}

function normalizeSchemaNode(
  value: unknown,
  changed: { value: boolean },
): unknown {
  // Typeless and boolean JSON Schemas carry constraints of their own.
  return isRecord(value) ?
      normalizeGoogleSchema(value, changed)
    : structuredClone(value)
}
