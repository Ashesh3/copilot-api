import { describe, expect, test } from "bun:test"

import { normalizeGeminiToolSchemas } from "~/services/copilot/gemini-tool-schema"

function payloadFor(
  parameters: Record<string, unknown>,
  model = "gemini-4-carbon",
) {
  return {
    model,
    messages: [{ role: "user", content: "Find matching records." }],
    tools: [
      {
        type: "function",
        function: { name: "search_records", parameters },
      },
    ],
  }
}

describe("Gemini array item enums", () => {
  test.each([
    { type: "integer", values: [0, 1, 25] },
    { type: "number", values: [-1, 0, 2.5] },
    { type: "string", values: ["", "active", "resolved"] },
    { type: "boolean", values: [false, true] },
  ])(
    "moves misplaced $type values into homogeneous items",
    ({ type, values }) => {
      const schema: Record<string, unknown> = {
        type: ["array", "null"],
        description: "Selected values, or null for no filter.",
        minItems: 0,
        uniqueItems: true,
        enum: values,
        items: { type, description: "One selected value." },
      }
      const payload = payloadFor({
        type: "object",
        properties: { filter: schema },
      })

      normalizeGeminiToolSchemas(payload)

      expect(schema).toEqual({
        type: ["array", "null"],
        description: "Selected values, or null for no filter.",
        minItems: 0,
        uniqueItems: true,
        items: { type, description: "One selected value.", enum: values },
      })
      const normalized = structuredClone(payload)
      normalizeGeminiToolSchemas(payload)
      expect(payload).toEqual(normalized)
    },
  )

  test.each([
    { name: "whole-array choices", type: "array", enum: [[1], [2]] },
    { name: "mixed scalar choices", type: ["array", "integer"], enum: [1, 2] },
    {
      name: "nullable whole-value choices",
      type: ["array", "null"],
      enum: [1, null],
    },
    { name: "empty choices", type: "array", enum: [] },
    { name: "fractional integer choices", type: "array", enum: [1, 2.5] },
    { name: "non-finite choices", type: "array", enum: [1, Infinity] },
    { name: "object choices", type: "array", enum: [{ value: 1 }] },
    { name: "different scalar choices", type: "array", enum: ["1", "2"] },
  ])("preserves $name", ({ type, enum: choices }) => {
    const payload = payloadFor({
      type,
      enum: choices,
      items: { type: "integer" },
    })
    const before = structuredClone(payload)

    normalizeGeminiToolSchemas(payload)

    expect(payload).toEqual(before)
  })

  test.each([
    { name: "existing item enum", items: { type: "integer", enum: [1] } },
    { name: "empty item enum", items: { type: "integer", enum: [] } },
    { name: "tuple items", items: [{ type: "integer" }] },
    { name: "boolean items", items: true },
    { name: "untyped items", items: {} },
    { name: "union items", items: { type: ["integer", "null"] } },
    {
      name: "referenced items",
      items: { type: "integer", $ref: "#/$defs/value" },
    },
    {
      name: "dynamic referenced items",
      items: { type: "integer", $dynamicRef: "#value" },
    },
    {
      name: "recursive referenced items",
      items: { type: "integer", $recursiveRef: "#" },
    },
  ])("preserves $name", ({ items }) => {
    const payload = payloadFor({ type: "array", enum: [1, 2], items })
    const before = structuredClone(payload)

    normalizeGeminiToolSchemas(payload)

    expect(payload).toEqual(before)
  })

  test.each([
    { prefixItems: [{ type: "integer" }] },
    { $ref: "#/$defs/values" },
  ])("does not reinterpret a tuple or referenced array (%j)", (extra) => {
    const payload = payloadFor({
      ...extra,
      type: "array",
      enum: [1, 2],
      items: { type: "integer" },
    })
    const before = structuredClone(payload)

    normalizeGeminiToolSchemas(payload)

    expect(payload).toEqual(before)
  })
})

describe("Gemini schema references", () => {
  test.each(["$ref", "$dynamicRef", "$recursiveRef"])(
    "preserves parameters containing %s links before repairing any nodes",
    (referenceField) => {
      const payload = payloadFor({
        type: "object",
        properties: {
          level: { [referenceField]: "#/properties/levels/items" },
          levels: {
            type: ["array", "null"],
            enum: [1, 2],
            items: { type: "integer" },
          },
        },
      })
      const before = structuredClone(payload)

      normalizeGeminiToolSchemas(payload)

      expect(payload).toEqual(before)
    },
  )

  test("repairs a reference-free tool without changing another tool's nested references", () => {
    const referenced = payloadFor({
      type: "object",
      properties: {
        levels: { type: "array", enum: [1, 2], items: { type: "integer" } },
        group: {
          type: "object",
          properties: { level: { $ref: "#/properties/levels/items" } },
        },
      },
    })
    const referenceFree = payloadFor({
      type: "object",
      properties: {
        levels: { type: "array", enum: [1, 2], items: { type: "integer" } },
      },
    })
    const before = structuredClone(referenced.tools[0])
    const payload = {
      ...referenced,
      tools: [...referenced.tools, ...referenceFree.tools],
    }

    normalizeGeminiToolSchemas(payload)

    expect(payload.tools[0]).toEqual(before)
    expect(payload.tools[1].function.parameters).toEqual({
      type: "object",
      properties: {
        levels: { type: "array", items: { type: "integer", enum: [1, 2] } },
      },
    })
  })

  test.each(["default", "const", "enum", "examples"])(
    "ignores reference-shaped %s data when deciding whether to repair",
    (field) => {
      const literal = { $ref: "#/properties/levels/items" }
      const data =
        field === "enum" || field === "examples" ? [literal] : literal
      const schema: Record<string, unknown> = {
        type: "array",
        enum: [1, 2],
        items: { type: "integer" },
      }
      const payload = payloadFor({
        type: "object",
        properties: { levels: schema },
        [field]: structuredClone(data),
      })

      normalizeGeminiToolSchemas(payload)

      expect(schema).toEqual({
        type: "array",
        items: { type: "integer", enum: [1, 2] },
      })
      expect(payload.tools[0].function.parameters[field]).toEqual(data)
    },
  )
})

describe("Gemini anyOf sibling constraints", () => {
  test("moves nullable object constraints into discriminated anyOf branches", () => {
    const capabilities: Record<string, unknown> = {
      type: ["array", "null"],
      default: null,
      description: "Optional capability allow-list.",
      items: {
        type: ["object", "null"],
        required: ["name"],
        anyOf: [
          {
            properties: {
              name: { const: "People" },
              include_related_content: { type: ["boolean", "null"] },
            },
          },
          {
            properties: {
              name: { const: "Email" },
              folders: {
                type: ["array", "null"],
                items: {
                  type: ["object", "null"],
                  properties: { folder_id: { type: ["string", "null"] } },
                  required: ["folder_id"],
                },
              },
            },
          },
        ],
      },
    }
    const payload = payloadFor({
      type: "object",
      properties: { query: { type: "string" }, capabilities },
      required: ["query"],
    })

    normalizeGeminiToolSchemas(payload)

    expect(capabilities.items).toEqual({
      anyOf: [
        {
          type: ["object", "null"],
          properties: {
            name: { const: "People" },
            include_related_content: { type: ["boolean", "null"] },
          },
          required: ["name"],
        },
        {
          type: ["object", "null"],
          properties: {
            name: { const: "Email" },
            folders: {
              type: ["array", "null"],
              items: {
                type: ["object", "null"],
                properties: { folder_id: { type: ["string", "null"] } },
                required: ["folder_id"],
              },
            },
          },
          required: ["name"],
        },
      ],
    })
    expect(payload.tools[0].function.parameters.required).toEqual(["query"])
    const normalized = structuredClone(payload)
    normalizeGeminiToolSchemas(payload)
    expect(payload).toEqual(normalized)
  })

  test("intersects types and merges shared properties into each branch", () => {
    const schema: Record<string, unknown> = {
      type: ["object", "null"],
      description: "A filter.",
      properties: {
        kind: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["kind", "limit", "missing"],
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["text"] } },
          required: ["kind"],
        },
        { type: ["null", "object"] },
      ],
    }

    normalizeGeminiToolSchemas(
      payloadFor({ type: "object", properties: { filter: schema } }),
    )

    expect(schema).toEqual({
      description: "A filter.",
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["text"] },
            limit: { type: "integer" },
          },
          required: ["kind", "limit"],
        },
        {
          type: ["null", "object"],
          properties: {
            kind: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["kind", "limit"],
        },
      ],
    })
  })

  test("repairs nested properties before copying them into branches", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        levels: { type: "array", enum: [1, 2], items: { type: "integer" } },
      },
      anyOf: [{ properties: { mode: { type: "string" } } }],
    }

    normalizeGeminiToolSchemas(
      payloadFor({ type: "object", properties: { filter: schema } }),
    )

    expect(schema).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            levels: { type: "array", items: { type: "integer", enum: [1, 2] } },
            mode: { type: "string" },
          },
        },
      ],
    })
  })

  test.each([
    {
      name: "annotation-only siblings",
      schema: {
        description: "Optional path.",
        default: null,
        title: "Path",
        anyOf: [{ type: "string" }, { type: "null" }],
      },
    },
    {
      name: "a branch outside the parent type",
      schema: { type: "object", anyOf: [{ type: "string" }] },
    },
    {
      name: "a non-object branch",
      schema: { type: "object", anyOf: [true] },
    },
    {
      name: "malformed parent required",
      schema: { required: "name", anyOf: [{ type: "object" }] },
    },
    {
      name: "malformed branch properties",
      schema: { type: "object", anyOf: [{ properties: [] }] },
    },
    {
      name: "an empty anyOf",
      schema: { type: "object", anyOf: [] },
    },
  ])("preserves $name", ({ schema }) => {
    const payload = payloadFor({
      type: "object",
      properties: { value: structuredClone(schema) },
    })
    const before = structuredClone(payload)

    normalizeGeminiToolSchemas(payload)

    expect(payload).toEqual(before)
  })

  test("leaves non-Gemini anyOf constraints unchanged", () => {
    const payload = payloadFor(
      {
        type: "object",
        required: ["name"],
        anyOf: [{ properties: { name: { const: "People" } } }],
      },
      "claude-current",
    )
    const before = structuredClone(payload)

    normalizeGeminiToolSchemas(payload)

    expect(payload).toEqual(before)
  })
})

describe("Gemini schema boundaries", () => {
  test("walks schema positions without modifying embedded JSON values", () => {
    const literal: Record<string, unknown> = {
      type: "array",
      enum: [1, 2],
      items: { type: "integer" },
    }
    const schema = {
      type: "object",
      properties: {
        default: structuredClone(literal),
        union: {
          anyOf: [{ properties: { values: structuredClone(literal) } }],
        },
      },
      $defs: { values: structuredClone(literal) },
      additionalProperties: structuredClone(literal),
      default: structuredClone(literal),
      const: structuredClone(literal),
      examples: [structuredClone(literal)],
      enum: [structuredClone(literal)],
      "x-custom": structuredClone(literal),
    }

    normalizeGeminiToolSchemas(payloadFor(schema))

    const repaired = { type: "array", items: { type: "integer", enum: [1, 2] } }
    expect(schema.properties.default).toEqual(repaired)
    expect(schema.$defs.values).toEqual(repaired)
    expect(schema.properties.union.anyOf[0].properties.values).toEqual(repaired)
    expect(schema.additionalProperties).toEqual(repaired)
    expect(schema.default).toEqual(literal)
    expect(schema.const).toEqual(literal)
    expect(schema.examples).toEqual([literal])
    expect(schema.enum).toEqual([literal])
    expect(schema["x-custom"]).toEqual(literal)
  })

  test.each(["gpt-current", "claude-current", "custom-gemini-4"])(
    "leaves %s tool schemas unchanged",
    (model) => {
      const payload = payloadFor(
        { type: "array", enum: [1, 2], items: { type: "integer" } },
        model,
      )
      const before = structuredClone(payload)

      normalizeGeminiToolSchemas(payload)

      expect(payload).toEqual(before)
    },
  )

  test("recognizes Gemini model names case-insensitively", () => {
    const schema: Record<string, unknown> = {
      type: "array",
      enum: [1, 2],
      items: { type: "integer" },
    }

    normalizeGeminiToolSchemas(payloadFor(schema, "GEMINI-4-CARBON"))

    expect(schema).toEqual({
      type: "array",
      items: { type: "integer", enum: [1, 2] },
    })
  })

  test("leaves non-function tools and opaque message content untouched", () => {
    const schema = { type: "array", enum: [1, 2], items: { type: "integer" } }
    const payload = {
      model: "gemini-4-carbon",
      messages: [{ role: "tool", content: structuredClone(schema) }],
      tools: [
        { type: "future", function: { parameters: structuredClone(schema) } },
        { type: "function", function: { parameters: true } },
        null,
      ],
    }
    const before = structuredClone(payload)

    normalizeGeminiToolSchemas(payload)

    expect(payload).toEqual(before)
  })
})
