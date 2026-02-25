# Responses API ChatCompletions Fallback

## Problem

The `/v1/responses` handler hard-rejects models that don't have `/responses` in their `supported_endpoints`. This breaks clients (e.g. Graphiti, OpenAI SDK) that use the Responses API with older models like `gpt-4.1`, `gpt-4o`, or any model that only supports `/chat/completions`.

Copilot's model endpoint support:

| Models | Endpoints |
|---|---|
| `gpt-4.1`, `gpt-4o`, `gpt-4` | none listed |
| `gemini-*` | `/chat/completions` only |
| `claude-*` | `/v1/messages`, `/chat/completions` |
| `gpt-5-mini`, `gpt-5.1`, `gpt-5.2` | `/chat/completions`, `/responses` |
| `gpt-5.x-codex` | `/responses` only |

## Solution

Add a ChatCompletions fallback in the responses handler. When a model doesn't support `/responses`, translate the Responses payload to ChatCompletions format, call `createChatCompletions`, and translate the response back.

## Flow

```
Client -> POST /v1/responses
  |-- Model supports /responses? -> Forward to Copilot Responses API (existing)
  |-- Model doesn't support /responses?
       |-- Convert Responses payload -> ChatCompletions payload
       |-- Call createChatCompletions()
       |-- Convert ChatCompletions response -> Responses format
```

## Translation

### Request (Responses -> ChatCompletions)

- `instructions` -> system message
- `input[]` message items -> `messages[]` (user/assistant roles)
- `input[]` function_call items -> assistant messages with `tool_calls`
- `input[]` function_call_output items -> tool role messages
- `tools[]` -> `tools[]` (same OpenAI format)
- `tool_choice` -> `tool_choice` (pass through)
- `max_output_tokens` -> `max_tokens`
- `temperature`, `top_p` -> pass through
- `stream` -> `stream`

### Response (ChatCompletions -> Responses)

- Non-streaming: Synthesize `ResponsesResult` from ChatCompletion (map `choices[0].message` to `output[]` items)
- Streaming: Map `chat.completion.chunk` events to Responses stream events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`)

### Edge Cases

- Structured output (`text.format.type: "json_schema"`) -> `response_format` in ChatCompletions
- Tool calls -> bidirectional mapping
- Token usage -> map `prompt_tokens`/`completion_tokens` to `input_tokens`/`output_tokens`

## Files Modified

- `src/routes/responses/handler.ts` - Add fallback function and translation helpers
