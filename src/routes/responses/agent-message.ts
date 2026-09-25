import type { TranslationFinding } from "~/lib/endpoint-routing"

/**
 * Translate only at a fallback boundary: native Responses and initiator/routing
 * detection must retain the original agent item. Codex's text already includes
 * its task/sender envelope, so internal IDs do not belong in the model prompt.
 */
export function normalizeResponsesAgentMessage(
  item: Record<string, unknown>,
  findings: Array<TranslationFinding>,
): Record<string, unknown> | undefined {
  if (item.type !== "agent_message") return item

  if (
    Array.isArray(item.content)
    && item.content.some(
      (part: unknown) =>
        typeof part === "object"
        && part !== null
        && "type" in part
        && part.type === "encrypted_content",
    )
  ) {
    // A readable prefix is not a replacement for an encrypted task. Reject
    // this candidate, not the native request, and never serialize ciphertext.
    if (
      !findings.some(
        (finding) =>
          finding.class === "content_part" && finding.severity === "fatal",
      )
    ) {
      findings.push({ class: "content_part", severity: "fatal" })
    }
    return undefined
  }

  return { type: "message", role: "user", content: item.content }
}
