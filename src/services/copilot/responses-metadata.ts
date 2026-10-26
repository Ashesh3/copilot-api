import type { ResponsesPayload } from "~/services/copilot/create-responses"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Mutates only the owned Copilot wire body, preserving caller and replay state. */
export function stripUnsupportedResponsesInputMetadata(
  body: ResponsesPayload,
): void {
  if (!Array.isArray(body.input)) return

  for (const item of body.input) {
    if (!isRecord(item)) continue
    const metadata = item.internal_chat_message_metadata_passthrough
    if (!isRecord(metadata)) continue

    // Copilot rejects this Codex provenance field. Keep turn_id and other
    // metadata used to preserve current-turn context during payload recovery.
    Reflect.deleteProperty(metadata, "content_item_metadata")
  }
}
