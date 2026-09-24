import { expect, test } from "bun:test"

import {
  normalizeAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "~/services/copilot/messages-contract"

const definitionName = "__copilot_api_tool_input"
const definitionPointer = `#/$defs/${definitionName}`

function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const request = normalizeAnthropicMessagesRequest({
    model: "claude-current",
    messages: [{ role: "user", content: "Use the declared tool." }],
    tools: [{ name: "fixture_tool", input_schema: schema }],
  })
  const tools = request.tools as Array<{
    input_schema: Record<string, unknown>
  }>
  return tools[0].input_schema
}

test("preserves the captured referenced union behind an object root", () => {
  const source = {
    type: "object",
    properties: {},
    oneOf: [{ $ref: "#/$defs/view" }, { $ref: "#/$defs/edit" }],
    $defs: {
      view: {
        type: "object",
        properties: { mode: { const: "view" }, id: { type: "string" } },
        required: ["mode", "id"],
        additionalProperties: false,
      },
      edit: {
        oneOf: [{ $ref: "#/$defs/create" }, { $ref: "#/$defs/remove" }],
      },
      create: {
        type: "object",
        properties: { mode: { const: "create" } },
        required: ["mode"],
      },
      remove: {
        type: "object",
        properties: { mode: { const: "remove" } },
        required: ["mode"],
      },
    },
  }
  const snapshot = structuredClone(source)
  const result = normalizeSchema(source)

  expect(result).not.toHaveProperty("oneOf")
  expect(result).toHaveProperty("type", "object")
  expect(result).toHaveProperty("$ref", definitionPointer)
  expect(result).toHaveProperty(`$defs.${definitionName}`, {
    type: "object",
    properties: {},
    oneOf: [{ $ref: "#/$defs/view" }, { $ref: "#/$defs/edit" }],
  })
  expect(result).toHaveProperty("$defs.view", source.$defs.view)
  expect(result).toHaveProperty("$defs.edit", source.$defs.edit)
  expect(source).toEqual(snapshot)
  expect(normalizeSchema(result)).toEqual(result)
})

test.each(["oneOf", "anyOf", "allOf"])(
  "relocates %s with its sibling validation rules intact",
  (keyword) => {
    const source = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.test/tools/input",
      type: "object",
      properties: { shared: { type: "string" } },
      required: ["shared"],
      [keyword]: [{ properties: { value: { type: "integer" } } }],
      unevaluatedProperties: false,
      not: { required: ["forbidden"] },
    }
    const result = normalizeSchema(source)
    expect(result).not.toHaveProperty(keyword)
    expect(result).toHaveProperty("$schema", source.$schema)
    expect(result).toHaveProperty("$id", source.$id)
    expect(result).toHaveProperty(`$defs.${definitionName}`, {
      type: "object",
      properties: { shared: { type: "string" } },
      required: ["shared"],
      [keyword]: [{ properties: { value: { type: "integer" } } }],
      unevaluatedProperties: false,
      not: { required: ["forbidden"] },
    })
  },
)

test("retains existing root references and reserves a distinct definition name", () => {
  const source = {
    type: "object",
    $ref: "#/$defs/base",
    allOf: [{ required: ["value"] }],
    $defs: { [definitionName]: { type: "string" }, base: { type: "object" } },
    definitions: { legacy: { type: "string" } },
  }
  const result = normalizeSchema(source)
  expect(result.$ref).toBe(`#/$defs/${definitionName}_2`)
  expect(result).toHaveProperty(`$defs.${definitionName}`, { type: "string" })
  expect(result).toHaveProperty(
    `$defs.${definitionName}_2.$ref`,
    "#/$defs/base",
  )
  expect(result.definitions).toEqual(source.definitions)
})

test.each(["04", "06", "07"])(
  "keeps nested resources discoverable in explicit draft %s schemas",
  (draft) => {
    const source = {
      $schema: `http://json-schema.org/draft-${draft}/schema#`,
      type: "object",
      allOf: [{ required: ["child"] }],
      properties: {
        child: {
          [draft === "04" ? "id" : "$id"]: "https://example.test/child",
          type: "object",
          properties: {
            own: { type: "string" },
            use: { $ref: "#/properties/own" },
          },
        },
      },
      definitions: { [definitionName]: { type: "string" } },
    }
    const result = normalizeSchema(source)
    expect(result.$ref).toBe(`#/definitions/${definitionName}_2`)
    expect(result).toHaveProperty(
      `definitions.${definitionName}_2.properties.child`,
      source.properties.child,
    )
    expect(result).toHaveProperty(`definitions.${definitionName}`, {
      type: "string",
    })
  },
)

test("rebases schema pointers into moved root fields without changing literal example data", () => {
  const literal = { $ref: "#/oneOf/0", oneOf: [{ required: ["keep"] }] }
  const source = {
    type: "object",
    oneOf: [{ properties: { "a/b": { type: "string" } } }],
    properties: {
      value: {
        $ref: "#/oneOf/0/properties/a~1b",
        default: literal,
        examples: [literal],
      },
      nested: { $ref: "#" },
    },
    $defs: { reference: { $ref: "#/properties/value" } },
  }
  const result = normalizeSchema(source)
  expect(result).toHaveProperty(
    `$defs.${definitionName}.properties.value.$ref`,
    `${definitionPointer}/oneOf/0/properties/a~1b`,
  )
  expect(result).toHaveProperty(
    `$defs.${definitionName}.properties.nested.$ref`,
    "#",
  )
  expect(result).toHaveProperty(
    "$defs.reference.$ref",
    `${definitionPointer}/properties/value`,
  )
  expect(result).toHaveProperty(
    `$defs.${definitionName}.properties.value.default`,
    literal,
  )
  expect(result).toHaveProperty(
    `$defs.${definitionName}.properties.value.examples`,
    [literal],
  )
})

test("preserves nested resource scopes and rebases explicit references to the outer resource", () => {
  const source = {
    $id: "https://example.test/schema/root",
    $anchor: "input",
    $dynamicAnchor: "node",
    type: "object",
    anyOf: [{ required: ["outer"] }],
    properties: {
      outer: { type: "string" },
      child: {
        $id: "child",
        type: "object",
        properties: {
          local: { $ref: "#/properties/value" },
          recursive: { $ref: "#" },
          parent: {
            $ref: "https://example.test/schema/root#/properties/outer",
          },
          relativeParent: { $ref: "root#/properties/outer" },
          dynamic: { $dynamicRef: "#node" },
        },
      },
    },
  }
  const result = normalizeSchema(source)
  const child = `$defs.${definitionName}.properties.child`
  expect(result.$anchor).toBe("input")
  expect(result.$dynamicAnchor).toBe("node")
  expect(result).toHaveProperty(
    `${child}.properties.local.$ref`,
    "#/properties/value",
  )
  expect(result).toHaveProperty(`${child}.properties.recursive.$ref`, "#")
  expect(result).toHaveProperty(
    `${child}.properties.parent.$ref`,
    `https://example.test/schema/root${definitionPointer}/properties/outer`,
  )
  expect(result).toHaveProperty(
    `${child}.properties.relativeParent.$ref`,
    `root${definitionPointer}/properties/outer`,
  )
  expect(result).toHaveProperty(
    `${child}.properties.dynamic.$dynamicRef`,
    "#node",
  )
})

test.each([
  {
    dialect: "https://json-schema.org/draft/2020-12/schema",
    rootId: "$id",
    ignoredId: "id",
    definitions: "$defs",
  },
  {
    dialect: "http://json-schema.org/draft-07/schema#",
    rootId: "$id",
    ignoredId: "id",
    definitions: "definitions",
  },
  {
    dialect: "http://json-schema.org/draft-04/schema#",
    rootId: "id",
    ignoredId: "$id",
    definitions: "definitions",
  },
])(
  "uses only the resource identifier defined by $dialect",
  ({ dialect, rootId, ignoredId, definitions }) => {
    const source = {
      $schema: dialect,
      [rootId]: "https://example.test/root",
      type: "object",
      allOf: [{ required: ["source"] }],
      properties: {
        source: { type: "string" },
        child: { [ignoredId]: "child", $ref: "#/properties/source" },
      },
    }
    const result = normalizeSchema(source)
    expect(result).toHaveProperty(
      `${definitions}.${definitionName}.properties.child.$ref`,
      `#/${definitions}/${definitionName}/properties/source`,
    )
  },
)

test("normalizes only declared tool input schemas and leaves ordinary schemas unchanged", () => {
  const composed = {
    type: "object",
    allOf: [{ properties: { value: { type: "string" } } }],
  }
  const ordinary = {
    type: "object",
    properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
  }
  const source = {
    model: "claude-current",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "echo",
            input: { input_schema: composed },
          },
        ],
      },
    ],
    tools: [
      { name: "echo", input_schema: composed },
      { name: "ordinary", input_schema: ordinary },
    ],
    output_config: { format: { type: "json_schema", schema: composed } },
  }
  const original = structuredClone(source)
  const result = JSON.parse(
    serializeAnthropicMessagesRequest(source),
  ) as Record<string, unknown>
  expect(result).not.toHaveProperty("tools.0.input_schema.allOf")
  expect(result).toHaveProperty("tools.1.input_schema", ordinary)
  expect(result.messages).toEqual(source.messages)
  expect(result.output_config).toEqual(source.output_config)
  expect(source).toEqual(original)
})
