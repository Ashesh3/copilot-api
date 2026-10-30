import { withoutPromptCache } from "./prompt-cache"

/**
 * A Messages conversation as the model reads it: Messages joins consecutive
 * turns of one role into a single turn. Prompt-cache markers are dropped.
 */
export function mergeTurns(
  messages: unknown,
): Array<{ role: unknown; content: Array<unknown> }> {
  const merged: Array<{ role: unknown; content: Array<unknown> }> = []
  for (const message of withoutPromptCache(messages) as Array<
    Record<string, unknown>
  >) {
    const content =
      typeof message.content === "string" ?
        [{ type: "text", text: message.content }]
      : (message.content as Array<unknown>)
    const previous = merged.at(-1)
    if (previous && previous.role === message.role)
      previous.content.push(...content)
    else merged.push({ role: message.role, content: [...content] })
  }
  return merged
}
