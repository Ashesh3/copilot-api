import type { ResponsesPayload } from "~/services/copilot/create-responses"

// Codex output-token replay requests ciphertext on output items and replays it
// on later turns. Some Copilot endpoints reject this include value, and Copilot
// cannot decrypt replayed output ciphertext that the serving endpoint did not
// issue.
const OUTPUT_ENCRYPTED_CONTENT_INCLUDE = "output.encrypted_content"

// Codex clears ciphertext from these items for providers without replay.
// Reasoning and compaction ciphertext remain part of the Copilot contract.
const OUTPUT_REPLAY_ITEM_TYPES: ReadonlySet<unknown> = new Set([
  "message",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
  "web_search_call",
  "image_generation_call",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function itemType(item: Record<string, unknown>): unknown {
  return item.type === undefined && typeof item.role === "string" ?
      "message"
    : item.type
}

/** Mutates only the owned Copilot wire body, preserving caller and replay state. */
export function omitOutputTokenReplay(body: ResponsesPayload): void {
  const include: unknown = body.include
  if (Array.isArray(include)) {
    const retained = (include as Array<unknown>).filter(
      (value) => value !== OUTPUT_ENCRYPTED_CONTENT_INCLUDE,
    )
    if (retained.length !== include.length) {
      body.include = retained as NonNullable<ResponsesPayload["include"]>
    }
  }

  if (!Array.isArray(body.input)) return
  for (const item of body.input as Array<unknown>) {
    if (!isRecord(item) || !OUTPUT_REPLAY_ITEM_TYPES.has(itemType(item))) {
      continue
    }
    // The plaintext item still carries the conversation state.
    Reflect.deleteProperty(item, "encrypted_content")
  }
}
