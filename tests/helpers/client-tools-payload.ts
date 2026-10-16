/** Compare existing client tool contracts independently of the separately tested defaults. */
export function clientToolsPayload<T extends Record<string, unknown>>(
  payload: T,
): T {
  if (!Array.isArray(payload.tools)) return payload
  const tools = payload.tools.filter((tool: unknown) => {
    if (typeof tool !== "object" || tool === null) return true
    const record = tool as Record<string, unknown>
    const definition =
      typeof record.function === "object" && record.function !== null ?
        (record.function as Record<string, unknown>)
      : record
    return (
      typeof definition.name !== "string"
      || !definition.name.startsWith("_copilot_web_")
    )
  })
  const result = { ...payload, tools }
  if (tools.length === 0 && payload.tools.length > 0)
    delete (result as Record<string, unknown>).tools
  return result
}
