# Responses ChatCompletions Fallback - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `/v1/responses` endpoint work with ALL models by falling back to ChatCompletions when a model doesn't natively support `/responses`.

**Architecture:** When the responses handler detects a model without `/responses` support, it translates the Responses payload to ChatCompletions format, calls `createChatCompletions`, then translates the response back to Responses format. This mirrors the pattern already used in the Google AI handler.

**Tech Stack:** TypeScript, Hono, existing `createChatCompletions` service, existing Responses/ChatCompletions types.

---

### Task 1: Replace hard rejection with routing logic

**Files:**
- Modify: `src/routes/responses/handler.ts:106-123`

**Step 1: Replace the hard-reject block with routing logic**

Replace the current `if (!supportsResponses) { return c.json(...400) }` block with:

```typescript
if (!supportsResponses) {
  consola.debug(
    `[responses] Model ${payload.model} does not support /responses, falling back to ChatCompletions`,
  )
  setRequestContext(c, { provider: "Responses→ChatCompletions" })
  return handleWithChatCompletions(c, payload)
}
```

The `handleWithChatCompletions` function will be created in Task 2.

**Step 2: Add the `consola` import**

Add `import consola from "consola"` at the top of the file.

**Step 3: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "refactor: replace hard rejection with fallback routing in responses handler"
```

---

### Task 2: Implement Responses→ChatCompletions request translation

**Files:**
- Modify: `src/routes/responses/handler.ts` (add new functions at bottom)

**Step 1: Add imports for ChatCompletions types**

```typescript
import {
  createChatCompletions,
  type ChatCompletionsPayload,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type Message,
} from "~/services/copilot/create-chat-completions"
```

**Step 2: Write `responsesToChatCompletions` translation function**

This function converts a `ResponsesPayload` into a `ChatCompletionsPayload`:

- `instructions` → system message (first in messages array)
- Walk `input[]` items:
  - `type: "message"` with `role: "user"` → `{ role: "user", content: string }`
  - `type: "message"` with `role: "assistant"` → `{ role: "assistant", content: string }`
  - `type: "message"` with `role: "system"` or `"developer"` → `{ role: "system", content: string }`
  - `type: "function_call"` → collect into pending tool_calls, flush when next non-function_call item seen as assistant message with `tool_calls` array
  - `type: "function_call_output"` → `{ role: "tool", tool_call_id: call_id, content: output }`
  - `type: "reasoning"` → skip (not representable in ChatCompletions)
- `tools[]` (FunctionTool) → `tools[]` with `{ type: "function", function: { name, description, parameters } }`
- `tool_choice` → pass through (same format)
- `max_output_tokens` → `max_tokens`
- `temperature`, `top_p` → pass through
- `stream` → `stream`
- If `stream` is true, add `stream_options: { include_usage: true }`

Key detail for `function_call` items: consecutive `function_call` items should be grouped into a single assistant message with multiple `tool_calls`. If there's preceding text content from an assistant message, that message gets the tool_calls attached.

**Step 3: Write `convertResponsesTools` function**

```typescript
function convertResponsesTools(
  tools: ResponsesPayload["tools"],
): ChatCompletionsPayload["tools"] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter((t): t is FunctionTool => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? undefined,
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }))
}
```

**Step 4: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "feat: add Responses to ChatCompletions request translation"
```

---

### Task 3: Implement ChatCompletions→Responses non-streaming response translation

**Files:**
- Modify: `src/routes/responses/handler.ts`

**Step 1: Write `chatCompletionToResponsesResult` function**

Convert a `ChatCompletionResponse` to a `ResponsesResult`:

```typescript
function chatCompletionToResponsesResult(
  cc: ChatCompletionResponse,
  model: string,
): ResponsesResult {
  const output: ResponseOutputItem[] = []
  const choice = cc.choices[0]

  // Text content → ResponseOutputMessage
  if (choice?.message?.content) {
    output.push({
      id: `msg_${cc.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: choice.message.content,
        annotations: [],
      }],
    })
  }

  // Tool calls → ResponseOutputFunctionCall items
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${tc.id}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      })
    }
  }

  const finishReason = choice?.finish_reason
  const status = finishReason === "length" ? "incomplete" : "completed"

  return {
    id: `resp_${cc.id}`,
    object: "response",
    created_at: cc.created,
    model,
    output,
    output_text: choice?.message?.content ?? "",
    status,
    usage: cc.usage ? {
      input_tokens: cc.usage.prompt_tokens,
      output_tokens: cc.usage.completion_tokens,
      total_tokens: cc.usage.total_tokens,
      input_tokens_details: cc.usage.prompt_tokens_details ? {
        cached_tokens: cc.usage.prompt_tokens_details.cached_tokens,
      } : undefined,
    } : null,
    error: null,
    incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}
```

**Step 2: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "feat: add ChatCompletions to Responses non-streaming response translation"
```

---

### Task 4: Implement streaming response translation

**Files:**
- Modify: `src/routes/responses/handler.ts`

**Step 1: Write `streamChatCompletionsAsResponses` function**

This handles the streaming case. It consumes ChatCompletion chunks and emits Responses-format SSE events.

Stream state tracking needed:
- `sequenceNumber`: incrementing counter
- `responseId`: generated once at start (e.g. `resp_<uuid>`)
- `outputIndex`: current output item index
- `textItemId`: ID for the text output message item
- `functionCalls`: map of tool call index → accumulated function call data
- `fullText`: accumulated text for the final `response.completed` event
- `model`: the model name

Events to emit:
1. `response.created` — first, with empty response skeleton
2. `response.output_item.added` — when text content or function call starts
3. `response.output_text.delta` — for each text delta
4. `response.function_call_arguments.delta` — for each function arg delta
5. `response.output_text.done` — when text is complete
6. `response.function_call_arguments.done` — when function call is complete
7. `response.output_item.done` — when an output item is complete
8. `response.completed` — final event with full response

For each `ChatCompletionChunk`:
- If `delta.content` is present → emit `response.output_text.delta`
- If `delta.tool_calls` is present → emit `response.function_call_arguments.delta`
- If `finish_reason` is present → emit done/completed events
- If `usage` is present → capture for the completed event

**Step 2: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "feat: add ChatCompletions to Responses streaming translation"
```

---

### Task 5: Wire up `handleWithChatCompletions` function

**Files:**
- Modify: `src/routes/responses/handler.ts`

**Step 1: Write the `handleWithChatCompletions` function**

```typescript
async function handleWithChatCompletions(
  c: Context,
  payload: ResponsesPayload,
): Promise<Response> {
  const ccPayload = responsesToChatCompletions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(ccPayload)

  // Non-streaming
  if (!payload.stream || !isAsyncIterable(response)) {
    const result = chatCompletionToResponsesResult(
      response as ChatCompletionResponse,
      payload.model,
    )
    if (result.usage) {
      setRequestContext(c, {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      })
    }
    return c.json(result)
  }

  // Streaming
  return streamSSE(c, async (stream) => {
    await streamChatCompletionsAsResponses(stream, response, payload.model, c)
  })
}
```

**Step 2: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "feat: wire up handleWithChatCompletions in responses handler"
```

---

### Task 6: Build, test, and verify

**Step 1: Build**

```bash
npm run build
```

Expected: No errors.

**Step 2: Start server and test with gpt-4.1 non-streaming**

```bash
curl -s -X POST http://localhost:4141/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","input":"Say hi","stream":false}'
```

Expected: 200 response with Responses format JSON (not 400 error).

**Step 3: Test with gpt-4.1 streaming**

```bash
curl -s -X POST http://localhost:4141/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","input":"Say hi","stream":true}'
```

Expected: SSE stream with `response.created`, `response.output_text.delta`, `response.completed` events.

**Step 4: Test with a model that supports /responses natively (e.g. gpt-5.2-codex)**

```bash
curl -s -X POST http://localhost:4141/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2-codex","input":"Say hi","stream":false}'
```

Expected: 200 response via native Responses API (existing behavior preserved).

**Step 5: Test with tools**

```bash
curl -s -X POST http://localhost:4141/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","input":"What is 2+2?","stream":false,"tools":[{"type":"function","name":"calc","description":"Calculate","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}]}'
```

Expected: 200 with either text response or function_call output item.

**Step 6: Commit final**

```bash
git add -A
git commit -m "feat: add ChatCompletions fallback for /v1/responses endpoint"
```
