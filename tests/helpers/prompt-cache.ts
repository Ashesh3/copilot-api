/** A copy without prompt-cache markers, for checks of a request's shape. */
export function withoutPromptCache<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, entry: unknown) =>
      key === "cache_control" ? undefined : entry,
    ),
  ) as T
}

/** The instruction text of a Messages request, given as a string or blocks. */
export function systemText(system: unknown): unknown {
  if (!Array.isArray(system)) return system
  return system
    .map((block: unknown) =>
      typeof block === "object" && block !== null && "text" in block ?
        block.text
      : "",
    )
    .join("\n\n")
}
