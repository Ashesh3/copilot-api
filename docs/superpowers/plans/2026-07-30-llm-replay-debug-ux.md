# LLM Replay and Debug UX Implementation Plan

> **2026-08-10 amendment:** The later Raw LLM Debug Capture design supersedes
> this plan's automatic initial JSON formatting. Replay now loads and resets to
> the exact captured request body; `Format JSON` remains an explicit action.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw LLM Replay transport dump with an editable split workspace, reconstruct useful streamed output (including tool-only responses), add request/response exports, and keep multi-megabyte Debug payloads responsive.

**Architecture:** Keep the existing replay API and security boundary unchanged. Add pure JSON, tool-call, and export helpers under `ui/src/lib`, use CodeMirror 6 as the virtualized editable/read-only document surface, bound the existing JSON tree by child pages and node thresholds, and compose both screens around one `ResponseInspector` that mounts only its selected tab.

**Tech Stack:** React 19, TypeScript 5.9, Bun test runner, Vite single-file build, Astryx components, CodeMirror 6.

---

## File map

### New files

- `ui/src/lib/json-document.ts` — JSON syntax location, formatting, and replay-object/model validation.
- `ui/src/lib/response-tool-calls.ts` — Responses API and Chat Completions tool-call reconstruction.
- `ui/src/lib/http-export.ts` — pure request/response export builders plus the browser download helper.
- `ui/src/components/CodeMirrorDocument.tsx` — controlled CodeMirror lifecycle shared by editable and read-only surfaces.
- `ui/src/components/JsonCodeEditor.tsx` — labeled editable JSON surface with diagnostic output.
- `ui/src/components/VirtualizedCodeViewer.tsx` — read-only, searchable CodeMirror document viewer.
- `ui/src/components/ResponseExportMenu.tsx` — Assistant output, normalized JSON, and raw HTTP response downloads.
- `ui/src/components/ResponseInspector.tsx` — Output, Details, Events, and Raw tabs used by Debug and Replay.
- `ui/src/lib/response-output.ts` — pure output-state descriptions consumed by the inspector.
- `ui/src/lib/replay-result.ts` — classify upstream replay status without replacing the last successful result.
- `tests/json-document.test.ts` — replay document formatting and validation tests.
- `tests/http-export.test.ts` — request/response export serialization tests.
- `tests/response-output.test.ts` — assistant/tool/error/partial/empty output-state tests.
- `tests/replay-result.test.ts` — replay success/error envelope classification tests.

### Modified files

- `ui/package.json`, `ui/package-lock.json` — direct CodeMirror dependencies.
- `ui/src/lib/json-tree.ts` — bounded node measurement and child-page helpers.
- `ui/src/lib/responses-body.ts` — normalized `toolCalls` and `errorMessage` fields.
- `ui/src/lib/types.ts` — remove replay-only presentation duplication only where screen integration no longer uses it; keep the server response contract intact.
- `ui/src/components/JsonTreeViewer.tsx` — render at most 100 children per expanded container and disable recursive expansion for large documents.
- `ui/src/components/RequestExportMenu.tsx` — use shared builders, accept edited replay text, and label the control `Export request`.
- `ui/src/screens/LlmDebug.tsx` — local request Pretty/Raw control and shared response inspector.
- `ui/src/screens/LlmReplay.tsx` — persistent split workspace, debounced validation, and preserved last successful result.
- `ui/src/global.css` — CodeMirror, response inspector, paged tree, and responsive replay layout styles.
- `tests/json-tree.test.ts`, `tests/responses-body.test.ts`, `tests/llm-debug-dashboard.test.ts` — deterministic regression and generated-bundle coverage.
- `src/routes/dashboard/page-generated.ts` — regenerated only by `bun run build:ui`.

### Removed file

- `ui/src/components/ResponsesBodyViewer.tsx` — superseded by `ResponseInspector`; do not leave both presentation paths active.

## Task 1: Add CodeMirror dependencies and replay JSON validation

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/package-lock.json`
- Create: `ui/src/lib/json-document.ts`
- Create: `tests/json-document.test.ts`

- [ ] **Step 1: Install the direct CodeMirror packages**

Run from `F:\Projects\copilot-api\ui`:

```powershell
npm install @codemirror/autocomplete@6.20.3 @codemirror/commands@6.10.4 @codemirror/lang-json@6.0.2 @codemirror/language@6.12.4 @codemirror/lint@6.9.7 @codemirror/search@6.7.1 @codemirror/state@6.7.1 @codemirror/view@6.43.7
```

Expected: npm exits 0 and updates only `ui/package.json` and `ui/package-lock.json`.

- [ ] **Step 2: Write the failing replay-document tests**

Create `tests/json-document.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import {
  findJsonDocumentDiagnostic,
  formatJsonDocument,
  prepareReplayDocument,
  validateReplayDocument,
} from "../ui/src/lib/json-document"

describe("replay JSON documents", () => {
  test("formats valid JSON without reordering keys", () => {
    expect(formatJsonDocument('{"z":1,"model":"gpt-test","a":true}')).toBe(
      '{\n  "z": 1,\n  "model": "gpt-test",\n  "a": true\n}',
    )
  })

  test("keeps malformed source text unchanged on initial load", () => {
    expect(prepareReplayDocument('{"model":')).toBe('{"model":')
  })

  test("reports a located syntax diagnostic", () => {
    const diagnostic = findJsonDocumentDiagnostic(
      '{\n  "model": "gpt-test",\n}',
    )

    expect(diagnostic).not.toBeNull()
    if (!diagnostic) throw new Error("Expected a JSON diagnostic")
    expect(diagnostic.line).toBe(3)
    expect(diagnostic.column).toBeGreaterThan(0)
    expect(diagnostic.kind).toBe("syntax")
    expect(diagnostic.message).toContain("Invalid JSON at line 3")
  })

  test("requires an object root", () => {
    const validation = validateReplayDocument('["gpt-test"]')

    expect(validation.ok).toBe(false)
    if (validation.ok) throw new Error("Expected invalid replay JSON")
    expect(validation.diagnostic.message).toBe(
      "Replay body must be a JSON object.",
    )
    expect(validation.diagnostic.kind).toBe("root")
  })

  test("requires a non-empty model", () => {
    const validation = validateReplayDocument('{"model":"  ","input":[]}')

    expect(validation.ok).toBe(false)
    if (validation.ok) throw new Error("Expected invalid replay JSON")
    expect(validation.diagnostic.message).toBe("model is required.")
    expect(validation.diagnostic.kind).toBe("model")
  })

  test("returns the parsed replay object when valid", () => {
    const validation = validateReplayDocument(
      '{"model":"gpt-test","stream":true}',
    )

    expect(validation.ok).toBe(true)
    if (!validation.ok) throw new Error("Expected valid replay JSON")
    expect(validation.value).toEqual({ model: "gpt-test", stream: true })
  })
})
```

- [ ] **Step 3: Run the new test and confirm RED**

Run:

```powershell
bun test tests/json-document.test.ts
```

Expected: FAIL because `ui/src/lib/json-document.ts` does not exist.

- [ ] **Step 4: Implement the JSON document helper**

Create `ui/src/lib/json-document.ts`:

```ts
import { jsonLanguage } from "@codemirror/lang-json"

import type { JsonValue } from "./json-tree"

export interface JsonDocumentDiagnostic {
  column: number
  from: number
  kind: "model" | "root" | "syntax"
  line: number
  message: string
  to: number
}

export type ReplayDocumentValidation =
  | {
      ok: true
      value: { [key: string]: JsonValue }
    }
  | {
      diagnostic: JsonDocumentDiagnostic
      ok: false
    }

function locationAt(raw: string, offset: number): {
  column: number
  line: number
} {
  const bounded = Math.max(0, Math.min(offset, raw.length))
  const prefix = raw.slice(0, bounded)
  const lines = prefix.split("\n")
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length }
}

function documentDiagnostic(
  raw: string,
  from: number,
  kind: JsonDocumentDiagnostic["kind"],
  message: string,
  to = from,
): JsonDocumentDiagnostic {
  const boundedFrom = Math.max(0, Math.min(from, raw.length))
  const boundedTo = Math.max(
    boundedFrom,
    Math.min(Math.max(to, boundedFrom + (raw.length > 0 ? 1 : 0)), raw.length),
  )
  const location = locationAt(raw, boundedFrom)
  return {
    ...location,
    from: boundedFrom,
    kind,
    message,
    to: boundedTo,
  }
}

export function findJsonDocumentDiagnostic(
  raw: string,
): JsonDocumentDiagnostic | null {
  const cursor = jsonLanguage.parser.parse(raw).cursor()
  do {
    if (cursor.type.isError) {
      const location = locationAt(raw, cursor.from)
      return documentDiagnostic(
        raw,
        cursor.from,
        "syntax",
        `Invalid JSON at line ${location.line}, column ${location.column}.`,
        cursor.to,
      )
    }
  } while (cursor.next())
  return null
}

export function formatJsonDocument(raw: string): string | null {
  if (findJsonDocumentDiagnostic(raw)) return null
  try {
    return JSON.stringify(JSON.parse(raw) as JsonValue, null, 2)
  } catch {
    return null
  }
}

export function prepareReplayDocument(raw: string): string {
  return raw
}

export function validateReplayDocument(
  raw: string,
): ReplayDocumentValidation {
  const syntaxDiagnostic = findJsonDocumentDiagnostic(raw)
  if (syntaxDiagnostic) return { diagnostic: syntaxDiagnostic, ok: false }

  const value = JSON.parse(raw) as JsonValue
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      diagnostic: documentDiagnostic(
        raw,
        0,
        "root",
        "Replay body must be a JSON object.",
      ),
      ok: false,
    }
  }

  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    return {
      diagnostic: documentDiagnostic(raw, 0, "model", "model is required."),
      ok: false,
    }
  }

  return { ok: true, value }
}
```

- [ ] **Step 5: Run the helper tests and confirm GREEN**

Run:

```powershell
bun test tests/json-document.test.ts
```

Expected: 6 pass, 0 fail.

- [ ] **Step 6: Typecheck the UI dependency boundary**

Run from `F:\Projects\copilot-api\ui`:

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 7: Commit Task 1**

```powershell
git add ui/package.json ui/package-lock.json ui/src/lib/json-document.ts tests/json-document.test.ts
git commit -m "feat: add replay JSON document validation"
```

## Task 2: Bound large JSON tree rendering

**Files:**
- Modify: `ui/src/lib/json-tree.ts`
- Modify: `ui/src/components/JsonTreeViewer.tsx`
- Modify: `ui/src/global.css`
- Modify: `tests/json-tree.test.ts`

- [ ] **Step 1: Add failing scale and paging tests**

Append these imports and tests to `tests/json-tree.test.ts`:

```ts
import {
  JSON_CHILD_PAGE_SIZE,
  hasJsonEntries,
  initialJsonContainerPaths,
  jsonEntryPage,
  measureJsonDocument,
} from "../ui/src/lib/json-tree"

test("returns only one bounded page of container children", () => {
  const value = Array.from({ length: 250 }, (_, index) => index)
  const first = jsonEntryPage(value, JSON_CHILD_PAGE_SIZE)
  const second = jsonEntryPage(value, JSON_CHILD_PAGE_SIZE * 2)

  expect(first.entries).toHaveLength(100)
  expect(first.remaining).toBe(150)
  expect(second.entries).toHaveLength(200)
  expect(second.remaining).toBe(50)
})

test("detects non-empty containers without expanding them", () => {
  expect(hasJsonEntries([])).toBe(false)
  expect(hasJsonEntries([1])).toBe(true)
  expect(hasJsonEntries({})).toBe(false)
  expect(hasJsonEntries({ model: "gpt-test" })).toBe(true)
})

test("stops measuring once a JSON tree crosses the node threshold", () => {
  const value = Array.from({ length: 5_100 }, (_, index) => ({ index }))
  const scale = measureJsonDocument(value, 1_024)

  expect(scale.isLarge).toBe(true)
  expect(scale.exceededNodeThreshold).toBe(true)
  expect(scale.nodeCount).toBe(5_001)
})

test("classifies a large byte document without walking the whole tree", () => {
  const scale = measureJsonDocument({ model: "gpt-test" }, 250 * 1_024 + 1)

  expect(scale.isLarge).toBe(true)
  expect(scale.exceededNodeThreshold).toBe(false)
  expect(scale.nodeCount).toBe(1)
})

test("initially expands only the root of a large document", () => {
  const value = { input: [{ content: "hello" }], model: "gpt-test" }
  expect([...initialJsonContainerPaths(value, true)]).toEqual(["#"])
  expect([...initialJsonContainerPaths(value, false)]).toEqual(["#", "#/input"])
})
```

Also remove the obsolete test named `auto-expands high-cardinality containers`; the new behavior deliberately pages high-cardinality containers instead of expanding every child.

- [ ] **Step 2: Run the JSON tree tests and confirm RED**

Run:

```powershell
bun test tests/json-tree.test.ts
```

Expected: FAIL because the paging and scale exports are missing.

- [ ] **Step 3: Add bounded helpers to `json-tree.ts`**

Add the following exports after `jsonEntries`:

```ts
export const JSON_CHILD_PAGE_SIZE = 100
export const LARGE_JSON_BYTE_THRESHOLD = 250 * 1_024
export const LARGE_JSON_NODE_THRESHOLD = 5_000

export interface JsonDocumentScale {
  exceededNodeThreshold: boolean
  isLarge: boolean
  nodeCount: number
}

export interface JsonEntryPage {
  entries: Array<[string, JsonValue]>
  remaining: number
  total: number
}

export function jsonEntryPage(
  value: JsonValue,
  visibleCount: number,
): JsonEntryPage {
  if (Array.isArray(value)) {
    const boundedCount = Math.max(0, Math.min(visibleCount, value.length))
    return {
      entries: value
        .slice(0, boundedCount)
        .map(
          (item, index): [string, JsonValue] => [String(index), item],
        ),
      remaining: value.length - boundedCount,
      total: value.length,
    }
  }
  if (!isJsonContainer(value)) {
    return { entries: [], remaining: 0, total: 0 }
  }
  const keys = Object.keys(value)
  const boundedCount = Math.max(0, Math.min(visibleCount, keys.length))
  return {
    entries: keys
      .slice(0, boundedCount)
      .map((key): [string, JsonValue] => [key, value[key]]),
    remaining: keys.length - boundedCount,
    total: keys.length,
  }
}

export function hasJsonEntries(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (!isJsonContainer(value)) return false
  for (const key in value) {
    if (Object.hasOwn(value, key)) return true
  }
  return false
}

export function initialJsonContainerPaths(
  value: JsonValue,
  isLarge: boolean,
): Set<string> {
  return collectJsonContainerPaths(value, isLarge ? 0 : 1)
}

export function measureJsonDocument(
  value: JsonValue,
  byteLength: number,
): JsonDocumentScale {
  if (byteLength > LARGE_JSON_BYTE_THRESHOLD) {
    return {
      exceededNodeThreshold: false,
      isLarge: true,
      nodeCount: 1,
    }
  }

  let nodeCount = 0
  let exceededNodeThreshold = false
  const stack: Array<JsonValue> = [value]

  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    nodeCount += 1
    if (nodeCount > LARGE_JSON_NODE_THRESHOLD) {
      exceededNodeThreshold = true
      break
    }
    if (!isJsonContainer(node)) continue
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
    } else {
      for (const key in node) {
        if (Object.hasOwn(node, key)) stack.push(node[key])
      }
    }
  }

  return {
    exceededNodeThreshold,
    isLarge: exceededNodeThreshold,
    nodeCount,
  }
}
```

Also rewrite `collectJsonContainerPaths.visit` so it checks the depth before
enumerating children:

```ts
function visit(node: JsonValue, path: string, depth: number): void {
  if (!isJsonContainer(node) || !hasJsonEntries(node)) return
  if (depth <= maxDepth) paths.add(path)
  if (depth >= maxDepth) return

  for (const [key, child] of jsonEntries(node)) {
    visit(child, jsonPointerPath(path, key), depth + 1)
  }
}
```

- [ ] **Step 4: Page each expanded tree node**

In `JsonTreeViewer.tsx`, import `JSON_CHILD_PAGE_SIZE`, `hasJsonEntries`, `initialJsonContainerPaths`, `jsonEntryPage`, and `measureJsonDocument`. Delete the node-level `const entries = jsonEntries(value)` allocation and replace the unbounded `entries.map` path inside `JsonTreeNode` with this complete paging state and render block:

```tsx
const [visibleCount, setVisibleCount] = useState(JSON_CHILD_PAGE_SIZE)
const page = jsonEntryPage(value, visibleCount)
const isContainer = isJsonContainer(value)
const isExpandable = isContainer && page.total > 0
const isExpanded = isExpandable && expandedPaths.has(path)

{isExpanded ?
  <div role="group">
    {page.entries.map(([key, child], index) => (
      <JsonTreeNode
        key={jsonPointerPath(path, key)}
        depth={depth + 1}
        expandedPaths={expandedPaths}
        isLast={
          page.remaining === 0 && index === page.entries.length - 1
        }
        path={jsonPointerPath(path, key)}
        propertyName={Array.isArray(value) ? undefined : key}
        value={child}
        onToggle={onToggle}
      />
    ))}
    {page.remaining > 0 ?
      <div className="json-tree-more" style={style} role="treeitem">
        <Button
          label={`Show ${Math.min(JSON_CHILD_PAGE_SIZE, page.remaining)} more (${page.remaining} remaining)`}
          variant="ghost"
          size="sm"
          onClick={() =>
            setVisibleCount((current) => current + JSON_CHILD_PAGE_SIZE)
          }
        />
      </div>
    : null}
    <div
      className="json-tree-closing-row"
      style={style}
      aria-hidden="true"
    >
      <span className="json-tree-chevron-slot" />
      <code className="json-tree-punctuation">
        {close}
        {isLast ? "" : ","}
      </code>
    </div>
  </div>
: null}
```

Use `page.total` in the collapsed key/item count instead of `entries.length`.

- [ ] **Step 5: Apply large-document disclosure rules**

Inside `JsonTreeViewer`, replace the current initial-expansion calculation and `expandAll` handling with:

```tsx
const documentScale = useMemo(
  () => measureJsonDocument(value, new TextEncoder().encode(formatted).length),
  [formatted, value],
)
const initiallyExpanded = useMemo(
  () => initialJsonContainerPaths(value, documentScale.isLarge),
  [documentScale.isLarge, value],
)
const [expandedPaths, setExpandedPaths] = useState(initiallyExpanded)

function expandAll() {
  if (documentScale.isLarge) return
  setExpandedPaths(collectJsonContainerPaths(value))
}
```

Configure the `Expand all` button as follows:

```tsx
<Button
  label="Expand all"
  variant="ghost"
  size="sm"
  isDisabled={!rootIsContainer || documentScale.isLarge}
  tooltip={
    documentScale.isLarge ?
      "Expand all is disabled for large JSON documents. Expand individual paths instead."
    : undefined
  }
  onClick={expandAll}
/>
```

Replace the existing root check with:

```ts
const rootIsContainer = isJsonContainer(value) && hasJsonEntries(value)
```

Add `onCopyError?: (message: string) => void` to `JsonTreeViewerProps`,
destructure it in `JsonTreeViewer`, and replace `copyFormatted` with:

```tsx
async function copyFormatted() {
  try {
    await navigator.clipboard.writeText(formatted)
    onCopy()
  } catch (error) {
    onCopyError?.(error instanceof Error ? error.message : "Copy failed")
  }
}
```


- [ ] **Step 6: Style the paging control**

Add to `ui/src/global.css`:

```css
.json-tree-more {
  box-sizing: border-box;
  min-height: 28px;
  padding-inline-start: calc(
    var(--spacing-2) + (var(--json-depth) + 1) * var(--spacing-4)
  );
  padding-inline-end: var(--spacing-3);
}
```

- [ ] **Step 7: Run tests, typecheck, and focused lint**

```powershell
bun test tests/json-tree.test.ts
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/lib/json-tree.ts ui/src/components/JsonTreeViewer.tsx tests/json-tree.test.ts
```

Expected: all commands exit 0; the JSON tree suite reports 0 failures.

- [ ] **Step 8: Commit Task 2**

```powershell
git add ui/src/lib/json-tree.ts ui/src/components/JsonTreeViewer.tsx ui/src/global.css tests/json-tree.test.ts
git commit -m "perf: bound large JSON tree rendering"
```

## Task 3: Reconstruct tool calls and normalize response errors

**Files:**
- Create: `ui/src/lib/response-tool-calls.ts`
- Modify: `ui/src/lib/responses-body.ts`
- Modify: `ui/src/components/ResponsesBodyViewer.tsx`
- Modify: `tests/responses-body.test.ts`

- [ ] **Step 1: Add failing Responses API tool-call tests**

Append to `tests/responses-body.test.ts`:

```ts
test("reconstructs a tool-only Responses stream", () => {
  const raw = [
    sse("response.output_item.added", {
      item: {
        id: "fc_1",
        call_id: "call_1",
        type: "function_call",
        name: "lookup",
        arguments: "",
      },
      output_index: 0,
      sequence_number: 1,
    }),
    sse("response.function_call_arguments.delta", {
      item_id: "fc_1",
      output_index: 0,
      delta: '{"id":',
      sequence_number: 2,
    }),
    sse("response.function_call_arguments.delta", {
      item_id: "fc_1",
      output_index: 0,
      delta: "7}",
      sequence_number: 3,
    }),
    sse("response.function_call_arguments.done", {
      item_id: "fc_1",
      output_index: 0,
      arguments: '{"id":7}',
      sequence_number: 4,
    }),
    sse("response.completed", {
      response: {
        id: "resp_tool",
        object: "response",
        status: "completed",
        output: [
          {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "lookup",
            arguments: '{"id":7}',
          },
        ],
      },
      sequence_number: 5,
    }),
  ].join("")

  const parsed = parseResponsesBody(raw)
  expect(parsed?.assistantText).toBe("")
  expect(parsed?.toolCalls).toEqual([
    {
      arguments: '{"id":7}',
      argumentsJson: { id: 7 },
      callId: "call_1",
      id: "fc_1",
      name: "lookup",
      outputIndex: 0,
    },
  ])
})

test("keeps malformed tool arguments visible", () => {
  const parsed = parseResponsesBody(
    sse("response.output_item.done", {
      item: {
        id: "fc_bad",
        type: "function_call",
        name: "lookup",
        arguments: '{"id":',
      },
      output_index: 0,
      sequence_number: 1,
    }),
  )

  expect(parsed?.toolCalls[0]?.arguments).toBe('{"id":')
  expect(parsed?.toolCalls[0]?.argumentsJson).toBeNull()
})

test("does not invent tool calls from ordinary output events", () => {
  const parsed = parseResponsesBody(
    sse("response.output_text.done", {
      text: "Final answer",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
    }),
  )

  expect(parsed?.assistantText).toBe("Final answer")
  expect(parsed?.toolCalls).toEqual([])
})

test("normalizes a Responses error event without a response snapshot", () => {
  const parsed = parseResponsesBody(
    sse("response.failed", {
      error: { code: "server_error", message: "Generation failed" },
      sequence_number: 1,
    }),
  )

  expect(parsed?.errorMessage).toBe("Generation failed")
  expect(parsed?.status).toBe("failed")
  expect(parsed?.isPartial).toBe(false)
})
```

- [ ] **Step 2: Add a failing Chat Completions tool-fragment test**

Append:

```ts
test("reconstructs Chat Completions tool-call fragments", () => {
  const raw = [
    chatChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_chat",
          type: "function",
          function: { name: "lookup", arguments: '{"id":' },
        },
      ],
    }),
    chatChunk({
      tool_calls: [
        { index: 0, function: { arguments: "9}" } },
      ],
    }),
    chatChunk({}, "tool_calls"),
  ].join("")

  expect(parseResponsesBody(raw)?.toolCalls).toEqual([
    {
      arguments: '{"id":9}',
      argumentsJson: { id: 9 },
      callId: null,
      id: "call_chat",
      name: "lookup",
      outputIndex: 0,
    },
  ])
})
```

Replace every existing `parsed?.toolCallCount` assertion in this test file with `parsed?.toolCalls.length`.

- [ ] **Step 3: Run the response parser suite and confirm RED**

```powershell
bun test tests/responses-body.test.ts
```

Expected: FAIL because `toolCalls` and `errorMessage` are not returned.

- [ ] **Step 4: Implement reusable tool-call assembly**

Create `ui/src/lib/response-tool-calls.ts` with the following complete public contract and implementation:

```ts
import type { JsonValue } from "./json-tree"

type JsonRecord = { [key: string]: JsonValue }

export interface ParsedToolCall {
  arguments: string
  argumentsJson: JsonValue | null
  callId: string | null
  id: string | null
  name: string | null
  outputIndex: number
}

export interface ResponseToolCallFrame {
  data: JsonValue
  type: string
}

interface MutableToolCall {
  arguments: string
  argumentsDone: boolean
  callId: string | null
  id: string | null
  name: string | null
  order: number
  outputIndex: number
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" ? value : null
}

function isToolCallItem(value: JsonValue | undefined): value is JsonRecord {
  if (!isRecord(value) || typeof value.type !== "string") return false
  return [
    "computer_call",
    "custom_tool_call",
    "file_search_call",
    "function_call",
    "mcp_call",
    "web_search_call",
  ].includes(value.type)
}

function argumentsJson(value: string): JsonValue | null {
  if (value.trim().length === 0) return null
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return null
  }
}

function findCall(
  calls: Array<MutableToolCall>,
  id: string | null,
  callId: string | null,
  outputIndex: number,
): MutableToolCall | undefined {
  return calls.find(
    (call) =>
      (id !== null && call.id === id)
      || (callId !== null && call.callId === callId)
      || call.outputIndex === outputIndex,
  )
}

function ensureCall(
  calls: Array<MutableToolCall>,
  options: {
    callId: string | null
    id: string | null
    outputIndex: number
  },
): MutableToolCall {
  const existing = findCall(
    calls,
    options.id,
    options.callId,
    options.outputIndex,
  )
  if (existing) {
    existing.id ??= options.id
    existing.callId ??= options.callId
    return existing
  }

  const created: MutableToolCall = {
    arguments: "",
    argumentsDone: false,
    callId: options.callId,
    id: options.id,
    name: null,
    order: calls.length,
    outputIndex: options.outputIndex,
  }
  calls.push(created)
  return created
}

function mergeArguments(
  call: MutableToolCall,
  value: string | null,
  authoritative: boolean,
): void {
  if (value === null) return
  if (authoritative) {
    call.arguments = value
    call.argumentsDone = true
  } else if (!call.argumentsDone) {
    call.arguments += value
  }
}

function mergeItem(
  call: MutableToolCall,
  item: JsonRecord,
  authoritative: boolean,
): void {
  const fn = isRecord(item.function) ? item.function : null
  call.id ??= stringValue(item.id)
  call.callId ??= stringValue(item.call_id)
  call.name ??= stringValue(item.name) ?? stringValue(fn?.name)
  mergeArguments(
    call,
    stringValue(item.arguments) ?? stringValue(fn?.arguments),
    authoritative,
  )
}

function finishCall(call: MutableToolCall): ParsedToolCall {
  return {
    arguments: call.arguments,
    argumentsJson: argumentsJson(call.arguments),
    callId: call.callId,
    id: call.id,
    name: call.name,
    outputIndex: call.outputIndex,
  }
}

export function collectResponsesToolCalls(
  response: JsonRecord | null,
  frames: Array<ResponseToolCallFrame>,
): Array<ParsedToolCall> {
  const calls: Array<MutableToolCall> = []

  for (const [frameIndex, frame] of frames.entries()) {
    if (!isRecord(frame.data)) continue
    const item = isToolCallItem(frame.data.item) ? frame.data.item : null
    const argumentsEvent =
      frame.type === "response.function_call_arguments.delta"
      || frame.type === "response.function_call_arguments.done"
    if (!item && !argumentsEvent) continue
    const outputIndex =
      numberValue(frame.data.output_index)
      ?? numberValue(item?.output_index)
      ?? frameIndex
    const call = ensureCall(calls, {
      callId:
        stringValue(frame.data.call_id) ?? stringValue(item?.call_id),
      id: stringValue(frame.data.item_id) ?? stringValue(item?.id),
      outputIndex,
    })

    if (item) {
      mergeItem(call, item, frame.type === "response.output_item.done")
    }
    if (frame.type === "response.function_call_arguments.delta") {
      mergeArguments(call, stringValue(frame.data.delta), false)
    }
    if (frame.type === "response.function_call_arguments.done") {
      mergeArguments(call, stringValue(frame.data.arguments), true)
    }
  }

  if (response && Array.isArray(response.output)) {
    for (const [outputIndex, value] of response.output.entries()) {
      if (!isToolCallItem(value)) continue
      const call = ensureCall(calls, {
        callId: stringValue(value.call_id),
        id: stringValue(value.id),
        outputIndex,
      })
      mergeItem(call, value, true)
    }
  }

  return calls
    .sort(
      (left, right) =>
        left.outputIndex - right.outputIndex || left.order - right.order,
    )
    .map(finishCall)
}

export function collectChatToolCalls(
  frames: Array<JsonRecord>,
): Array<ParsedToolCall> {
  const calls = new Map<string, MutableToolCall>()

  for (const data of frames) {
    if (!Array.isArray(data.choices)) continue
    for (const choiceValue of data.choices) {
      if (!isRecord(choiceValue)) continue
      const choiceIndex = numberValue(choiceValue.index) ?? 0
      const delta = isRecord(choiceValue.delta) ? choiceValue.delta : null
      const message = isRecord(choiceValue.message) ? choiceValue.message : null
      const source = message ?? delta
      if (!source || !Array.isArray(source.tool_calls)) continue

      for (const [listIndex, toolValue] of source.tool_calls.entries()) {
        if (!isRecord(toolValue)) continue
        const toolIndex = numberValue(toolValue.index) ?? listIndex
        const key = `${choiceIndex}:${toolIndex}`
        const call =
          calls.get(key)
          ?? {
            arguments: "",
            argumentsDone: false,
            callId: null,
            id: null,
            name: null,
            order: calls.size,
            outputIndex: toolIndex,
          }
        calls.set(key, call)

        const fn = isRecord(toolValue.function) ? toolValue.function : null
        call.id ??= stringValue(toolValue.id)
        call.callId ??= stringValue(toolValue.call_id)
        call.name ??= stringValue(fn?.name)
        mergeArguments(call, stringValue(fn?.arguments), message !== null)
      }
    }
  }

  return [...calls.values()].sort((a, b) => a.order - b.order).map(finishCall)
}
```

- [ ] **Step 5: Replace count-only parser output with normalized calls**

In `ui/src/lib/responses-body.ts`:

1. Import `collectChatToolCalls` and `collectResponsesToolCalls`, plus a type-only `ParsedToolCall` import from `./response-tool-calls`.
2. Replace `toolCallCount: number` in `ParsedResponsesBody` with `toolCalls: Array<ParsedToolCall>` and add `errorMessage: string | null`.
3. Delete `countToolCalls` and `addChatToolCalls`.
4. In `parseChatCompletionFrames`, build and use:

```ts
const recordFrames = frames.flatMap((frame) =>
  isRecord(frame.data) ? [frame.data] : [],
)
const toolCalls = collectChatToolCalls(recordFrames)
```

Delete `toolCallIds`, remove the `addChatToolCalls` call inside the choice loop,
pass `toolCalls.length` into `chatResponseMetadata`, and return both
`errorMessage` and `toolCalls`.
5. In `parseResponsesBody`, add these helpers and result fields:

```ts
function errorText(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value
  if (!isRecord(value)) return null
  return (
    stringValue(value.message)
    ?? stringValue(value.code)
    ?? stringValue(value.type)
    ?? null
  )
}

function responseErrorMessage(
  response: JsonRecord | null,
  frames: Array<ParsedFrame>,
): string | null {
  const responseError = errorText(response?.error)
  if (responseError) return responseError
  for (const frame of [...frames].reverse()) {
    if (!isRecord(frame.data)) continue
    const message = errorText(frame.data.error)
    if (message) return message
  }
  return null
}

const toolCalls = collectResponsesToolCalls(
  response,
  frames.map((frame) => ({ data: frame.data, type: eventType(frame) })),
)
const errorMessage = responseErrorMessage(response, frames)
```

Return `errorMessage` and `toolCalls` from the Responses parser result.

- [ ] **Step 6: Keep the current viewer compiling during the parser transition**

In `ui/src/components/ResponsesBodyViewer.tsx`, replace the Tool calls metadata expression with:

```ts
{
  label: "Tool calls",
  value: parsed.toolCalls.length > 0 ? String(parsed.toolCalls.length) : null,
},
```

The full tool-call UI arrives in Task 6; this step ensures there is no interval where the repository fails to typecheck.

- [ ] **Step 7: Run parser tests, typecheck, and lint**

```powershell
bun test tests/responses-body.test.ts
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/lib/response-tool-calls.ts ui/src/lib/responses-body.ts ui/src/components/ResponsesBodyViewer.tsx tests/responses-body.test.ts
```

Expected: all existing and new response parser tests pass; all commands exit 0.

- [ ] **Step 8: Commit Task 3**

```powershell
git add ui/src/lib/response-tool-calls.ts ui/src/lib/responses-body.ts ui/src/components/ResponsesBodyViewer.tsx tests/responses-body.test.ts
git commit -m "fix: reconstruct streamed LLM tool calls"
```

## Task 4: Add symmetric request and response exports

**Files:**
- Create: `ui/src/lib/http-export.ts`
- Create: `ui/src/components/ResponseExportMenu.tsx`
- Create: `tests/http-export.test.ts`
- Modify: `ui/src/components/RequestExportMenu.tsx`

- [ ] **Step 1: Write failing pure export tests**

Create `tests/http-export.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { ParsedResponsesBody } from "../ui/src/lib/responses-body"

import {
  buildAssistantOutputMarkdown,
  buildCurlRequest,
  buildRawHttpRequest,
  buildRawHttpResponse,
  buildResponseJson,
  formatRequestJson,
} from "../ui/src/lib/http-export"

const request = {
  body: '{"model":"gpt-test","input":"hello"}',
  bodyBytes: 36,
  headers: { "content-type": "application/json", "x-debug": "yes" },
  method: "POST",
  path: "/responses",
  url: "https://example.test/responses?mode=debug",
}

const parsed: ParsedResponsesBody = {
  assistantText: "Final answer",
  copilotUsage: null,
  errorMessage: null,
  events: [],
  isPartial: false,
  reasoningText: "Checked the request.",
  response: { id: "resp_1", status: "completed" },
  status: "completed",
  toolCalls: [
    {
      arguments: '{"id":7}',
      argumentsJson: { id: 7 },
      callId: "call_1",
      id: "fc_1",
      name: "lookup",
      outputIndex: 0,
    },
  ],
  usage: { total_tokens: 12 },
}

describe("LLM debug exports", () => {
  test("builds a replayable cURL request", () => {
    const curl = buildCurlRequest(request)
    expect(curl).toContain('curl -X POST "https://example.test/responses?mode=debug"')
    expect(curl).toContain('-H "content-type: application/json"')
    expect(curl).toContain('--data-raw "{\\"model\\":\\"gpt-test\\",\\"input\\":\\"hello\\"}"')
  })

  test("formats request JSON and rejects malformed JSON", () => {
    expect(formatRequestJson(request.body)).toBe(
      '{\n  "model": "gpt-test",\n  "input": "hello"\n}\n',
    )
    expect(formatRequestJson('{"model":')).toBeNull()
  })

  test("builds raw HTTP request framing", () => {
    expect(buildRawHttpRequest(request)).toBe(
      [
        "POST /responses?mode=debug HTTP/1.1",
        "Host: example.test",
        "content-type: application/json",
        "x-debug: yes",
        "",
        request.body,
      ].join("\r\n"),
    )
  })

  test("exports assistant Markdown with tool calls but without reasoning", () => {
    const markdown = buildAssistantOutputMarkdown(parsed)
    expect(markdown).toContain("# Assistant output\n\nFinal answer")
    expect(markdown).toContain("## Tool calls")
    expect(markdown).toContain("### lookup")
    expect(markdown).toContain('~~~json\n{\n  "id": 7\n}\n~~~')
    expect(markdown).not.toContain("Checked the request")
  })

  test("exports a useful tool-only Markdown document", () => {
    const markdown = buildAssistantOutputMarkdown({
      ...parsed,
      assistantText: "",
    })
    expect(markdown).toContain(
      "The model returned 1 tool call and no assistant message.",
    )
    expect(markdown).toContain("### lookup")
  })

  test("formats ordinary JSON responses without normalization", () => {
    expect(buildResponseJson('{"ok":true}', null)).toBe(
      '{\n  "ok": true\n}\n',
    )
  })

  test("normalizes streamed responses into lossless parsed JSON", () => {
    const json = buildResponseJson("event: response.completed", parsed)
    expect(json).not.toBeNull()
    const value = JSON.parse(json ?? "") as Record<string, unknown>
    expect(value.status).toBe("completed")
    expect(value.assistantText).toBe("Final answer")
    expect(value.toolCalls).toEqual(parsed.toolCalls)
    expect(value.reasoningText).toBe("Checked the request.")
  })

  test("builds raw HTTP response framing with the exact body", () => {
    expect(
      buildRawHttpResponse({
        body: "data: [DONE]\n\n",
        headers: { "content-type": "text/event-stream" },
        status: 200,
        statusText: "OK",
      }),
    ).toBe(
      "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: [DONE]\n\n",
    )
  })
})
```

- [ ] **Step 2: Run the export suite and confirm RED**

```powershell
bun test tests/http-export.test.ts
```

Expected: FAIL because `ui/src/lib/http-export.ts` does not exist.

- [ ] **Step 3: Implement the pure export builders**

Create `ui/src/lib/http-export.ts`:

```ts
import type { LlmDebugLogRequest } from "./types"
import type { ParsedResponsesBody } from "./responses-body"

export interface HttpResponseExportSource {
  body: string | null
  headers: Record<string, string>
  status: number
  statusText: string
}

function formattedToolArguments(
  toolCall: ParsedResponsesBody["toolCalls"][number],
): { language: "json" | "text"; value: string } {
  if (toolCall.argumentsJson !== null) {
    return {
      language: "json",
      value: JSON.stringify(toolCall.argumentsJson, null, 2),
    }
  }
  return { language: "text", value: toolCall.arguments }
}

export function buildCurlRequest(request: LlmDebugLogRequest): string {
  const lines = [
    `curl -X ${request.method.toUpperCase()} ${JSON.stringify(request.url)}`,
  ]
  for (const [key, value] of Object.entries(request.headers)) {
    lines.push(`  -H ${JSON.stringify(`${key}: ${value}`)}`)
  }
  if (request.body !== null) {
    lines.push(`  --data-raw ${JSON.stringify(request.body)}`)
  }
  return lines.join(" \\\n")
}

export function buildRawHttpRequest(request: LlmDebugLogRequest): string {
  let target = request.path
  let host: string | undefined
  try {
    const url = new URL(request.url)
    target = `${url.pathname}${url.search}`
    host = url.host
  } catch {
    // Keep the captured path for malformed URLs.
  }

  const headers = Object.entries(request.headers)
  const hasHost = headers.some(([key]) => key.toLowerCase() === "host")
  const lines = [`${request.method.toUpperCase()} ${target} HTTP/1.1`]
  if (host && !hasHost) lines.push(`Host: ${host}`)
  for (const [key, value] of headers) lines.push(`${key}: ${value}`)
  lines.push("", request.body ?? "")
  return lines.join("\r\n")
}

export function formatRequestJson(body: string | null): string | null {
  if (body === null) return null
  try {
    return `${JSON.stringify(JSON.parse(body) as unknown, null, 2)}\n`
  } catch {
    return null
  }
}

export function buildAssistantOutputMarkdown(
  parsed: ParsedResponsesBody,
): string | null {
  const sections: Array<string> = []
  if (parsed.assistantText) {
    sections.push(`# Assistant output\n\n${parsed.assistantText}`)
  }

  if (parsed.toolCalls.length > 0) {
    if (!parsed.assistantText) {
      const noun = parsed.toolCalls.length === 1 ? "tool call" : "tool calls"
      sections.push(
        `The model returned ${parsed.toolCalls.length} ${noun} and no assistant message.`,
      )
    }
    const calls = parsed.toolCalls.map((toolCall, index) => {
      const title = toolCall.name ?? `Tool call ${index + 1}`
      const metadata = [
        toolCall.callId ? `Call ID: ${toolCall.callId}` : null,
        toolCall.id ? `Item ID: ${toolCall.id}` : null,
      ].filter((value): value is string => value !== null)
      const args = formattedToolArguments(toolCall)
      return [
        `### ${title}`,
        metadata.join("  \n"),
        `~~~${args.language}\n${args.value}\n~~~`,
      ]
        .filter(Boolean)
        .join("\n\n")
    })
    sections.push(`## Tool calls\n\n${calls.join("\n\n")}`)
  }

  return sections.length > 0 ? `${sections.join("\n\n")}\n` : null
}

export function buildResponseJson(
  body: string | null,
  parsed: ParsedResponsesBody | null,
): string | null {
  if (body !== null) {
    try {
      return `${JSON.stringify(JSON.parse(body) as unknown, null, 2)}\n`
    } catch {
      // SSE and other streamed bodies use the normalized document below.
    }
  }
  if (!parsed) return null

  return `${JSON.stringify(
    {
      status: parsed.status,
      assistantText: parsed.assistantText,
      toolCalls: parsed.toolCalls,
      reasoningText: parsed.reasoningText,
      errorMessage: parsed.errorMessage,
      usage: parsed.usage,
      copilotUsage: parsed.copilotUsage,
      response: parsed.response,
      events: parsed.events,
    },
    null,
    2,
  )}\n`
}

export function buildRawHttpResponse(
  response: HttpResponseExportSource,
): string {
  const lines = [
    `HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd(),
  ]
  for (const [key, value] of Object.entries(response.headers)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push("", response.body ?? "")
  return lines.join("\r\n")
}

export function downloadTextFile(
  filename: string,
  contents: string,
  type: string,
): void {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}
```

- [ ] **Step 4: Refactor and relabel the request export menu**

Replace `ui/src/components/RequestExportMenu.tsx` with:

```tsx
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import type { LlmDebugLogRequest } from "../lib/types"

import { CopyIcon, DownloadIcon, TerminalIcon } from "../icons"
import {
  buildCurlRequest,
  buildRawHttpRequest,
  downloadTextFile,
  formatRequestJson,
} from "../lib/http-export"

export function RequestExportMenu({
  body,
  id,
  isJsonValid,
  request,
  onError,
  onExport,
}: {
  body?: string | null
  id: string
  isJsonValid?: boolean
  request?: LlmDebugLogRequest
  onError: (message: string) => void
  onExport: (format: string) => void
}) {
  const exportRequest =
    request ?
      { ...request, body: body === undefined ? request.body : body }
    : undefined
  const requestJson =
    isJsonValid === false ?
      null
    : formatRequestJson(exportRequest?.body ?? null)

  function save(
    extension: "curl" | "http" | "json",
    contents: string,
    type = "text/plain;charset=utf-8",
  ) {
    try {
      downloadTextFile(`llm-request-${id}.${extension}`, contents, type)
      onExport(extension.toUpperCase())
    } catch (error) {
      onError(error instanceof Error ? error.message : "Export failed")
    }
  }

  return (
    <DropdownMenu
      button={{
        label: "Export request",
        variant: "secondary",
        size: "sm",
        icon: <DownloadIcon />,
        isDisabled: !exportRequest,
      }}
      menuWidth={260}
      placement="below"
    >
      <DropdownMenuItem
        label="cURL command"
        description="Portable shell command"
        icon={<TerminalIcon />}
        onClick={() => {
          if (exportRequest) save("curl", `${buildCurlRequest(exportRequest)}\n`)
        }}
      />
      <DropdownMenuItem
        label="Request JSON"
        description="Formatted request body"
        icon={<DownloadIcon />}
        isDisabled={requestJson === null}
        onClick={() => {
          if (requestJson) {
            save("json", requestJson, "application/json;charset=utf-8")
          }
        }}
      />
      <DropdownMenuItem
        label="Raw HTTP request"
        description="Request line, headers, and body"
        icon={<CopyIcon />}
        onClick={() => {
          if (exportRequest) save("http", buildRawHttpRequest(exportRequest))
        }}
      />
    </DropdownMenu>
  )
}
```

- [ ] **Step 5: Add the response export menu**

Create `ui/src/components/ResponseExportMenu.tsx`:

```tsx
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"

import type { HttpResponseExportSource } from "../lib/http-export"
import type { ParsedResponsesBody } from "../lib/responses-body"

import { CopyIcon, DownloadIcon } from "../icons"
import {
  buildAssistantOutputMarkdown,
  buildRawHttpResponse,
  buildResponseJson,
  downloadTextFile,
} from "../lib/http-export"

export function ResponseExportMenu({
  id,
  parsed,
  response,
  onError,
  onExport,
}: {
  id: string
  parsed: ParsedResponsesBody | null
  response?: HttpResponseExportSource
  onError: (message: string) => void
  onExport: (format: string) => void
}) {
  const markdown = parsed ? buildAssistantOutputMarkdown(parsed) : null
  const responseJson = buildResponseJson(response?.body ?? null, parsed)

  function save(
    extension: "http" | "json" | "md",
    contents: string,
    type: string,
    label: string,
  ) {
    try {
      downloadTextFile(`llm-response-${id}.${extension}`, contents, type)
      onExport(label)
    } catch (error) {
      onError(error instanceof Error ? error.message : "Export failed")
    }
  }

  return (
    <DropdownMenu
      button={{
        label: "Export response",
        variant: "secondary",
        size: "sm",
        icon: <DownloadIcon />,
        isDisabled: !response,
      }}
      menuWidth={280}
      placement="below"
    >
      <DropdownMenuItem
        label="Assistant output"
        description="Markdown output and tool calls"
        icon={<DownloadIcon />}
        isDisabled={markdown === null}
        onClick={() => {
          if (markdown) {
            save("md", markdown, "text/markdown;charset=utf-8", "Markdown")
          }
        }}
      />
      <DropdownMenuItem
        label="Response JSON"
        description="Formatted or normalized response"
        icon={<DownloadIcon />}
        isDisabled={responseJson === null}
        onClick={() => {
          if (responseJson) {
            save(
              "json",
              responseJson,
              "application/json;charset=utf-8",
              "JSON",
            )
          }
        }}
      />
      <DropdownMenuItem
        label="Raw HTTP response"
        description="Status, headers, and exact body"
        icon={<CopyIcon />}
        onClick={() => {
          if (response) {
            save(
              "http",
              buildRawHttpResponse(response),
              "message/http;charset=utf-8",
              "HTTP",
            )
          }
        }}
      />
    </DropdownMenu>
  )
}
```

- [ ] **Step 6: Run export tests, typecheck, and lint**

```powershell
bun test tests/http-export.test.ts
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/lib/http-export.ts ui/src/components/RequestExportMenu.tsx ui/src/components/ResponseExportMenu.tsx tests/http-export.test.ts
```

Expected: 8 pass, 0 fail; all commands exit 0.

- [ ] **Step 7: Commit Task 4**

```powershell
git add ui/src/lib/http-export.ts ui/src/components/RequestExportMenu.tsx ui/src/components/ResponseExportMenu.tsx tests/http-export.test.ts
git commit -m "feat: add LLM response exports"
```

## Task 5: Add virtualized editable and read-only document surfaces

**Files:**
- Create: `ui/src/lib/code-mirror-document.ts`
- Create: `ui/src/components/CodeMirrorDocument.tsx`
- Create: `ui/src/components/JsonCodeEditor.tsx`
- Create: `ui/src/components/VirtualizedCodeViewer.tsx`
- Create: `tests/code-mirror-document.test.ts`
- Modify: `ui/src/global.css`

- [ ] **Step 1: Write a failing CodeMirror state test**

Create `tests/code-mirror-document.test.ts`:

```ts
import { expect, test } from "bun:test"
import { EditorView } from "@codemirror/view"

import {
  createCodeDocumentCompartments,
  createCodeDocumentState,
} from "../ui/src/lib/code-mirror-document"

test("creates a read-only JSON document state", () => {
  const state = createCodeDocumentState(
    {
      doc: '{"model":"gpt-test"}',
      language: "json",
      readOnly: true,
      wrap: true,
    },
    createCodeDocumentCompartments(),
  )

  expect(state.doc.toString()).toBe('{"model":"gpt-test"}')
  expect(state.readOnly).toBe(true)
  expect(state.facet(EditorView.editable)).toBe(false)
})
```

- [ ] **Step 2: Run the new test and confirm RED**

```powershell
bun test tests/code-mirror-document.test.ts
```

Expected: FAIL because `ui/src/lib/code-mirror-document.ts` is missing.

- [ ] **Step 3: Implement the shared CodeMirror state configuration**

Create `ui/src/lib/code-mirror-document.ts`:

```ts
import {
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete"
import {
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  bracketMatching,
} from "@codemirror/language"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { json } from "@codemirror/lang-json"
import { lintGutter } from "@codemirror/lint"
import { searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"

export type CodeDocumentLanguage = "json" | "text"

export interface CodeDocumentCompartments {
  editable: Compartment
  language: Compartment
  readOnly: Compartment
  wrap: Compartment
}

export interface CodeDocumentStateOptions {
  doc: string
  language: CodeDocumentLanguage
  onChange?: (value: string) => void
  readOnly: boolean
  wrap: boolean
}

export function createCodeDocumentCompartments(): CodeDocumentCompartments {
  return {
    editable: new Compartment(),
    language: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
  }
}

export function codeDocumentLanguage(
  language: CodeDocumentLanguage,
): Extension {
  return language === "json" ? json() : []
}

export function codeDocumentWrap(wrap: boolean): Extension {
  return wrap ? EditorView.lineWrapping : []
}

export function createCodeDocumentState(
  options: CodeDocumentStateOptions,
  compartments: CodeDocumentCompartments,
): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      lintGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      closeBrackets(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightActiveLine(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
      ]),
      compartments.editable.of(EditorView.editable.of(!options.readOnly)),
      compartments.readOnly.of(EditorState.readOnly.of(options.readOnly)),
      compartments.language.of(codeDocumentLanguage(options.language)),
      compartments.wrap.of(codeDocumentWrap(options.wrap)),
      options.onChange ?
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange?.(update.state.doc.toString())
        })
      : [],
    ],
  })
}
```

- [ ] **Step 4: Confirm the CodeMirror state test is GREEN**

```powershell
bun test tests/code-mirror-document.test.ts
```

Expected: 1 pass, 0 fail.

- [ ] **Step 5: Implement the controlled CodeMirror lifecycle**

Create `ui/src/components/CodeMirrorDocument.tsx`:

```tsx
import { setDiagnostics } from "@codemirror/lint"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react"

import type { CodeDocumentLanguage } from "../lib/code-mirror-document"

import {
  codeDocumentLanguage,
  codeDocumentWrap,
  createCodeDocumentCompartments,
  createCodeDocumentState,
} from "../lib/code-mirror-document"

export interface CodeDocumentDiagnostic {
  from: number
  message: string
  to: number
}

export interface CodeMirrorDocumentHandle {
  focus: () => void
}

interface CodeMirrorDocumentProps {
  ariaDescribedBy?: string
  ariaLabel: string
  className?: string
  diagnostics?: Array<CodeDocumentDiagnostic>
  language: CodeDocumentLanguage
  onChange?: (value: string) => void
  readOnly: boolean
  value: string
  wrap: boolean
}

export const CodeMirrorDocument = forwardRef<
  CodeMirrorDocumentHandle,
  CodeMirrorDocumentProps
>(function CodeMirrorDocument(
  {
    ariaDescribedBy,
    ariaLabel,
    className,
    diagnostics = [],
    language,
    onChange,
    readOnly,
    value,
    wrap,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const initialOptionsRef = useRef({ language, readOnly, value, wrap })
  const compartmentsRef = useRef(createCodeDocumentCompartments())

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = initialOptionsRef.current
    host.setAttribute("aria-label", ariaLabel)
    if (ariaDescribedBy) host.setAttribute("aria-describedby", ariaDescribedBy)
    const view = new EditorView({
      parent: host,
      state: createCodeDocumentState(
        {
          doc: initial.value,
          language: initial.language,
          readOnly: initial.readOnly,
          wrap: initial.wrap,
          onChange: (next) => onChangeRef.current?.(next),
        },
        compartmentsRef.current,
      ),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const compartments = compartmentsRef.current
    view.dispatch({
      effects: [
        compartments.editable.reconfigure(
          EditorView.editable.of(!readOnly),
        ),
        compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
      ],
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: compartmentsRef.current.wrap.reconfigure(
        codeDocumentWrap(wrap),
      ),
    })
  }, [wrap])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: compartmentsRef.current.language.reconfigure(
        codeDocumentLanguage(language),
      ),
    })
  }, [language])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const documentLength = view.state.doc.length
    view.dispatch(
      setDiagnostics(
        view.state,
        diagnostics.map((diagnostic) => {
          const from = Math.min(diagnostic.from, documentLength)
          return {
            from,
            message: diagnostic.message,
            severity: "error" as const,
            to: Math.max(from, Math.min(diagnostic.to, documentLength)),
          }
        }),
      ),
    )
  }, [diagnostics])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.setAttribute("aria-label", ariaLabel)
    if (ariaDescribedBy) {
      host.setAttribute("aria-describedby", ariaDescribedBy)
    } else {
      host.removeAttribute("aria-describedby")
    }
  }, [ariaDescribedBy, ariaLabel])

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
  }))

  return <div ref={hostRef} className={className} />
})
```

- [ ] **Step 6: Implement the labeled JSON editor**

Create `ui/src/components/JsonCodeEditor.tsx`:

```tsx
import { forwardRef, useId } from "react"

import type { JsonDocumentDiagnostic } from "../lib/json-document"

import {
  CodeMirrorDocument,
  type CodeMirrorDocumentHandle,
} from "./CodeMirrorDocument"

export const JsonCodeEditor = forwardRef<
  CodeMirrorDocumentHandle,
  {
    diagnostic: JsonDocumentDiagnostic | null
    label: string
    onChange: (value: string) => void
    value: string
    wrap: boolean
  }
>(function JsonCodeEditor(
  { diagnostic, label, onChange, value, wrap },
  ref,
) {
  const diagnosticId = useId()
  const renderedDiagnostic =
    diagnostic ?
      {
        ...diagnostic,
        from: Math.min(diagnostic.from, value.length),
        to: Math.min(diagnostic.to, value.length),
      }
    : null
  const diagnostics =
    renderedDiagnostic ?
      [
        {
          from: renderedDiagnostic.from,
          message: renderedDiagnostic.message,
          to: renderedDiagnostic.to,
        },
      ]
    : []

  return (
    <div className="json-code-editor">
      <div className="json-code-editor-label">{label}</div>
      <CodeMirrorDocument
        ref={ref}
        ariaDescribedBy={renderedDiagnostic ? diagnosticId : undefined}
        ariaLabel={label}
        className="code-document is-editable"
        diagnostics={diagnostics}
        language="json"
        readOnly={false}
        value={value}
        wrap={wrap}
        onChange={onChange}
      />
      <div
        id={diagnosticId}
        role="status"
        aria-live="polite"
        className={`json-code-editor-diagnostic${diagnostic ? " is-visible" : ""}`}
      >
        {renderedDiagnostic?.message ?? "JSON is valid."}
      </div>
    </div>
  )
})
```

- [ ] **Step 7: Implement the read-only virtualized viewer**

Create `ui/src/components/VirtualizedCodeViewer.tsx`:

```tsx
import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/Stack"

import type { CodeDocumentLanguage } from "../lib/code-mirror-document"

import { CopyIcon } from "../icons"
import { CodeMirrorDocument } from "./CodeMirrorDocument"

export function VirtualizedCodeViewer({
  label,
  language,
  value,
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  label: string
  language: CodeDocumentLanguage
  value: string
  wrap: boolean
  onCopyError: (message: string) => void
  onCopySuccess: () => void
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      onCopySuccess()
    } catch (error) {
      onCopyError(error instanceof Error ? error.message : "Copy failed")
    }
  }

  return (
    <div className="virtualized-code-viewer">
      <HStack hAlign="end">
        <Button
          label={`Copy ${label}`}
          variant="ghost"
          size="sm"
          icon={<CopyIcon />}
          onClick={() => void copy()}
        />
      </HStack>
      <CodeMirrorDocument
        ariaLabel={label}
        className="code-document is-read-only"
        language={language}
        readOnly
        value={value}
        wrap={wrap}
      />
    </div>
  )
}
```

- [ ] **Step 8: Add CodeMirror and validation styles**

Append to `ui/src/global.css`:

```css
.code-document {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-element);
  background: var(--color-syntax-background);
}

.code-document .cm-editor {
  min-width: 0;
  height: 100%;
  background: transparent;
  color: var(--color-text-primary);
  font-family: var(--font-family-code);
  font-size: var(--text-code-size);
}

.code-document .cm-scroller {
  overflow: auto;
  font-family: inherit;
}

.code-document .cm-gutters {
  border-inline-end: 1px solid var(--color-border);
  background: var(--color-background-muted);
  color: var(--color-text-secondary);
}

.code-document .cm-activeLine,
.code-document .cm-activeLineGutter {
  background: var(--color-overlay-hover);
}

.code-document .cm-focused {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.code-document.is-editable {
  height: clamp(420px, 68vh, 860px);
}

.code-document.is-read-only {
  height: min(60vh, 720px);
}

.json-code-editor,
.virtualized-code-viewer {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--spacing-1);
}

.json-code-editor-label {
  color: var(--color-text-secondary);
  font-size: var(--text-label-size);
  font-weight: var(--font-weight-medium);
}

.json-code-editor-diagnostic {
  min-height: var(--text-supporting-leading);
  color: var(--color-text-secondary);
  font-size: var(--text-supporting-size);
}

.json-code-editor-diagnostic.is-visible {
  color: var(--color-error);
}
```

- [ ] **Step 9: Run the focused verification**

```powershell
bun test tests/code-mirror-document.test.ts tests/json-document.test.ts
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/lib/code-mirror-document.ts ui/src/components/CodeMirrorDocument.tsx ui/src/components/JsonCodeEditor.tsx ui/src/components/VirtualizedCodeViewer.tsx tests/code-mirror-document.test.ts
```

Expected: tests pass and all commands exit 0.

- [ ] **Step 10: Commit Task 5**

```powershell
git add ui/src/lib/code-mirror-document.ts ui/src/components/CodeMirrorDocument.tsx ui/src/components/JsonCodeEditor.tsx ui/src/components/VirtualizedCodeViewer.tsx ui/src/global.css tests/code-mirror-document.test.ts
git commit -m "feat: add virtualized JSON document surfaces"
```

## Task 6: Build the shared response inspector

**Files:**
- Create: `ui/src/lib/response-output.ts`
- Create: `ui/src/components/ResponseInspector.tsx`
- Modify: `ui/src/global.css`
- Create: `tests/response-output.test.ts`

- [ ] **Step 1: Write failing output-state tests**

Create `tests/response-output.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { ParsedResponsesBody } from "../ui/src/lib/responses-body"

import { describeResponseOutput } from "../ui/src/lib/response-output"

const base: ParsedResponsesBody = {
  assistantText: "",
  copilotUsage: null,
  errorMessage: null,
  events: [],
  isPartial: false,
  reasoningText: "",
  response: { status: "completed" },
  status: "completed",
  toolCalls: [],
  usage: null,
}

describe("response output descriptions", () => {
  test("prefers assistant output when present", () => {
    expect(
      describeResponseOutput({ ...base, assistantText: "Final answer" }),
    ).toEqual({ kind: "assistant", message: null })
  })

  test("describes tool-only responses", () => {
    expect(
      describeResponseOutput({
        ...base,
        toolCalls: [
          {
            arguments: "{}",
            argumentsJson: {},
            callId: "call_1",
            id: "fc_1",
            name: "lookup",
            outputIndex: 0,
          },
        ],
      }),
    ).toEqual({
      kind: "tool-only",
      message: "The model returned 1 tool call and no assistant message.",
    })
  })

  test("describes errors before partial and empty states", () => {
    expect(
      describeResponseOutput({
        ...base,
        errorMessage: "Generation failed",
        isPartial: true,
      }),
    ).toEqual({ kind: "error", message: "Generation failed" })
  })

  test("describes partial captures", () => {
    expect(describeResponseOutput({ ...base, isPartial: true })).toEqual({
      kind: "partial",
      message:
        "The capture ended before a final assistant output event was received.",
    })
  })

  test("describes genuinely empty completed responses", () => {
    expect(describeResponseOutput(base)).toEqual({
      kind: "empty",
      message:
        "The completed response contained no assistant message, tool call, refusal, or error.",
    })
  })
})
```

- [ ] **Step 2: Run the output-state tests and confirm RED**

```powershell
bun test tests/response-output.test.ts
```

Expected: FAIL because `ui/src/lib/response-output.ts` does not exist.

- [ ] **Step 3: Implement the pure output-state helper**

Create `ui/src/lib/response-output.ts`:

```ts
import type { ParsedResponsesBody } from "./responses-body"

export type ResponseOutputDescription =
  | { kind: "assistant"; message: null }
  | { kind: "empty" | "error" | "partial" | "tool-only"; message: string }

export function describeResponseOutput(
  parsed: ParsedResponsesBody,
): ResponseOutputDescription {
  if (parsed.assistantText) return { kind: "assistant", message: null }
  if (parsed.toolCalls.length > 0) {
    const noun = parsed.toolCalls.length === 1 ? "tool call" : "tool calls"
    return {
      kind: "tool-only",
      message: `The model returned ${parsed.toolCalls.length} ${noun} and no assistant message.`,
    }
  }
  if (parsed.errorMessage) {
    return { kind: "error", message: parsed.errorMessage }
  }
  if (parsed.isPartial) {
    return {
      kind: "partial",
      message:
        "The capture ended before a final assistant output event was received.",
    }
  }
  return {
    kind: "empty",
    message:
      "The completed response contained no assistant message, tool call, refusal, or error.",
  }
}
```

- [ ] **Step 4: Confirm the output-state tests are GREEN**

```powershell
bun test tests/response-output.test.ts
```

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Create the shared response inspector**

Create `ui/src/components/ResponseInspector.tsx` with these imports and public interface:

```tsx
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { Markdown } from "@astryxdesign/core/Markdown"
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList"
import { Selector } from "@astryxdesign/core/Selector"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Tab, TabList } from "@astryxdesign/core/TabList"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useEffect, useMemo, useState } from "react"

import type { HttpResponseExportSource } from "../lib/http-export"
import type { JsonValue } from "../lib/json-tree"
import type {
  ParsedResponsesBody,
  ResponsesStreamEvent,
} from "../lib/responses-body"
import type { ParsedToolCall } from "../lib/response-tool-calls"

import { parseJsonBody } from "../lib/json-tree"
import { parseResponsesBody } from "../lib/responses-body"
import { describeResponseOutput } from "../lib/response-output"
import { JsonTreeViewer } from "./JsonTreeViewer"
import { ResponseExportMenu } from "./ResponseExportMenu"
import { VirtualizedCodeViewer } from "./VirtualizedCodeViewer"

type InspectorTab = "details" | "events" | "output" | "raw"

export interface ResponseInspectorProps {
  durationMs?: number
  id: string
  response: HttpResponseExportSource
  onCopyError: (message: string) => void
  onCopySuccess: () => void
  onExport: (format: string) => void
  onExportError: (message: string) => void
}
```

Add these metadata and event helpers above `ResponseInspector`:

```tsx
interface MetadataItem {
  label: string
  value: string
}

type JsonRecord = { [key: string]: JsonValue }

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textValue(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return null
}

function formatTimestamp(value: JsonValue | undefined): string | null {
  if (typeof value !== "number") return null
  const date = new Date(value * 1_000)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function formatCount(value: JsonValue | undefined): string | null {
  return typeof value === "number" ? value.toLocaleString() : null
}

function compactItems(
  items: Array<{ label: string; value: string | null }>,
): Array<MetadataItem> {
  return items.flatMap((item) =>
    item.value === null ? [] : [{ label: item.label, value: item.value }],
  )
}

function metadataItems(parsed: ParsedResponsesBody): Array<MetadataItem> {
  const response = parsed.response
  const reasoning =
    response && isRecord(response.reasoning) ? response.reasoning : null
  return compactItems([
    { label: "Status", value: textValue(response?.status) ?? parsed.status },
    { label: "Finish reason", value: textValue(response?.finish_reason) },
    {
      label: "Error",
      value: parsed.errorMessage ?? textValue(response?.error_message),
    },
    { label: "Model", value: textValue(response?.model) },
    { label: "Response ID", value: textValue(response?.id) },
    { label: "Service tier", value: textValue(response?.service_tier) },
    { label: "Created", value: formatTimestamp(response?.created_at) },
    { label: "Completed", value: formatTimestamp(response?.completed_at) },
    { label: "Reasoning effort", value: textValue(reasoning?.effort) },
    { label: "Reasoning mode", value: textValue(reasoning?.mode) },
    {
      label: "System fingerprint",
      value: textValue(response?.system_fingerprint),
    },
    {
      label: "Tool calls",
      value: parsed.toolCalls.length > 0 ? String(parsed.toolCalls.length) : null,
    },
  ])
}

function usageItems(usage: JsonRecord | null): Array<MetadataItem> {
  if (!usage) return []
  const inputDetails =
    isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null
  const outputDetails =
    isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
  return compactItems([
    { label: "Input", value: formatCount(usage.input_tokens) },
    { label: "Cached", value: formatCount(inputDetails?.cached_tokens) },
    {
      label: "Cache write",
      value: formatCount(inputDetails?.cache_write_tokens),
    },
    { label: "Output", value: formatCount(usage.output_tokens) },
    { label: "Reasoning", value: formatCount(outputDetails?.reasoning_tokens) },
    { label: "Total", value: formatCount(usage.total_tokens) },
  ])
}

function copilotUsageItems(usage: JsonRecord | null): Array<MetadataItem> {
  if (!usage) return []
  const details = Array.isArray(usage.token_details) ? usage.token_details : []
  const items = details
    .filter((detail) => isRecord(detail))
    .flatMap((detail) => {
      const type = textValue(detail.token_type)
      const count = formatCount(detail.token_count)
      return type && count ?
          [{ label: type.replaceAll("_", " "), value: count }]
        : []
    })
  const totalNanoAiu = formatCount(usage.total_nano_aiu)
  if (totalNanoAiu) items.push({ label: "Total nano AIU", value: totalNanoAiu })
  for (const [key, value] of Object.entries(usage)) {
    if (key === "token_details" || key === "total_nano_aiu") continue
    const formatted = formatCount(value)
    if (formatted) {
      items.push({ label: key.replaceAll("_", " "), value: formatted })
    }
  }
  return items
}

function MetadataSection({
  items,
  title,
}: {
  items: Array<MetadataItem>
  title: string
}) {
  if (items.length === 0) return null
  return (
    <VStack gap={2}>
      <Heading level={4}>{title}</Heading>
      <MetadataList columns="multi">
        {items.map((item) => (
          <MetadataListItem key={item.label} label={item.label}>
            <Text type="code">{item.value}</Text>
          </MetadataListItem>
        ))}
      </MetadataList>
    </VStack>
  )
}

function eventLabel(event: ResponsesStreamEvent, index: number): string {
  const sequence =
    event.sequenceNumber === undefined ? "" : ` #${event.sequenceNumber}`
  return `${index + 1}. ${event.type}${sequence}`
}

function EventViewer({
  event,
  index,
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  event: ResponsesStreamEvent
  index: number
  onCopyError: (message: string) => void
  onCopySuccess: () => void
  wrap: boolean
}) {
  const formatted = useMemo(() => JSON.stringify(event.data, null, 2), [event])
  return (
    <div className="responses-event-detail">
      <JsonTreeViewer
        key={`${index}:${event.type}:${event.sequenceNumber ?? ""}`}
        formatted={formatted}
        label={`Response event ${index + 1}`}
        value={event.data}
        wrap={wrap}
        onCopy={onCopySuccess}
        onCopyError={onCopyError}
      />
    </div>
  )
}
```

Then add the tool-call viewer:

```tsx
function ToolCallViewer({
  toolCall,
  index,
  wrap,
  onCopyError,
  onCopySuccess,
}: {
  index: number
  onCopyError: (message: string) => void
  onCopySuccess: () => void
  toolCall: ParsedToolCall
  wrap: boolean
}) {
  const label = toolCall.name ?? `Tool call ${index + 1}`
  return (
    <Collapsible defaultIsOpen trigger={label}>
      <VStack gap={2}>
        <HStack gap={3} wrap="wrap">
          {toolCall.callId ? <Text type="code">Call {toolCall.callId}</Text> : null}
          {toolCall.id ? <Text type="code">Item {toolCall.id}</Text> : null}
        </HStack>
        {toolCall.argumentsJson !== null ?
          <JsonTreeViewer
            formatted={JSON.stringify(toolCall.argumentsJson, null, 2)}
            label={`${label} arguments`}
            value={toolCall.argumentsJson}
            wrap={wrap}
            onCopy={onCopySuccess}
            onCopyError={onCopyError}
          />
        : <VirtualizedCodeViewer
            label={`${label} arguments`}
            language="text"
            value={toolCall.arguments}
            wrap={wrap}
            onCopyError={onCopyError}
            onCopySuccess={onCopySuccess}
          />
        }
      </VStack>
    </Collapsible>
  )
}
```

Implement `ResponseInspector` as follows:

```tsx
export function ResponseInspector({
  durationMs,
  id,
  response,
  onCopyError,
  onCopySuccess,
  onExport,
  onExportError,
}: ResponseInspectorProps) {
  const parsed = useMemo(
    () => (response.body ? parseResponsesBody(response.body) : null),
    [response.body],
  )
  const [tab, setTab] = useState<InspectorTab>("output")
  const [selectedEvent, setSelectedEvent] = useState("0")
  const [wrap, setWrap] = useState(false)
  useEffect(() => {
    setTab("output")
    setSelectedEvent("0")
  }, [response.body, response.status])
  const selectedEventIndex = Number(selectedEvent)
  const event = parsed?.events[selectedEventIndex]
  const output = parsed ? describeResponseOutput(parsed) : null

  return (
    <VStack gap={3} className="response-inspector">
      <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
        <HStack gap={3} wrap="wrap" vAlign="center">
          <Text type="code">
            {response.status} {response.statusText}
          </Text>
          {durationMs === undefined ? null : (
            <Text type="supporting" color="secondary">
              {durationMs} ms
            </Text>
          )}
        </HStack>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Switch label="Wrap response" value={wrap} onChange={setWrap} />
          <ResponseExportMenu
            id={id}
            parsed={parsed}
            response={response}
            onError={onExportError}
            onExport={onExport}
          />
        </HStack>
      </HStack>

      <TabList
        value={tab}
        onChange={(value) => setTab(value as InspectorTab)}
        size="sm"
        hasDivider
        aria-label="Response view"
      >
        <Tab value="output" label="Output" />
        <Tab value="details" label="Details" />
        <Tab
          value="events"
          label={`Events (${parsed?.events.length ?? 0})`}
        />
        <Tab value="raw" label="Raw" />
      </TabList>

      {tab === "output" ?
        parsed ?
          <VStack gap={4} className="responses-pretty-view">
            {parsed.isPartial ?
              <Banner
                status="warning"
                title="Partial response capture"
                description="The response ended before a terminal event was captured."
              />
            : null}
            {parsed.assistantText ?
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
                  <Heading level={4}>Assistant output</Heading>
                  <Button
                    label="Copy output"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(parsed.assistantText)
                        .then(onCopySuccess)
                        .catch((error: unknown) =>
                          onCopyError(
                            error instanceof Error ? error.message : "Copy failed",
                          ),
                        )
                    }}
                  />
                </HStack>
                <div className="responses-output" tabIndex={0}>
                  <Markdown contentWidth="100%" headingLevelStart={5}>
                    {parsed.assistantText}
                  </Markdown>
                </div>
              </VStack>
            : output?.kind === "tool-only" ?
              <Banner
                status="info"
                title="Tool-only response"
                description={output.message}
              />
            : output?.kind === "error" ?
              <Banner
                status="error"
                title="Response error"
                description={output.message}
              />
            : <Text type="supporting" color="secondary">
                {output?.message}
              </Text>
            }
            {parsed.toolCalls.length > 0 ?
              <VStack gap={2}>
                <Heading level={4}>Tool calls</Heading>
                {parsed.toolCalls.map((toolCall, index) => (
                  <ToolCallViewer
                    key={toolCall.id ?? toolCall.callId ?? index}
                    index={index}
                    toolCall={toolCall}
                    wrap={wrap}
                    onCopyError={onCopyError}
                    onCopySuccess={onCopySuccess}
                  />
                ))}
              </VStack>
            : null}
            {parsed.reasoningText ?
              <Collapsible trigger="Reasoning summary" defaultIsOpen={false}>
                <VirtualizedCodeViewer
                  label="Reasoning summary"
                  language="text"
                  value={parsed.reasoningText}
                  wrap
                  onCopyError={onCopyError}
                  onCopySuccess={onCopySuccess}
                />
              </Collapsible>
            : null}
          </VStack>
        : <Text type="supporting" color="secondary">
            No supported structured response was recognized. Use Raw to inspect the exact body.
          </Text>
      : null}

      {tab === "details" ?
        <VStack gap={4}>
          {parsed ? <MetadataSection title="Response details" items={metadataItems(parsed)} /> : null}
          {parsed ? <MetadataSection title="Token usage" items={usageItems(parsed.usage)} /> : null}
          {parsed ? <MetadataSection title="Copilot usage" items={copilotUsageItems(parsed.copilotUsage)} /> : null}
          <MetadataSection
            title={`Response headers (${Object.keys(response.headers).length})`}
            items={Object.entries(response.headers).map(([label, value]) => ({ label, value }))}
          />
        </VStack>
      : null}

      {tab === "events" ?
        parsed && parsed.events.length > 0 ?
          <VStack gap={2}>
            <Selector
              label="Event"
              value={selectedEvent}
              options={parsed.events.map((item, index) => ({
                label: eventLabel(item, index),
                value: String(index),
              }))}
              onChange={setSelectedEvent}
            />
            {event ?
              <EventViewer
                event={event}
                index={selectedEventIndex}
                wrap={wrap}
                onCopyError={onCopyError}
                onCopySuccess={onCopySuccess}
              />
            : null}
          </VStack>
        : <Text type="supporting" color="secondary">
            No stream events were captured.
          </Text>
      : null}

      {tab === "raw" ?
        <VirtualizedCodeViewer
          label="Raw response body"
          language={parseJsonBody(response.body ?? "") ? "json" : "text"}
          value={response.body ?? ""}
          wrap={wrap}
          onCopyError={onCopyError}
          onCopySuccess={onCopySuccess}
        />
      : null}
    </VStack>
  )
}
```

- [ ] **Step 6: Add inspector layout styles**

Append to `ui/src/global.css`:

```css
.response-inspector,
.response-inspector > * {
  min-width: 0;
}

.response-inspector nav {
  overflow-x: auto;
}

.response-inspector .virtualized-code-viewer .code-document.is-read-only {
  height: min(50vh, 600px);
}
```

- [ ] **Step 7: Typecheck and test the component boundary**

Keep `ResponsesBodyViewer.tsx` active until Task 7 migrates its only consumer. Run:

```powershell
bun test tests/response-output.test.ts
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/lib/response-output.ts ui/src/components/ResponseInspector.tsx ui/src/components/ResponseExportMenu.tsx tests/response-output.test.ts
```

Expected: tests pass and all commands exit 0.

- [ ] **Step 8: Commit Task 6**

```powershell
git add ui/src/lib/response-output.ts ui/src/components/ResponseInspector.tsx ui/src/global.css tests/response-output.test.ts
git commit -m "feat: add shared LLM response inspector"
```

## Task 7: Migrate LLM Debug to local request controls and the shared inspector

**Files:**
- Modify: `ui/src/screens/LlmDebug.tsx`
- Delete: `ui/src/components/ResponsesBodyViewer.tsx`
- Modify: `ui/src/global.css`

- [ ] **Step 1: Replace Debug response parsing imports**

In `ui/src/screens/LlmDebug.tsx`:

- Remove `ResponsesBodyViewer` and `parseResponsesBody` imports.
- Import `ResponseInspector` and `VirtualizedCodeViewer`.
- Change `PayloadBlock` so it handles request bodies only. Its props become:

```ts
{
  body: string | null
  emptyText: string
  label: string
  onCopyError: (message: string) => void
  onCopySuccess: () => void
  viewMode: "pretty" | "raw"
  wrap: boolean
}
```

Remove the `kind` prop and `parsedResponse` memo.

- [ ] **Step 2: Use the virtualized raw request viewer**

Replace the raw `CodeBlock` branch in `PayloadBlock` with:

```tsx
content = (
  <VirtualizedCodeViewer
    label={label}
    language={parsed ? "json" : "text"}
    value={body}
    wrap={wrap}
    onCopyError={onCopyError}
    onCopySuccess={onCopySuccess}
  />
)
```

Keep `JsonTreeViewer` as the Pretty branch and continue using its bounded rendering from Task 2.

- [ ] **Step 3: Move format and wrap controls into the request card**

Rename `viewMode` state to `requestViewMode` and delete the page-wide controls at lines 633–646. Inside the Request card, immediately after `<Heading level={3}>Request</Heading>`, add:

```tsx
<HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
  <RequestExportMenu
    id={id}
    request={data.request}
    onError={toast.error}
    onExport={(format) => toast.success(`Exported ${format}`)}
  />
  <HStack gap={2} vAlign="center" wrap="wrap">
    <SegmentedControl
      label="Request body format"
      size="sm"
      value={requestViewMode}
      onChange={(value) =>
        setRequestViewMode(value as "pretty" | "raw")
      }
    >
      <SegmentedControlItem value="pretty" label="Pretty" />
      <SegmentedControlItem value="raw" label="Raw" />
    </SegmentedControl>
    <Switch label="Wrap request" value={wrap} onChange={setWrap} />
  </HStack>
</HStack>
```

Remove the page-level `RequestExportMenu` from the `Page.actions` block so there is one clearly located request export.

- [ ] **Step 4: Replace the response card with `ResponseInspector`**

Replace the response status/header/body block inside the Response card with:

```tsx
{data.response ?
  <ResponseInspector
    durationMs={data.durationMs}
    id={id}
    response={data.response}
    onCopyError={toast.error}
    onCopySuccess={() => toast.success("Copied")}
    onExport={(format) => toast.success(`Exported ${format}`)}
    onExportError={toast.error}
  />
: <Text type="supporting" color="secondary">
    {missingResponseText(data.status)}
  </Text>
}
```

Keep the `bodyReadError` banner after the inspector. The response inspector owns HTTP headers under `Details`, so remove the old response-header collapsible.

- [ ] **Step 5: Delete the old viewer and remove dead imports**

Delete `ui/src/components/ResponsesBodyViewer.tsx`. Remove any unused `CodeBlock`, `ResponsivePair`, `parseResponsesBody`, or header-related imports only if the file no longer uses them elsewhere. Keep `ResponsivePair` if the Request and Response cards still use it.

- [ ] **Step 6: Verify Debug compiles and is lint-clean**

```powershell
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/screens/LlmDebug.tsx ui/src/components/ResponseInspector.tsx
rg -n "ResponsesBodyViewer|Body format" ui/src
```

Expected: typecheck/lint exit 0; `rg` finds neither the deleted viewer nor the old page-wide label.

- [ ] **Step 7: Commit Task 7**

```powershell
git add ui/src/screens/LlmDebug.tsx ui/src/components/ResponseInspector.tsx ui/src/global.css
git rm ui/src/components/ResponsesBodyViewer.tsx
git commit -m "feat: improve LLM debug response inspection"
```

## Task 8: Redesign LLM Replay as the persistent split workspace

**Files:**
- Modify: `ui/src/screens/LlmReplay.tsx`
- Create: `ui/src/lib/replay-result.ts`
- Create: `tests/replay-result.test.ts`
- Modify: `ui/src/global.css`
- Modify: `tests/llm-debug-dashboard.test.ts`
- Modify: `src/routes/dashboard/page-generated.ts` (generated)

- [ ] **Step 1: Add failing replay-workspace bundle expectations**

Replace `dashboard bundle ships the LLM replay UI` in `tests/llm-debug-dashboard.test.ts` with:

```ts
test("dashboard bundle ships the LLM replay workspace", () => {
  expect(DASHBOARD_HTML).toContain("LLM Replay")
  expect(DASHBOARD_HTML).toContain("Request JSON")
  expect(DASHBOARD_HTML).toContain("Format JSON")
  expect(DASHBOARD_HTML).toContain("Reset request")
  expect(DASHBOARD_HTML).toContain("Run Replay")
  expect(DASHBOARD_HTML).toContain("Replay result")
  expect(DASHBOARD_HTML).toContain("Last successful result")
  expect(DASHBOARD_HTML).toContain("replay-workspace")
  expect(DASHBOARD_HTML).toContain("Export request")
  expect(DASHBOARD_HTML).toContain("Export response")
})
```

Run:

```powershell
bun test tests/llm-debug-dashboard.test.ts
```

Expected: FAIL against the old generated dashboard.

- [ ] **Step 2: Write failing replay-result classification tests**

Create `tests/replay-result.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { classifyReplayResult } from "../ui/src/lib/replay-result"

describe("replay result classification", () => {
  test("accepts upstream 2xx responses", () => {
    expect(classifyReplayResult({ status: 200, statusText: "OK" })).toEqual({
      ok: true,
    })
  })

  test("keeps upstream errors out of successful result state", () => {
    expect(
      classifyReplayResult({ status: 400, statusText: "Bad Request" }),
    ).toEqual({
      message: "Replay returned 400 Bad Request",
      ok: false,
    })
  })
})
```

Run:

```powershell
bun test tests/replay-result.test.ts
```

Expected: FAIL because `ui/src/lib/replay-result.ts` does not exist.

- [ ] **Step 3: Implement replay-result classification and keep the API contract**

Create `ui/src/lib/replay-result.ts`:

```ts
export type ReplayResultStatus =
  | { ok: true }
  | { message: string; ok: false }

export function classifyReplayResult(result: {
  status: number
  statusText: string
}): ReplayResultStatus {
  if (result.status >= 200 && result.status < 300) return { ok: true }
  const suffix = result.statusText ? ` ${result.statusText}` : ""
  return {
    message: `Replay returned ${result.status}${suffix}`,
    ok: false,
  }
}
```

Keep `ReplayResult` in `ui/src/lib/types.ts` structurally compatible with the
existing server payload. The screen will use `body`, `durationMs`, `headers`,
`status`, and `statusText`; retain `finishReason`, `parsed`, `responseId`,
`streamEvents`, and `usage` because the backend still returns them and existing
callers/tests may inspect them. Add this adapter in `LlmReplay.tsx` rather than
changing the endpoint:

Keep `ReplayResult` in `ui/src/lib/types.ts` structurally compatible with the existing server payload. The screen will use `body`, `durationMs`, `headers`, `status`, and `statusText`; retain `finishReason`, `parsed`, `responseId`, `streamEvents`, and `usage` because the backend still returns them and existing callers/tests may inspect them. Add this adapter in `LlmReplay.tsx` rather than changing the endpoint:

```ts
function replayResponse(result: ReplayResult) {
  return {
    body: result.body,
    headers: result.headers,
    status: result.status,
    statusText: result.statusText,
  }
}
```

- [ ] **Step 4: Replace Replay imports and state**

In `LlmReplay.tsx`:

- Remove `CodeBlock`, `List`, `ListItem`, `Section`, `TextArea`, and the old status helper imports.
- Add `Card`, `Heading`, `Switch`, `useDeferredValue`, `useEffect`, `useMemo`, `useRef`, `useState`.
- Import `ConfirmButton`, `JsonCodeEditor`, `ResponseInspector`, `RequestExportMenu`, `CodeMirrorDocumentHandle`, `formatJsonDocument`, `prepareReplayDocument`, and `validateReplayDocument`.
- Import `classifyReplayResult` from `../lib/replay-result`.

Use this state:

```tsx
  const [body, setBody] = useState("")
const [originalBody, setOriginalBody] = useState("")
const [isRunning, setIsRunning] = useState(false)
const [result, setResult] = useState<ReplayResult>()
const [replayError, setReplayError] = useState<string>()
const [wrap, setWrap] = useState(false)
const deferredBody = useDeferredValue(body)
const deferredValidation = useMemo(
  () => validateReplayDocument(deferredBody),
  [deferredBody],
)
const validationPending = deferredBody !== body
const editorDiagnostic =
  validationPending || deferredValidation.ok ?
    null
  : deferredValidation.diagnostic
const canRun = !validationPending && deferredValidation.ok && !isRunning
const editorRef = useRef<CodeMirrorDocumentHandle>(null)
const isDirty = body !== originalBody
```

Initialize captured data exactly once per source body:

```tsx
useEffect(() => {
  if (!data) return
  const capturedBody = prepareReplayDocument(data.request.body ?? "")
  setBody(capturedBody)
  setOriginalBody(capturedBody)
  setResult(undefined)
  setReplayError(undefined)
}, [data])
```

- [ ] **Step 5: Add format, reset, copy, and guarded replay handlers**

```tsx
function formatBody() {
  const formatted = formatJsonDocument(body)
  if (formatted === null) {
    toast.error("Fix the JSON error before formatting.")
    return
  }
  setBody(formatted)
  requestAnimationFrame(() => editorRef.current?.focus())
}

function resetBody() {
  setBody(originalBody)
  setReplayError(undefined)
  requestAnimationFrame(() => editorRef.current?.focus())
}

async function copyBody() {
  try {
    await navigator.clipboard.writeText(body)
    toast.success("Copied")
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Copy failed")
  }
}

async function runReplay() {
  const currentValidation = validateReplayDocument(body)
  if (!currentValidation.ok) {
    setReplayError(currentValidation.diagnostic.message)
    editorRef.current?.focus()
    return
  }

  setIsRunning(true)
  setReplayError(undefined)
  try {
    const replayResult = await post<ReplayResult>(
      `/dashboard/api/llm-debug/${id}/replay`,
      { body },
    )
    const status = classifyReplayResult(replayResult)
    if (!status.ok) {
      setReplayError(status.message)
      return
    }
    setResult(replayResult)
  } catch (caught) {
    setReplayError(
      caught instanceof ApiError ? caught.message : "Replay request failed",
    )
  } finally {
    setIsRunning(false)
    requestAnimationFrame(() => editorRef.current?.focus())
  }
}
```

- [ ] **Step 6: Render the persistent split workspace**

Replace the current `data ?` body with:

```tsx
{data ?
  <VStack gap={3}>
    <HStack hAlign="between" vAlign="center" gap={3} wrap="wrap">
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Badge variant="neutral" label={data.request.method} />
        <MonoText>{data.request.path}</MonoText>
      </HStack>
      <Button
        label="Run Replay"
        variant="primary"
        icon={<PlayIcon />}
        isLoading={isRunning}
        isDisabled={!canRun}
        tooltip={
          validationPending ?
            "Validating request JSON…"
          : deferredValidation.ok ?
            undefined
          : deferredValidation.diagnostic.message
        }
        onClick={() => void runReplay()}
      />
    </HStack>

    <div className="replay-workspace">
      <Card className="replay-pane" padding={3}>
        <VStack gap={2}>
          <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
            <Heading level={3}>Request JSON</Heading>
            <HStack gap={1} wrap="wrap" vAlign="center">
              <RequestExportMenu
                body={body}
                id={id}
                isJsonValid={!validationPending && deferredValidation.ok}
                request={data.request}
                onError={toast.error}
                onExport={(format) => toast.success(`Exported ${format}`)}
              />
              <Button
                label="Format JSON"
                variant="ghost"
                size="sm"
                isDisabled={validationPending || !deferredValidation.ok}
                onClick={formatBody}
              />
              <Button
                label="Copy request"
                variant="ghost"
                size="sm"
                onClick={() => void copyBody()}
              />
              <ConfirmButton
                label="Reset request"
                confirmTitle="Reset request JSON?"
                confirmDescription="This replaces your edits with the originally captured request body."
                confirmActionLabel="Reset"
                variant="secondary"
                size="sm"
                isDisabled={!isDirty}
                onConfirm={resetBody}
              />
              <Switch label="Wrap request" value={wrap} onChange={setWrap} />
            </HStack>
          </HStack>
          <JsonCodeEditor
            ref={editorRef}
            diagnostic={editorDiagnostic}
            label="Request JSON editor"
            value={body}
            wrap={wrap}
            onChange={setBody}
          />
        </VStack>
      </Card>

      <Card className="replay-pane" padding={3}>
        <VStack gap={2}>
          <HStack hAlign="between" vAlign="center" gap={2} wrap="wrap">
            <Heading level={3}>Replay result</Heading>
            {replayError && result ?
              <Text type="supporting" color="secondary">
                Last successful result
              </Text>
            : null}
          </HStack>
          {replayError ?
            <Banner
              status="error"
              title="Replay failed"
              description={replayError}
            />
          : null}
          {result ?
            <ResponseInspector
              durationMs={result.durationMs}
              id={`${id}-replay`}
              response={replayResponse(result)}
              onCopyError={toast.error}
              onCopySuccess={() => toast.success("Copied")}
              onExport={(format) => toast.success(`Exported ${format}`)}
              onExportError={toast.error}
            />
          : replayError ? null : (
            <EmptyState
              icon={<PlayIcon />}
              title="Ready to replay"
              description="Edit the request JSON, then run the replay. The assembled output will appear here."
            />
          )}
        </VStack>
      </Card>
    </div>
  </VStack>
: null}
```

- [ ] **Step 7: Add responsive split-workspace styles**

Append to `ui/src/global.css`:

```css
.replay-workspace {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  gap: var(--spacing-4);
  align-items: start;
}

.replay-pane,
.replay-pane > * {
  min-width: 0;
}

.replay-pane {
  max-height: calc(100vh - 180px);
  overflow: auto;
}

.replay-pane .code-document.is-editable {
  height: calc(100vh - 290px);
  min-height: 420px;
}

@media (max-width: 960px) {
  .replay-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .replay-pane {
    max-height: none;
  }

  .replay-pane .code-document.is-editable {
    height: min(65vh, 720px);
  }
}
```

- [ ] **Step 8: Typecheck and lint the completed source UI**

```powershell
cd ui
npm run typecheck
cd ..
bun run lint -- ui/src/lib ui/src/components ui/src/screens/LlmDebug.tsx ui/src/screens/LlmReplay.tsx tests/json-document.test.ts tests/code-mirror-document.test.ts tests/json-tree.test.ts tests/responses-body.test.ts tests/http-export.test.ts tests/response-output.test.ts tests/replay-result.test.ts tests/llm-debug-dashboard.test.ts
```

Expected: exit 0.

- [ ] **Step 9: Build the UI and regenerate the dashboard bundle**

```powershell
bun run build:ui
```

Expected: Vite exits 0 and `src/routes/dashboard/page-generated.ts` changes.

- [ ] **Step 10: Run the focused suites and confirm GREEN**

```powershell
bun test tests/json-document.test.ts tests/code-mirror-document.test.ts tests/json-tree.test.ts tests/responses-body.test.ts tests/http-export.test.ts tests/response-output.test.ts tests/replay-result.test.ts tests/llm-debug-dashboard.test.ts
```

Expected: 0 failures, including the generated-bundle expectations from Task 8.

- [ ] **Step 11: Syntax-check the generated inline module**

Run this PowerShell command from the repo root:

```powershell
@'
import { DASHBOARD_HTML } from "./src/routes/dashboard/page-generated"

const match = DASHBOARD_HTML.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)
if (!match) throw new Error("Generated dashboard module script not found")
new Function(match[1])
console.log("dashboard inline module parses")
'@ | bun -
```

Expected: `dashboard inline module parses` and exit 0.

- [ ] **Step 12: Commit Task 8**

```powershell
git add ui/src/screens/LlmReplay.tsx ui/src/lib/replay-result.ts ui/src/global.css tests/replay-result.test.ts tests/llm-debug-dashboard.test.ts src/routes/dashboard/page-generated.ts
git commit -m "feat: redesign the LLM replay workspace"
```

## Task 9: Full verification and browser QA with production-sized fixtures

**Files:**
- Modify only if verification exposes a defect in the preceding task files.

- [ ] **Step 1: Run all unit and dashboard regression tests**

```powershell
bun test
```

Expected: 0 failures. If an unrelated live integration test fails, capture the exact failing test and output, run the complete local non-live suite plus every focused suite above, and do not claim the full suite passed.

- [ ] **Step 2: Run final static verification**

```powershell
bun run lint:all
bun run typecheck
cd ui
npm run typecheck
cd ..
bun run build:ui
bun run build
```

Expected: every command exits 0 and the final `build:ui` produces no uncommitted generated diff beyond the committed bundle.

- [ ] **Step 3: Verify no stale presentation path remains**

```powershell
rg -n "ResponsesBodyViewer|The response did not contain assistant text|ListItem.*streamEvent|label=\"Body format\"" ui/src
```

Expected: no matches.

- [ ] **Step 4: Create fresh large and tool-only fixture records in a local verification process**

Create a temporary script outside the repository, for example `$env:TEMP\llm-debug-fixtures.ts`, containing:

```ts
import { finishLlmDebugLog, startLlmDebugLog } from "F:/Projects/copilot-api/src/lib/llm-debug-log"
import { server } from "F:/Projects/copilot-api/src/server"

import { setAdminAuthTestMode } from "F:/Projects/copilot-api/src/lib/admin-auth"
import { state } from "F:/Projects/copilot-api/src/lib/state"

const LOCAL_GATEWAY_KEY = "local-dashboard-gateway-key-with-enough-entropy"
const LOCAL_ADMIN_PASSWORD = "local dashboard verification password"
process.env.COPILOT_ADMIN_ORIGIN = "http://127.0.0.1:4173"
setAdminAuthTestMode(true)
state.apiKeyAuth = LOCAL_GATEWAY_KEY
state.accountType = "individual"
state.copilotToken = "local-fixture-token"

const originalFetch = globalThis.fetch
let replayShouldFail = false
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.toString()
  if (!url.startsWith("https://api.githubcopilot.com/")) {
    return await originalFetch(input, init)
  }
  if (replayShouldFail) {
    replayShouldFail = false
    return new Response(JSON.stringify({ error: { message: "Fixture replay failed" } }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    })
  }
  replayShouldFail = true
  return new Response(
    [
      "event: response.output_text.done",
      `data: ${JSON.stringify({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "Fixture replay succeeded", sequence_number: 1 })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "resp_replay", object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Fixture replay succeeded" }] }] } })}`,
      "",
    ].join("\n"),
    {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
    },
  )
}

const repeated = Array.from({ length: 6_000 }, (_, index) => ({
  role: "user",
  content: `fixture-${index}-${"x".repeat(240)}`,
}))
const requestBody = JSON.stringify({
  model: "gpt-5.6-sol",
  stream: true,
  input: repeated,
})
const completed = {
  id: "resp_fixture",
  object: "response",
  status: "completed",
  output: [
    {
      id: "fc_fixture",
      call_id: "call_fixture",
      type: "function_call",
      name: "lookup",
      arguments: '{"id":7}',
    },
  ],
  usage: { input_tokens: 144134, output_tokens: 169, total_tokens: 144303 },
}
const events = Array.from({ length: 120 }, (_, sequence) =>
  [
    "event: response.output_item.added",
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      sequence_number: sequence,
      output_index: 0,
      item: sequence === 0 ? completed.output[0] : { type: "reasoning", id: `r_${sequence}` },
    })}`,
    "",
  ].join("\n"),
)
events.push(
  [
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", sequence_number: 120, response: completed })}`,
    "",
  ].join("\n"),
)

const id = startLlmDebugLog({
  method: "POST",
  path: "/responses",
  requestBody,
  requestHeaders: { "content-type": "application/json" },
  requestId: "fixture-large",
  url: "https://example.test/responses",
})
finishLlmDebugLog(id, {
  body: events.join("\n"),
  headers: { "content-type": "text/event-stream" },
  status: 200,
  statusText: "OK",
})

console.log(`http://127.0.0.1:4173/dashboard#llm-debug:${id}`)
Bun.serve({ hostname: "127.0.0.1", port: 4173, fetch: server.fetch })
```

Run the script with `bun $env:TEMP\llm-debug-fixtures.ts`. On first load,
create the local administrator with gateway key
`local-dashboard-gateway-key-with-enough-entropy` and password
`local dashboard verification password`. These credentials exist only in the
in-memory disposable verification process. The script is a QA fixture, not a
repository file or production route.

Expected: it prints a fresh Debug URL whose request body is roughly 2 MB, response has at least 100 events, and final output is tool-only.

- [ ] **Step 5: Browser-verify LLM Debug**

Using the fresh local URL:

1. Sign in through the local dashboard session.
2. Confirm the request card defaults to Pretty and never produces page-level horizontal scrolling.
3. Switch request Pretty → Raw → Pretty while recording elapsed interaction time; each switch must remain usable and must not lock input for seconds.
4. Confirm the response opens on `Output` and states `The model returned 1 tool call and no assistant message.`
5. Expand the tool call and verify `lookup`, `call_fixture`, and formatted `{ "id": 7 }` arguments.
6. Select `Events (121)` and inspect event 1 and the final event; only the selected event payload should be mounted.
7. Select `Raw`, use search, toggle wrapping, and return to Output.
8. Exercise `Export request` and `Export response`; inspect JSON, Markdown, and raw HTTP downloads.

Record the observed Pretty/Raw switch durations in the handoff. There is no machine-dependent CI threshold, but any multi-second freeze is a defect and must be fixed before completion.

- [ ] **Step 6: Browser-verify LLM Replay**

From the same record, click Replay and verify:

1. Desktop shows the persistent split workspace; a viewport narrower than 960 px stacks the panes.
2. Request JSON is formatted, line-numbered, syntax highlighted, and editable.
3. Introduce malformed JSON; the editor shows a line/column diagnostic and Run Replay is disabled.
4. Restore valid JSON with no model; the editor shows `model is required.`
5. Use Reset and confirm the original formatted body returns.
6. Use Format and verify focus remains in the editor.
7. Run Replay once; the fixture intercepts Copilot fetch and returns `Fixture replay succeeded`. Confirm Output becomes the selected result tab.
8. Run Replay a second time; the fixture returns HTTP 400 `Fixture replay failed`. Confirm the prior response remains labeled `Last successful result`.
9. Verify replay-side request/response exports use the edited request and current result.

- [ ] **Step 7: Re-run verification after any QA fix**

If browser QA finds a defect, write a failing focused test where deterministic, apply the smallest fix, and rerun:

```powershell
bun test tests/json-document.test.ts tests/code-mirror-document.test.ts tests/json-tree.test.ts tests/responses-body.test.ts tests/http-export.test.ts tests/response-output.test.ts tests/replay-result.test.ts tests/llm-debug-dashboard.test.ts
cd ui
npm run typecheck
cd ..
bun run lint:all
bun run build:ui
bun run build
```

- [ ] **Step 8: Confirm the final working tree and generated bundle**

```powershell
git status --short --branch
git diff --check
git diff -- src/routes/dashboard/page-generated.ts
```

Expected: no unstaged product changes, no whitespace errors, and no generated UI diff. The existing `.superpowers/` visual-companion directory may remain untracked and must not be committed.

- [ ] **Step 9: Commit any final QA correction**

If no correction was required, skip this commit. Otherwise replace the example
paths below with the specific files changed by the correction and stage only
those files:

```powershell
git add ui/src/components/ResponseInspector.tsx tests/response-output.test.ts
git commit -m "fix: finalize LLM replay and debug UX"
```

## Completion checklist

- [ ] Request JSON editor is the canonical replay input and validates object/model requirements.
- [ ] LLM Replay uses the approved persistent split workspace and responsive stacking.
- [ ] Debug request Pretty/Raw state is local and no longer rebuilds the response.
- [ ] Response Output reconstructs text, tool calls, refusals, errors, and partial captures.
- [ ] Tool-only output is useful and never claims the response contained nothing.
- [ ] Reasoning remains separate from assistant output and exports.
- [ ] Event inspection mounts and formats only the selected event.
- [ ] Request and response export menus exist in both Debug and Replay.
- [ ] Raw HTTP response includes status, headers, CRLF separator, and exact body.
- [ ] CodeMirror virtualizes editable/read-only large documents.
- [ ] JSON trees page children in groups of 100 and disable recursive expansion for large documents.
- [ ] Focused tests, full tests, lint, typechecks, UI build, server build, generated-script syntax check, and browser QA have fresh evidence.
- [ ] `src/routes/dashboard/page-generated.ts` was regenerated, not hand-edited.
